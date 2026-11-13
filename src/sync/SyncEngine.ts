import { Notice, Platform, TFile, TFolder, type TAbstractFile } from "obsidian";
import {
  FOLDER_MARKER_FILENAME,
  HISTORY_EDIT_SESSION_IDLE_MS,
  LOCAL_CHANGE_DEBOUNCE_MS,
  MOBILE_MAX_SYNC_FILE_SIZE_BYTES,
  merge3,
  toBase64,
  unpackBlob,
} from "@websync/shared";
import type { CryptoService } from "./CryptoService.js";
import { staleBaseItem, type DecodedFileListItem, type RemoteApiClient } from "./RemoteApiClient.js";
import type { LocalIndex, LocalIndexRecord } from "./LocalIndex.js";
import type { FileSystemAdapter } from "./FileSystemAdapter.js";
import type { TransferTracker } from "../ui/TransferTracker.js";
import type { LogReason, SyncLog } from "./SyncLog.js";
import { errorArgs } from "./errorArgs.js";
import { t } from "../i18n/index.js";
import { TransferCancelled, SyncstoneApiError } from "./httpClient.js";

/** Notes up to this size are kept as merge base and can be merged when edited on two devices. */
const MERGE_MAX_BYTES = 1024 * 1024;
const isMergeablePath = (path: string): boolean => /\.(md|txt)$/i.test(path);
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
/** A file that failed is left alone this long before the next attempt; the rest of the sync does not wait for it. */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/** After this many failures in a row a file is put aside (the sync moves on without it) until a manual sync or a restart. */
const MAX_FILE_ATTEMPTS = 3;
/** An edit is only sent after a sync of the server's changes that is at most this old (see `catchUp`). */
const CATCH_UP_FRESH_MS = 15_000;
/** The same for a file that is new here: a note of the same name may have been created elsewhere a moment ago. */
const CATCH_UP_NEW_FILE_MS = 1_000;
/** Files deleted while Syncstone was not running: up to this many go to the other devices without asking. */
const MAX_SILENT_LOCAL_DELETES = 5;

/** What to do with files that were deleted here while Syncstone was not running (see `doFullSync`). */
type MissingMode = "delete" | "restore" | "hold";

/** Errors that say "nothing will work right now" (offline, signed out, server down) - those still stop the whole run. */
function isFatal(err: unknown): boolean {
  if (!(err instanceof SyncstoneApiError)) return false;
  return err.status === 0 || err.status === 401 || err.status === 403 || err.status >= 502;
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return textDecoder.decode(bytes);
  } catch {
    return null;
  }
}

export interface SyncEngineDeps {
  vaultId: string;
  crypto: CryptoService;
  remote: RemoteApiClient;
  fs: FileSystemAdapter;
  localIndex: LocalIndex;
  isPaused: () => boolean;
  /** True for any path owned by ConfigSyncEngine instead (`.obsidian/**`) - skipped here so the two engines never both try to handle the same remote item. */
  isConfigPath: (path: string) => boolean;
  /**
   * True while a note is being co-edited live (collab/CollabManager.ts). Its
   * content then reaches this device through the live session, so the file
   * version from the server must NOT be written over the open editor - that
   * would overwrite what the other device typed a moment ago. Uploads and
   * renames/deletes are unaffected. Optional so the engine works without collab.
   */
  isCollabLive?: (fileId: string) => boolean;
  /**
   * While a note is co-edited live, exactly one device (the session's host) writes it to the server; the others get the
   * same text through the session and stay quiet, so two devices never race each other with the same edits. True when
   * the note is not live here, or this device is its host. Optional so the engine works without collab.
   */
  isCollabWriter?: (fileId: string) => boolean;
  /**
   * Saves what is typed in an open editor of `path` to the file right now (Obsidian saves a moment after typing).
   * True when the note was open. Used before a download replaces the file, so nothing typed just then is lost.
   */
  saveOpenEditor?: (path: string) => Promise<boolean>;
  /**
   * Merges another device's version (`remote`, changed from `base`) into the live session of `fileId`, right in this
   * device's editor (the host's), so every device in the note gets it at once - with what is being typed this very
   * moment kept. Used when a device that is not in the session changed the note. Returns the session's new text, null
   * when the two overlap (nothing changed), false when the note is not live here right now.
   */
  mergeIntoLive?: (fileId: string, base: string, remote: string) => Promise<string | null | false>;
  /** Receives the progress of uploads/downloads (explorer rings). Optional so the engine works without UI. */
  transfers?: TransferTracker;
  /** The sync log dialog's record of what happened. */
  log?: SyncLog;
  /** The vault-wide `currentVersion` this device last fully applied - the `since=` cursor for incremental polling. */
  initialGlobalVersion: number;
  onStateChange: (state: { lastSyncAt: string; globalVersion: number }) => void | Promise<void>;
  /** Largest file this device syncs while it is a phone / tablet (default: the safe limit of the shared code). */
  mobileMaxFileBytes?: () => number;
  /**
   * More files than `MAX_SILENT_LOCAL_DELETES` were deleted here while Syncstone was not running. Asks whether to delete
   * them on every device too ("delete") or to bring them back ("restore"); null when the question was closed without an
   * answer. Without it such files are brought back.
   */
  askAboutMissingFiles?: (count: number) => Promise<"delete" | "restore" | null>;
  /** True while the account is read-only (trial / subscription over): uploads are skipped instead of being refused one by one. */
  isReadOnly?: () => boolean;
  /** The server refused a write because the account is read-only (402) or the storage quota is used up (413). */
  onWriteRefused?: (reason: "read-only" | "storage-full") => void;
}

type LocalEventType = "create" | "modify" | "delete";

/**
 * Empty folders are synced through one hidden marker file per folder (see FOLDER_MARKER_FILENAME). These helpers
 * recognise such paths; the marker is never a TFile (Obsidian ignores dot-files), so it is handled separately.
 */
function isMarkerPath(path: string): boolean {
  return path === FOLDER_MARKER_FILENAME || path.endsWith(`/${FOLDER_MARKER_FILENAME}`);
}

function markerPathFor(folderPath: string): string {
  return `${folderPath}/${FOLDER_MARKER_FILENAME}`;
}

function isHiddenFolder(folderPath: string): boolean {
  return folderPath.split("/").some((segment) => segment.startsWith("."));
}

/**
 * The core sync engine. Three entry points drive it:
 *  - `runFullSync()`: initial reconciliation against the whole remote file
 *    list (called on startup and from the "Jetzt synchronisieren" button).
 *  - `handleLocalEvent()` / `handleLocalRename()`: registered against
 *    Obsidian's vault `create`/`modify`/`delete`/`rename` events, debounced
 *    per path.
 *  - `runIncrementalPoll()`: called on an interval (and once on load/focus)
 *    to pick up changes made by other devices.
 *
 * A per-fileId async lock (`withFileLock`) makes sure a local upload and a
 * remote download of the *same* file can never race each other, regardless
 * of which of the three entry points triggered them.
 */
export class SyncEngine {
  private readonly debounceTimers = new Map<string, ReturnType<typeof window.setTimeout>>();
  private readonly fileLocks = new Map<string, Promise<unknown>>();
  /** File ids already warned about as oversized-for-mobile this session, so the Notice doesn't repeat on every poll/full-sync pass. */
  private readonly warnedOversizedIds = new Set<string>();
  /** "Still editing this file" session ids (by fileId), folding a burst of saves into one history entry. */
  private readonly editSessions = new Map<string, { id: string; at: number }>();
  private syncing = false;
  private currentGlobalVersion: number;

  /** Read by the status bar UI - true while a full sync or incremental poll is in flight. */
  get isSyncing(): boolean {
    return this.syncing;
  }

  constructor(private readonly deps: SyncEngineDeps) {
    this.currentGlobalVersion = deps.initialGlobalVersion;
  }

  /** Set by `dispose()`: a sync that is still running (the first one runs in the background) stops at its next file. */
  private disposed = false;
  /**
   * Moves this engine makes itself while applying another device's rename (new path -> old path). Obsidian reports them
   * as an ordinary `rename` event; treating that as a user rename sent a second rename to the server, looked up by the
   * OLD path - and when another file had taken that name meanwhile, the wrong file got renamed on the server.
   */
  private readonly ownRenames = new Map<string, string>();
  /** Per file (or remote item) that failed: when it may be tried again, and how many times in a row it failed. */
  private readonly failed = new Map<string, { until: number; count: number }>();
  /** When a full sync / poll last finished: how up to date this device is with the server's renames and edits. */
  private lastSyncedAt = 0;
  /** Files that failed (or were held back) in the run that is going / went last. */
  private runFailures = 0;
  /** After a full sync with failures: when the next poll runs the full sync again (it is the only one that retries local files). */
  private fullSyncRetryAt: number | null = null;
  private mobileLimit(): number {
    return this.deps.mobileMaxFileBytes?.() ?? MOBILE_MAX_SYNC_FILE_SIZE_BYTES;
  }

  /**
   * Renames made here whose debounce has not run yet: new path -> the path the server still has. An edit that arrives
   * under the new name before the rename was sent (typing right after renaming, or live edits from another device) must
   * not replace the rename: it would be uploaded as a new file and the note would exist twice. The rename always goes
   * first, then the edit.
   */
  private readonly pendingRenames = new Map<string, string>();
  /** The answer about files deleted while Syncstone was not running: used by the next full sync, then forgotten. */
  private missingAnswer: "delete" | "restore" | "asking" | "dismissed" | null = null;
  /** Files whose write was refused as outdated and are being merged right now (guards against going round in circles). */
  private readonly resolvingStale = new Set<string>();

  /** Files and folders the user deleted here, with the time: a transfer that was running meanwhile must not undo that. */
  private readonly locallyDeleted = new Map<string, number>();

  private markLocallyDeleted(path: string): void {
    const now = Date.now();
    this.locallyDeleted.set(path, now);
    for (const [other, at] of this.locallyDeleted) if (now - at > 10 * 60_000) this.locallyDeleted.delete(other);
  }

  /** Was `path` (or a folder around it) deleted here since `since`? */
  private deletedSince(path: string, since: number): boolean {
    for (let current = path; ; ) {
      const at = this.locallyDeleted.get(current);
      if (at !== undefined && at >= since) return true;
      const slash = current.lastIndexOf("/");
      if (slash <= 0) return false;
      current = current.slice(0, slash);
    }
  }

  /**
   * `path` was deleted here since `since` and is really gone (Obsidian also reports a delete for some renames that only change
   * the case of a name - the file is still there then).
   */
  private goneSince(path: string, since: number): boolean {
    return this.deletedSince(path, since) && !this.deps.fs.getFileByPath(path);
  }

  /** The bytes of a local file, or null when it is gone by now (deleted while the sync was busy with something else). */
  private async readLocal(file: TFile): Promise<Uint8Array | null> {
    try {
      return await this.deps.fs.readBinary(file);
    } catch (err) {
      if (!this.deps.fs.getFileByPath(file.path)) return null;
      throw err;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.deps.transfers?.dropQueued();
    for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
    this.debounceTimers.clear();
  }

  /**
   * The id of the "still editing this file" session used to fold a burst of saves into one history entry - see
   * `HISTORY_EDIT_SESSION_IDLE_MS`. Refreshed on every upload; `endEditSession` starts a fresh one on the next one
   * (called by main.ts when a different note becomes active in the workspace).
   */
  private touchEditSession(fileId: string): string {
    const now = Date.now();
    const existing = this.editSessions.get(fileId);
    if (existing && now - existing.at < HISTORY_EDIT_SESSION_IDLE_MS) {
      existing.at = now;
      return existing.id;
    }
    const fresh = { id: crypto.randomUUID(), at: now };
    this.editSessions.set(fileId, fresh);
    return fresh.id;
  }

  /** Ends the edit session for `fileId` early (it stopped being the active note) - its next edit starts a new history entry. */
  endEditSession(fileId: string): void {
    this.editSessions.delete(fileId);
  }

  // ============================================================
  // Public entry points
  // ============================================================

  async runFullSync(): Promise<void> {
    if (this.deps.isPaused() || this.syncing) return;
    this.syncing = true;
    // A full sync moves the cursor while it works. If it dies half way, the files it did not reach must be fetched
    // again by the next poll - so the cursor goes back to where it was instead of staying at the newest version seen.
    const cursorBefore = this.currentGlobalVersion;
    const log = this.deps.log;
    const upBefore = log?.total("up") ?? 0;
    const downBefore = log?.total("down") ?? 0;
    this.runFailures = 0;
    try {
      await this.doFullSync();
      this.lastSyncedAt = Date.now();
      // What failed must be fetched again: the cursor stays where it was, and the poll runs a full sync once the pause is over.
      if (this.runFailures > 0) {
        this.currentGlobalVersion = cursorBefore;
        this.fullSyncRetryAt = Date.now() + FAILURE_BACKOFF_MS;
      } else this.fullSyncRetryAt = null;
      await this.persistState();
      log?.add({ kind: "summary", args: [log.total("up") - upBefore, log.total("down") - downBefore, this.runFailures] });
    } catch (err) {
      this.currentGlobalVersion = cursorBefore;
      this.logError(err);
      throw err;
    } finally {
      this.syncing = false;
      // Whatever was announced to the rings but needed no transfer after all (same content on both sides) goes away.
      this.deps.transfers?.dropQueued();
    }
  }

  async runIncrementalPoll(): Promise<void> {
    if (this.deps.isPaused() || this.syncing) return;
    if (this.fullSyncRetryAt !== null && Date.now() >= this.fullSyncRetryAt) return this.runFullSync();
    this.syncing = true;
    this.runFailures = 0;
    try {
      await this.doIncrementalPoll();
      this.lastSyncedAt = Date.now();
      await this.persistState();
    } catch (err) {
      this.logError(err);
      throw err;
    } finally {
      this.syncing = false;
      this.deps.transfers?.dropQueued();
    }
  }

  private logError(err: unknown, path?: string): void {
    this.deps.log?.add({ kind: "error", path, args: errorArgs(err) });
  }

  /** A manual sync tries everything again, including the files that were put aside. */
  retryFailed(): void {
    this.failed.clear();
    this.fullSyncRetryAt = null;
  }

  /** How many files the last full sync or poll could not handle (they are retried; see the sync log for why). */
  get failedCount(): number {
    return this.runFailures;
  }

  /**
   * Runs the work for one file. A failure of that file (a server error for it, a file that cannot be read) is logged and
   * skipped, so one bad file does not stop the others; it is tried again after a pause. Failures that hit every file
   * (offline, signed out) still end the run.
   */
  private async attempt(key: string, path: string | undefined, action: () => Promise<void>): Promise<boolean> {
    const previous = this.failed.get(key);
    if (previous && previous.until > Date.now()) {
      // Put aside for good: the sync carries on (and its cursor with it) instead of waiting for this file forever.
      if (previous.count < MAX_FILE_ATTEMPTS) this.runFailures++;
      return false;
    }
    try {
      await action();
      this.failed.delete(key);
      return true;
    } catch (err) {
      if (this.disposed || isFatal(err)) throw err;
      console.error(`Syncstone: "${path ?? key}" konnte nicht synchronisiert werden`, err);
      const count = (previous?.count ?? 0) + 1;
      this.failed.set(key, { until: count >= MAX_FILE_ATTEMPTS ? Number.POSITIVE_INFINITY : Date.now() + FAILURE_BACKOFF_MS, count });
      if (count < MAX_FILE_ATTEMPTS) this.runFailures++;
      this.logError(err, path);
      if (path) this.deps.transfers?.fail(path, t("p.fail.error", { error: errorArgs(err)[0] ?? "" }));
      return false;
    }
  }

  handleLocalEvent(type: LocalEventType, file: TAbstractFile): void {
    if (file instanceof TFile && type !== "modify") this.deps.fs.trackCase(type, file);
    if (this.deps.isPaused()) return;
    if (file instanceof TFolder) {
      if (type === "modify" || file.isRoot() || isHiddenFolder(file.path)) return;
      const path = file.path;
      if (type === "delete") this.markLocallyDeleted(path);
      this.scheduleDebounced(`folder:${path}`, () => (type === "delete" ? this.processFolderDelete(path) : this.processFolderCreate(path)));
      return;
    }
    if (!(file instanceof TFile)) return;
    const path = file.path;
    // The change is noticed: an empty circle in the explorer right away (it fills once the file is sent, after the debounce).
    if (type === "delete") {
      this.markLocallyDeleted(path);
      this.deps.transfers?.release(path); // deleted before it was sent: nothing to wait for
      this.deps.transfers?.clearFailure(path);
    } else this.deps.transfers?.queue([path], Date.now(), true);
    this.scheduleDebounced(path, () => this.afterPendingRename(path, () => this.processLocalChange(type, path)), path);
  }

  /**
   * Sends every rename made here that is still waiting for its debounce. Runs before another device's changes are
   * applied: until the server knows the new name, this device's index still has the old one, and an edit of the note
   * made elsewhere meanwhile would be written to the old name as a second file.
   */
  private async sendPendingRenames(): Promise<void> {
    for (const [newPath, from] of [...this.pendingRenames]) {
      if (this.pendingRenames.get(newPath) !== from) continue;
      this.pendingRenames.delete(newPath);
      if (from === newPath) continue;
      try {
        await this.processLocalRename(from, newPath);
      } catch (err) {
        // Offline or the server is down: tried again with the next sync. Refused for this file (deleted elsewhere, for
        // example): dropped, so it can never hold up the sync; the sync then settles the file like any other.
        if (isFatal(err)) {
          this.pendingRenames.set(newPath, from);
          throw err;
        }
        this.logError(err, newPath);
      }
    }
  }

  /** Sends a rename of `path` that is still waiting first (see `pendingRenames`), then runs `action`. */
  private async afterPendingRename(path: string, action: () => Promise<void>): Promise<void> {
    const from = this.pendingRenames.get(path);
    if (from !== undefined) {
      this.pendingRenames.delete(path);
      if (from !== path) {
        try {
          await this.processLocalRename(from, path);
        } catch (err) {
          if (isFatal(err)) {
            this.pendingRenames.set(path, from); // offline: sent with the next sync
            throw err;
          }
          this.logError(err, path); // refused for this file: the edit still goes out, the sync settles the rest
        }
      }
    }
    await action();
  }

  handleLocalRename(file: TAbstractFile, oldPath: string): void {
    if (file instanceof TFile) this.deps.fs.trackCase("rename", file, oldPath);
    if (this.deps.isPaused()) return;
    if (file instanceof TFolder) {
      if (file.isRoot() || isHiddenFolder(file.path)) return;
      const newPath = file.path;
      this.scheduleDebounced(`folder:${newPath}`, () => this.processFolderRename(oldPath, newPath));
      return;
    }
    if (!(file instanceof TFile)) return;
    const newPath = file.path;
    this.deps.transfers?.release(oldPath); // renamed before it was sent: the waiting circle belongs to the old name
    this.deps.transfers?.clearFailure(oldPath);
    if (this.ownRenames.get(newPath) === oldPath) {
      // Our own move (another device renamed the file): the server already has the new name. An edit that was still
      // waiting under the old name goes along to the new one.
      this.ownRenames.delete(newPath);
      if (this.debounceTimers.has(oldPath)) {
        this.clearDebounce(oldPath);
        this.scheduleDebounced(newPath, () => this.processLocalChange("modify", newPath), newPath);
      }
      return;
    }
    // Renamed again before the first rename was sent: the server still has the first name.
    const serverPath = this.pendingRenames.get(oldPath) ?? oldPath;
    this.pendingRenames.delete(oldPath);
    this.clearDebounce(oldPath);
    this.pendingRenames.set(newPath, serverPath);
    // An edit that was waiting under the old name goes along: after the rename the content is compared and sent if new.
    this.scheduleDebounced(newPath, () => this.afterPendingRename(newPath, () => this.processLocalChange("modify", newPath)), newPath);
  }

  /**
   * Uploads a change of `path` that is still waiting for its debounce right now (e.g. before restoring an older
   * version, so the pending edit cannot land on top of the restore a moment later).
   */
  async flushPath(path: string): Promise<void> {
    if (!this.debounceTimers.has(path)) return;
    this.clearDebounce(path);
    try {
      await this.afterPendingRename(path, () => this.processLocalChange("modify", path));
    } finally {
      this.deps.transfers?.release(path);
    }
  }

  // ============================================================
  // Debounce (per local path)
  // ============================================================

  /** `queuedPath`: the file whose waiting circle is dropped when this run is over without having sent it. */
  private scheduleDebounced(key: string, action: () => Promise<void>, queuedPath?: string): void {
    this.clearDebounce(key);
    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(key);
      action()
        .catch((err) => {
          if ((err as { status?: unknown } | null)?.status === 402) this.deps.onWriteRefused?.("read-only");
          console.error(`Syncstone: lokale Änderung an "${key}" konnte nicht synchronisiert werden`, err);
          this.logError(err, key.replace(/^folder:/, ""));
          if (!key.startsWith("folder:")) this.deps.transfers?.fail(key, t("p.fail.error", { error: errorArgs(err)[0] ?? "" }));
        })
        .finally(() => {
          if (queuedPath) this.deps.transfers?.release(queuedPath);
        });
    }, LOCAL_CHANGE_DEBOUNCE_MS);
    this.debounceTimers.set(key, timer);
  }

  private clearDebounce(key: string): void {
    const timer = this.debounceTimers.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.debounceTimers.delete(key);
    }
  }

  // ============================================================
  // Per-file async lock, so a local upload and a remote download of the
  // same fileId can never interleave.
  // ============================================================

  private async withFileLock<T>(fileId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(fileId) ?? Promise.resolve();
    const run = previous.then(action, action);
    // Store a settle-tracking promise (never rejects) so the NEXT queued
    // operation on this fileId always runs, even if this one failed.
    this.fileLocks.set(
      fileId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  // ============================================================
  // Local event handling
  // ============================================================

  private async processLocalChange(type: LocalEventType, path: string): Promise<void> {
    if (type === "delete") {
      const record = await this.deps.localIndex.getByPath(path);
      if (!record) return; // never synced, nothing to tell the server
      // Some delete events are not real deletes (e.g. a case-only rename on a case-insensitive disk): trust the disk.
      if (await this.deps.fs.existsOnDisk(path)) return;
      await this.withFileLock(record.fileId, () => this.deleteRemote(record));
      return;
    }

    // An upload carries the file's path. If another device moved or renamed the note while this one was away (or busy), sending the
    // edit now would put it back at its old place: first take over what the server has changed.
    // A new note too: another device may have created one with the same name a moment ago (a daily note made on two
    // devices). Catching up first (even shortly after the last sync) finds it, so both are compared and combined
    // instead of becoming two files.
    const known = type !== "create" && (await this.deps.localIndex.getByPath(path));
    await this.catchUp(known ? CATCH_UP_FRESH_MS : CATCH_UP_NEW_FILE_MS);

    const file = this.deps.fs.getFileByPath(path);
    if (!file) return; // vanished again before the debounce fired (or moved by the sync that just ran - it sends the edit from its new place)

    const record = await this.deps.localIndex.getByPath(path);
    const fileId = record?.fileId ?? crypto.randomUUID();

    await this.withFileLock(fileId, async () => {
      if (record && !(this.deps.isCollabWriter?.(fileId) ?? true)) return; // co-edited live: the session's host writes it
      const plaintext = await this.readLocal(file);
      if (!plaintext) return; // deleted meanwhile
      const hash = await this.deps.crypto.hashContent(plaintext);
      if (record && record.lastContentHashBlinded === toBase64(hash)) return; // no real content change (e.g. mtime-only touch)
      await this.uploadFile(file, fileId, { plaintext, hash }, record ? "local" : "new", record ? record.lastContentHashBlinded : null);
    });
  }

  /**
   * Brings this device up to date with the server before a local edit is sent, unless that happened just now: renames and
   * moves from other devices are applied first, so an edit made at the old path cannot undo them. A sync that is already
   * running does the same job, so it is waited for instead.
   */
  private async catchUp(freshMs = CATCH_UP_FRESH_MS): Promise<void> {
    if (Date.now() - this.lastSyncedAt < freshMs) return;
    for (let waited = 0; this.syncing && waited < 10_000; waited += 100) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (this.syncing || this.disposed) return;
    try {
      await this.runIncrementalPoll();
    } catch {
      // Offline or the server is down: the upload fails the same way and is tried again with the next change.
    }
  }

  private async processLocalRename(oldPath: string, newPath: string): Promise<void> {
    const record = await this.deps.localIndex.getByPath(oldPath);
    if (!record) {
      // We never knew the old path (e.g. created+renamed within one
      // debounce window) - treat it as a fresh upload at the new path.
      await this.processLocalChange("create", newPath);
      return;
    }
    await this.withFileLock(record.fileId, async () => {
      const encryptedPath = await this.deps.crypto.encryptPath(newPath);
      await this.deps.remote.renameFile(this.deps.vaultId, record.fileId, encryptedPath.ciphertext, encryptedPath.iv);
      await this.deps.localIndex.put({ ...record, localPath: newPath, lastSyncedAt: new Date().toISOString() });
      if (!isMarkerPath(newPath)) this.deps.log?.add({ kind: "rename-up", path: newPath, args: [oldPath] });
    });
  }

  // ============================================================
  // Empty folders (marker files)
  // ============================================================

  /** A folder appeared locally: if it is (still) empty, give it a marker so it exists on the other devices, too. */
  private async processFolderCreate(path: string): Promise<void> {
    const folder = this.deps.fs.getFolderByPath(path);
    if (!folder || folder.children.length > 0) return;
    const markerPath = markerPathFor(path);
    if (await this.deps.localIndex.getByPath(markerPath)) return;
    const fileId = crypto.randomUUID();
    await this.withFileLock(fileId, () => this.uploadMarker(fileId, markerPath));
  }

  /**
   * A folder was deleted locally: remove its marker and every synced file below it, so it disappears on the other devices,
   * too. Obsidian does not reliably send a delete event for each file inside a deleted folder (on mobile often only the
   * folder's own event arrives), so the files are looked up in the index instead of waiting for their events.
   */
  private async processFolderDelete(path: string): Promise<void> {
    if (this.deps.fs.getFolderByPath(path)) return; // re-created in the meantime
    const prefix = `${path}/`;
    const inside = (await this.deps.localIndex.getAll()).filter((record) => record.localPath.startsWith(prefix));
    for (const record of inside) {
      if (await this.deps.fs.existsOnDisk(record.localPath)) continue; // moved back / re-created meanwhile
      await this.withFileLock(record.fileId, () => this.deleteRemote(record));
    }
  }

  private async processFolderRename(oldPath: string, newPath: string): Promise<void> {
    const record = await this.deps.localIndex.getByPath(markerPathFor(oldPath));
    if (!record) return;
    const newMarker = markerPathFor(newPath);
    await this.withFileLock(record.fileId, async () => {
      const encryptedPath = await this.deps.crypto.encryptPath(newMarker);
      await this.deps.remote.renameFile(this.deps.vaultId, record.fileId, encryptedPath.ciphertext, encryptedPath.iv);
      await this.deps.localIndex.put({ ...record, localPath: newMarker, lastSyncedAt: new Date().toISOString() });
    });
  }

  private async uploadMarker(fileId: string, markerPath: string): Promise<void> {
    const plaintext = new Uint8Array(0);
    const hash = await this.deps.crypto.hashContent(plaintext);
    const encryptedContent = await this.deps.crypto.encryptContent(plaintext);
    const encryptedPath = await this.deps.crypto.encryptPath(markerPath);
    const result = await this.deps.remote.uploadFile(this.deps.vaultId, fileId, {
      pathCiphertext: encryptedPath.ciphertext,
      pathNonce: encryptedPath.iv,
      contentHashBlinded: hash,
      contentSize: 0,
      contentIv: encryptedContent.iv,
      contentCiphertext: encryptedContent.ciphertext,
    });
    await this.deps.fs.writeMarker(markerPath);
    await this.deps.localIndex.put({
      fileId,
      localPath: markerPath,
      lastKnownVersion: result.version,
      lastContentHashBlinded: toBase64(hash),
      lastSyncedAt: new Date().toISOString(),
    });
    this.noteOwnWrite(result.version);
  }

  /** Runs inside the file's lock; the record is looked up again because a folder delete and the file's own event race. */
  private async deleteRemote(record: LocalIndexRecord): Promise<void> {
    if (!(await this.deps.localIndex.get(record.fileId))) return; // already handled
    await this.deps.remote.deleteFile(this.deps.vaultId, record.fileId);
    await this.deps.localIndex.delete(record.fileId);
    if (!isMarkerPath(record.localPath)) this.deps.log?.add({ kind: "delete-up", path: record.localPath });
  }

  // ============================================================
  // Full sync (initial reconciliation)
  //
  // Three phases, in order:
  //  A. Reconcile everything the local index already knows about, by
  //     fileId (covers the common "normal restart" case).
  //  B. Remote files with no local-index entry yet, matched by decrypted
  //     path against local files (covers "new device links an existing
  //     vault whose files are already present locally").
  //  C. Local files nobody above accounted for -> brand-new uploads.
  // ============================================================

  private async doFullSync(): Promise<void> {
    await this.sendPendingRenames();
    const localFiles = this.deps.fs.listAllFiles();
    const localByPath = new Map(localFiles.map((f) => [f.path, f] as const));

    const remoteResp = await this.deps.remote.listFiles(this.deps.vaultId, 0, true);
    const remoteById = new Map(remoteResp.files.map((item) => [item.id, item] as const));
    this.bumpGlobalVersion(remoteResp.currentVersion);

    const indexRecords = await this.repairDuplicatePaths(await this.deps.localIndex.getAll(), remoteById);
    const knownFileIds = new Set(indexRecords.map((r) => r.fileId));

    const handledPaths = new Set<string>();

    await this.announceFullSyncWork(localByPath, indexRecords, remoteResp.files);

    const missingMode = this.decideMissingFiles(indexRecords, localByPath, remoteById);

    // --- Phase A ---
    // Renames whose new name is still taken by another file of this pass (swapped names) are retried at the end.
    const deferred: LocalIndexRecord[] = [];
    for (const record of indexRecords) {
      if (this.disposed) return;
      await this.attempt(record.fileId, record.localPath, () =>
        this.withFileLock(record.fileId, () => this.reconcileIndexedRecord(record, remoteById, localByPath, handledPaths, missingMode, deferred)),
      );
    }
    if (deferred.length > 0) {
      const wants: Array<{ fileId: string; target: string }> = [];
      for (const record of deferred) {
        const item = remoteById.get(record.fileId);
        const target = item ? await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce).catch(() => null) : null;
        if (target) wants.push({ fileId: record.fileId, target });
      }
      await this.unblockSwaps(wants);
    }
    // Retried while that frees places (each move can free the name another file waits for); what is still blocked then
    // is a real clash and settled for good (it keeps its name).
    let pendingRecords = deferred;
    for (let round = 0; round < 5 && pendingRecords.length > 0; round++) {
      const again: LocalIndexRecord[] = [];
      for (const record of pendingRecords) {
        if (this.disposed) return;
        await this.attempt(record.fileId, record.localPath, () =>
          this.withFileLock(record.fileId, async () => {
            const current = await this.deps.localIndex.get(record.fileId);
            if (current) await this.reconcileIndexedRecord(current, remoteById, localByPath, handledPaths, missingMode, again);
          }),
        );
      }
      const progress = again.length < pendingRecords.length;
      pendingRecords = again;
      if (!progress) break;
    }
    for (const record of pendingRecords) {
      if (this.disposed) return;
      await this.attempt(record.fileId, record.localPath, () =>
        this.withFileLock(record.fileId, async () => {
          const current = await this.deps.localIndex.get(record.fileId);
          if (current) await this.reconcileIndexedRecord(current, remoteById, localByPath, handledPaths, missingMode, null);
        }),
      );
    }

    // --- Phase B ---
    for (const item of remoteResp.files) {
      if (this.disposed) return;
      if (item.isDeleted || knownFileIds.has(item.id)) continue;

      let path: string;
      try {
        path = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce);
      } catch (err) {
        console.error(`Syncstone: Pfad für Datei ${item.id} konnte nicht entschlüsselt werden - übersprungen.`, err);
        continue;
      }
      if (this.deps.isConfigPath(path) || handledPaths.has(path)) continue;

      let placedAt = path;
      let localTwinPath: string | null = null;
      await this.attempt(item.id, path, async () => {
        // A note of the same name here (also written with other upper/lower case) is the same note: compared and merged.
        const twin = localByPath.get(path) ?? this.deps.fs.getFileByPathIgnoringCase(path);
        const owner = twin && twin.path !== path ? await this.deps.localIndex.getByPath(twin.path) : undefined;
        if (twin && owner && owner.fileId !== item.id) {
          // ...unless it is another file of the vault: two names that differ only in case cannot live side by side.
          await this.withFileLock(item.id, async () => {
            placedAt = await this.settleCaseClash(item, undefined, path, owner, twin);
            if (!this.deps.fs.getFileByPath(placedAt)) await this.downloadFile(item, placedAt, "new");
          });
          return;
        }
        await this.withFileLock(item.id, async () => {
          if (twin) {
            placedAt = twin.path;
            localTwinPath = twin.path;
            await this.reconcileExisting(item, twin.path, twin);
            // Written with other upper/lower case here: takes the server's name, like on the other devices.
            const record = await this.deps.localIndex.get(item.id);
            if (twin.path !== path && record?.localPath === twin.path && (await this.moveLocal(twin.path, path))) {
              await this.deps.localIndex.put({ ...record, localPath: path });
              placedAt = path;
            }
          } else {
            await this.downloadFile(item, path, "new");
          }
        });
      });
      handledPaths.add(path);
      handledPaths.add(placedAt);
      if (localTwinPath) handledPaths.add(localTwinPath); // the same file under the name it had before
    }

    // --- Phase C ---
    for (const [path, file] of localByPath) {
      if (this.disposed) return;
      if (handledPaths.has(path)) continue;
      const fileId = crypto.randomUUID();
      await this.attempt(`path:${path}`, path, () => this.withFileLock(fileId, () => this.uploadFile(file, fileId, undefined, "new", null)));
      handledPaths.add(path);
    }

    // --- Phase D: empty local folders get a marker so they exist on the other devices as well ---
    for (const folder of this.deps.fs.listEmptyFolders()) {
      const markerPath = markerPathFor(folder.path);
      if (handledPaths.has(markerPath) || (await this.deps.localIndex.getByPath(markerPath))) continue;
      const fileId = crypto.randomUUID();
      await this.attempt(`path:${markerPath}`, folder.path, () => this.withFileLock(fileId, () => this.uploadMarker(fileId, markerPath)));
      handledPaths.add(markerPath);
    }
  }

  /**
   * Files the index knows that are gone here were deleted while Syncstone could not see it (app closed, deleted in the
   * file manager, a phone that suspended the app before the delete was sent). A handful is passed on to the other
   * devices. More than that may as well be a mishap (a moved folder, files moved out to cloud storage), so the user is
   * asked; until then those files are left alone (kept on the other devices, not fetched again here). Files changed on
   * another device meanwhile are not counted: they always come back.
   */
  private decideMissingFiles(records: LocalIndexRecord[], localByPath: Map<string, TFile>, remoteById: Map<string, DecodedFileListItem>): MissingMode {
    const count = records.filter((r) => {
      if (isMarkerPath(r.localPath) || this.deps.isConfigPath(r.localPath) || localByPath.has(r.localPath)) return false;
      const remote = remoteById.get(r.fileId);
      return !!remote && !remote.isDeleted && toBase64(remote.contentHashBlinded) === r.lastContentHashBlinded;
    }).length;
    if (count <= MAX_SILENT_LOCAL_DELETES) return "delete";
    const answer = this.missingAnswer;
    if (answer === "delete" || answer === "restore") {
      this.missingAnswer = null;
      return answer;
    }
    if (!this.deps.askAboutMissingFiles) return "restore";
    if (answer === null) {
      this.missingAnswer = "asking";
      void this.deps.askAboutMissingFiles(count).then((choice) => {
        // Closed without an answer: asked again the next time the app starts.
        this.missingAnswer = choice ?? "dismissed";
        if (choice) void this.runFullSync().catch(() => undefined);
      });
    }
    return "hold";
  }

  /**
   * Tells the explorer rings which files this run will probably move, before the first one starts: they show as empty grey
   * circles and fill one after the other. It is a cheap estimate (no hashing): a file the server has newer than the index
   * remembers, a local file touched after its last sync, a remote file that is missing here, a local file the server does
   * not know. What turns out not to need a transfer is dropped again at the end of the run.
   */
  private async announceFullSyncWork(localByPath: Map<string, TFile>, indexRecords: LocalIndexRecord[], remoteFiles: DecodedFileListItem[]): Promise<void> {
    const tracker = this.deps.transfers;
    if (!tracker) return;
    const recordById = new Map(indexRecords.map((r) => [r.fileId, r] as const));
    const indexedPaths = new Set(indexRecords.map((r) => r.localPath));
    const remotePaths = new Set<string>();
    const paths: string[] = [];
    const relevant = (path: string) => !isMarkerPath(path) && !this.deps.isConfigPath(path);

    for (const item of remoteFiles) {
      if (item.isDeleted) continue;
      let path: string;
      try {
        path = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce);
      } catch {
        continue; // reported when the file itself is handled
      }
      remotePaths.add(path);
      if (!relevant(path)) continue;
      const record = recordById.get(item.id);
      const local = localByPath.get(path);
      if (!record || !local) paths.push(path); // new here, or gone here: comes down
      else if (item.version > record.lastKnownVersion) paths.push(path); // changed on another device
      else if (local.stat.mtime > Date.parse(record.lastSyncedAt) + 2000) paths.push(path); // changed here since
    }
    for (const path of localByPath.keys()) {
      if (relevant(path) && !remotePaths.has(path) && !indexedPaths.has(path)) paths.push(path); // new here: goes up
    }
    if (paths.length > 0) tracker.queue(paths);
  }

  private async reconcileIndexedRecord(
    record: LocalIndexRecord,
    remoteById: Map<string, DecodedFileListItem>,
    localByPath: Map<string, TFile>,
    handledPaths: Set<string>,
    missingMode: MissingMode,
    deferred: LocalIndexRecord[] | null,
  ): Promise<void> {
    const remoteItem = remoteById.get(record.fileId);
    const localFile = localByPath.get(record.localPath);
    handledPaths.add(record.localPath);

    if (!remoteItem) {
      // Server has no memory of this fileId at all (e.g. vault reset server-side).
      if (localFile) await this.uploadFile(localFile, record.fileId, undefined, "new", null);
      else await this.deps.localIndex.delete(record.fileId);
      return;
    }

    if (remoteItem.isDeleted) {
      if (isMarkerPath(record.localPath)) {
        await this.applyRemoteDelete(record.fileId, record.localPath);
      } else if (!localFile) {
        await this.deps.localIndex.delete(record.fileId);
        await this.deps.fs.pruneEmptyParents(record.localPath); // the file is gone already, but its folder may be left empty
      } else if (await this.remoteDeleteWins(record, localFile)) {
        await this.applyRemoteDelete(record.fileId, record.localPath);
      } else {
        await this.uploadFile(localFile, record.fileId, undefined, "restored", record.lastContentHashBlinded); // edited here after the last sync: the edit beats the delete
      }
      this.bumpGlobalVersion(remoteItem.version);
      return;
    }

    let path: string;
    try {
      path = await this.deps.crypto.decryptPath(remoteItem.pathCiphertext, remoteItem.pathNonce);
    } catch (err) {
      console.error(`Syncstone: Pfad für Datei ${remoteItem.id} konnte nicht entschlüsselt werden - übersprungen.`, err);
      return;
    }

    const samePath = path === record.localPath;
    if (!samePath) {
      // Renamed on another device. Never take whatever file sits at the new name for this one (see placeLocally).
      const placed = await this.placeLocally(remoteItem, record, path, deferred !== null);
      if (placed === null) {
        deferred?.push(record);
        return;
      }
      path = placed;
      handledPaths.add(path);
    }

    const currentLocalFile = this.deps.fs.getFileByPath(path) ?? (samePath ? localByPath.get(path) : undefined);
    if (!currentLocalFile) {
      const remoteUnchanged = toBase64(remoteItem.contentHashBlinded) === record.lastContentHashBlinded;
      if (isMarkerPath(path)) {
        // The marker is a dot-file Obsidian never indexes. Its folder being gone means the folder was deleted here.
        const folderGone = remoteUnchanged && samePath && !(await this.deps.fs.existsOnDisk(parentOf(path)));
        if (folderGone && missingMode === "hold") return;
        if (folderGone && missingMode === "delete") {
          await this.deleteRemote(record);
        } else {
          await this.downloadFile(remoteItem, path);
        }
        return;
      }
      const twin = this.deps.fs.getFileByPathIgnoringCase(path);
      if (twin) {
        // The name is there written with other upper/lower case: not deleted. Two different files that differ only in
        // case cannot live side by side here; `placeLocally` settles that on the next run (one becomes a conflict copy).
        const owner = await this.deps.localIndex.getByPath(twin.path);
        if (!owner || owner.fileId === record.fileId) {
          await this.deps.localIndex.put({ ...record, localPath: twin.path });
          await this.reconcileExisting(remoteItem, twin.path, twin);
        } else {
          await this.settleCaseClash(remoteItem, record, path, owner, twin);
        }
        return;
      }
      if (await this.deps.fs.existsOnDisk(path)) {
        // On disk but not in Obsidian's index (unknown extension): only fetch it when another device changed it.
        if (!remoteUnchanged) await this.downloadFile(remoteItem, path, "remote");
        return;
      }
      if (remoteUnchanged && samePath && missingMode === "hold") return; // waiting for the answer to the question
      if (remoteUnchanged && samePath && missingMode === "delete") {
        // Deleted here while the plugin was not running, and nobody changed it since: the delete goes to the server.
        await this.deleteRemote(record);
        return;
      }
      // Changed on another device since the last sync (that edit wins over the delete), or renamed remotely: restore it.
      await this.downloadFile(remoteItem, path, "restored");
      return;
    }

    await this.reconcileExisting(remoteItem, path, currentLocalFile);
  }

  // ============================================================
  // Incremental poll (picks up changes made by other devices since
  // `currentGlobalVersion`)
  // ============================================================

  private async doIncrementalPoll(): Promise<void> {
    await this.sendPendingRenames();
    const since = this.currentGlobalVersion;
    const remoteResp = await this.deps.remote.listFiles(this.deps.vaultId, since, true);
    // Oldest first, and the cursor follows item by item: if one of them throws, everything after it is still ahead of
    // the cursor and gets fetched again by the next poll instead of being skipped for good.
    const changes = [...remoteResp.files].sort((a, b) => a.version - b.version);
    await this.announceRemoteChanges(changes);
    // A file whose new place is still taken by another file of the same batch (two notes swapped names, a note took a
    // freed name) waits until the rest of the batch has moved out of the way, then gets another try.
    const deferred: DecodedFileListItem[] = [];
    let held = false;
    for (const item of changes) {
      const itemPath = item.isDeleted ? undefined : await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce).catch(() => undefined);
      const before = deferred.length;
      const done = await this.attempt(item.id, itemPath, () => this.withFileLock(item.id, () => this.applyRemoteChange(item, deferred)));
      if (deferred.length > before) held = true;
      if (done && !held) this.bumpGlobalVersion(item.version);
    }
    if (deferred.length > 0) {
      const wants: Array<{ fileId: string; target: string }> = [];
      for (const item of deferred) {
        const target = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce).catch(() => null);
        if (target) wants.push({ fileId: item.id, target });
      }
      await this.unblockSwaps(wants);
    }
    // Retried while that frees places (each move can free the name another file waits for); what is still blocked then
    // is a real clash and settled for good (it keeps its name).
    let pendingItems = deferred;
    for (let round = 0; round < 5 && pendingItems.length > 0; round++) {
      const again: DecodedFileListItem[] = [];
      for (const item of pendingItems) {
        const itemPath = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce).catch(() => undefined);
        await this.attempt(item.id, itemPath, () => this.withFileLock(item.id, () => this.applyRemoteChange(item, again)));
      }
      const progress = again.length < pendingItems.length;
      pendingItems = again;
      if (!progress) break;
    }
    for (const item of pendingItems) {
      const itemPath = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce).catch(() => undefined);
      await this.attempt(item.id, itemPath, () => this.withFileLock(item.id, () => this.applyRemoteChange(item, null)));
    }
    if (held && this.runFailures === 0) for (const item of changes) this.bumpGlobalVersion(item.version);
    // A change that could not be applied must be fetched again, and the others after it come with it: back to where this poll began.
    if (this.runFailures > 0) this.currentGlobalVersion = since;
    else this.bumpGlobalVersion(remoteResp.currentVersion);
  }

  /** Several files changed elsewhere: they show as waiting circles until they are downloaded. */
  private async announceRemoteChanges(changes: DecodedFileListItem[]): Promise<void> {
    const tracker = this.deps.transfers;
    if (!tracker || changes.length < 3) return;
    const paths: string[] = [];
    for (const item of changes) {
      if (item.isDeleted) continue;
      try {
        const path = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce);
        if (!isMarkerPath(path) && !this.deps.isConfigPath(path)) paths.push(path);
      } catch {
        // reported when the file itself is handled
      }
    }
    tracker.queue(paths);
  }

  /** `deferred`: where an item goes whose place is taken for now (null = last try, settle it now). */
  private async applyRemoteChange(item: DecodedFileListItem, deferred: DecodedFileListItem[] | null = null): Promise<void> {
    const record = await this.deps.localIndex.get(item.id);

    if (item.isDeleted) {
      if (record) {
        const localFile = this.deps.fs.getFileByPath(record.localPath);
        if (isMarkerPath(record.localPath)) {
          await this.applyRemoteDelete(item.id, record.localPath);
        } else if (!localFile) {
          await this.deps.localIndex.delete(item.id);
          await this.deps.fs.pruneEmptyParents(record.localPath); // the file is gone already, but its folder may be left empty
        } else if (await this.remoteDeleteWins(record, localFile)) {
          await this.applyRemoteDelete(item.id, record.localPath);
        } else {
          await this.uploadFile(localFile, item.id, undefined, "restored", record.lastContentHashBlinded); // edited here after the last sync: the edit beats the delete
        }
      }
      this.bumpGlobalVersion(item.version);
      return;
    }

    let path: string;
    try {
      path = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce);
    } catch (err) {
      console.error(`Syncstone: Pfad für Datei ${item.id} konnte nicht entschlüsselt werden - übersprungen.`, err);
      return;
    }
    if (this.deps.isConfigPath(path)) return;

    const placed = await this.placeLocally(item, record, path, deferred !== null);
    if (placed === null) {
      deferred?.push(item);
      return;
    }
    path = placed;

    const localFile = this.deps.fs.getFileByPath(path);
    if (!localFile) {
      // The note may be here written with other upper/lower case (made here and not sent yet, for example): then it is
      // the same note, compared and merged, never overwritten.
      const twin = this.deps.fs.getFileByPathIgnoringCase(path);
      if (twin) {
        const owner = await this.deps.localIndex.getByPath(twin.path);
        if (owner && owner.fileId !== item.id) {
          const placedAt = await this.settleCaseClash(item, record, path, owner, twin);
          if (!this.deps.fs.getFileByPath(placedAt)) await this.downloadFile(item, placedAt, "new");
          return;
        }
        await this.reconcileExisting(item, twin.path, twin);
        const current = await this.deps.localIndex.get(item.id);
        if (current?.localPath === twin.path && twin.path !== path && (await this.moveLocal(twin.path, path))) {
          await this.deps.localIndex.put({ ...current, localPath: path });
        }
        return;
      }
      await this.downloadFile(item, path, record ? "restored" : "new");
      return;
    }
    await this.reconcileExisting(item, path, localFile);
  }

  // ============================================================
  // Where a remote file lives locally
  // ============================================================

  /**
   * Finds the local place for file `item` that the server says lives at `serverPath`, moving this device's copy there
   * when another device renamed it. The rule that keeps contents in their own file: a local file is only ever treated
   * as `item` when nothing says it is a different file. A place taken by another file is never touched:
   *  - `mayDefer`: returns null so the caller can retry after the rest of the batch (swapped names);
   *  - otherwise this device's copy keeps its current name (or, if it has none yet, gets a free name next to the taken
   *    one) and the server is told that name, so all devices agree again.
   * Returns the local path to use for `item`.
   */
  private async placeLocally(
    item: DecodedFileListItem,
    record: LocalIndexRecord | undefined,
    serverPath: string,
    mayDefer: boolean,
  ): Promise<string | null> {
    const from = record && record.localPath !== serverPath ? record.localPath : null;
    const haveLocalCopy = from !== null && (await this.isOurs(from, item.id)) && (await this.deps.fs.existsOnDisk(from));

    // Another file of the vault already has this name written with other upper/lower case.
    const twin = this.deps.fs.getFileByPathIgnoringCase(serverPath);
    if (twin && twin.path !== serverPath && !(from !== null && twin.path.toLowerCase() === from.toLowerCase())) {
      const owner = await this.deps.localIndex.getByPath(twin.path);
      if (owner && owner.fileId !== item.id) return this.settleCaseClash(item, record, serverPath, owner, twin);
    }

    if (await this.isFreeFor(serverPath, item)) {
      if (!haveLocalCopy || !record || from === null) return serverPath;
      if (await this.moveLocal(from, serverPath)) {
        await this.deps.localIndex.put({ ...record, localPath: serverPath });
        if (!isMarkerPath(serverPath)) this.deps.log?.add({ kind: "rename-down", path: serverPath, args: [from] });
        this.deps.transfers?.clearFailure(from);
        return serverPath;
      }
    }

    // The place is taken by another file.
    if (mayDefer) return null;
    if (haveLocalCopy && from !== null) {
      // Only the upper/lower case differs: the server's spelling stays (all other devices use it); this device keeps
      // its spelling for now and takes the server's with the next sync, instead of the two renaming each other back.
      if (from.toLowerCase() === serverPath.toLowerCase()) return from;
      console.warn(`Syncstone: "${serverPath}" ist hier schon belegt - "${from}" behält seinen Namen.`);
      await this.renameRemote(item.id, from);
      return from;
    }
    const alternative = await this.freeSiblingPath(serverPath);
    console.warn(`Syncstone: "${serverPath}" ist hier schon belegt - die Datei kommt nach "${alternative}".`);
    await this.renameRemote(item.id, alternative);
    return alternative;
  }

  /**
   * Files that wait for each other's names (two notes swapped names elsewhere): none can move while the other still sits
   * there. Each one whose wanted name is held only by another waiting file is parked under a free name first; the
   * retry then moves them all to their places. A file whose name is held by anything else stays where it is.
   */
  private async unblockSwaps(wants: Array<{ fileId: string; target: string }>): Promise<void> {
    const waiting = new Set(wants.map((want) => want.fileId));
    for (const { fileId, target } of wants) {
      const owners = await this.deps.localIndex.getAllByPath(target);
      if (owners.length === 0 || !owners.every((owner) => owner.fileId !== fileId && waiting.has(owner.fileId))) continue;
      await this.withFileLock(fileId, async () => {
        const record = await this.deps.localIndex.get(fileId);
        if (!record || !(await this.deps.fs.existsOnDisk(record.localPath))) return;
        const parked = await this.freeSiblingPath(record.localPath);
        if (await this.moveLocal(record.localPath, parked)) await this.deps.localIndex.put({ ...record, localPath: parked });
      });
    }
  }

  /** True if nothing at `path` stands for a file other than `item` (nothing there, or it is `item` itself). */
  private async isFreeFor(path: string, item: DecodedFileListItem): Promise<boolean> {
    // The file's own place, maybe written with other upper/lower case: free (a rename that only changes the case).
    const own = await this.deps.localIndex.get(item.id);
    if (own && own.localPath.toLowerCase() === path.toLowerCase()) return true;
    if (!(await this.deps.fs.existsOnDisk(path))) return true;
    const owners = await this.deps.localIndex.getAllByPath(path);
    if (owners.length > 0) return owners.every((owner) => owner.fileId === item.id);
    // A file the sync does not know yet. For a file that is new to this device too, that is the usual "same note on both
    // sides" case: they are compared and, if different, merged or the losing side kept as a conflict copy. For a file
    // this device already has elsewhere, it is a different file unless the content is identical.
    if (!(await this.deps.localIndex.get(item.id))) return true;
    const local = this.deps.fs.getFileByPath(path);
    if (!local) return false;
    const bytes = await this.readLocal(local);
    if (!bytes) return true; // gone meanwhile: the place is free
    return toBase64(await this.deps.crypto.hashContent(bytes)) === toBase64(item.contentHashBlinded);
  }

  /** True if no other index record claims `path`. */
  private async isOurs(path: string, fileId: string): Promise<boolean> {
    return (await this.deps.localIndex.getAllByPath(path)).every((owner) => owner.fileId === fileId);
  }

  /** Moves a file because another device renamed it; the vault's rename event for it is recognised as ours. */
  private async moveLocal(oldPath: string, newPath: string): Promise<boolean> {
    if (await this.renameOwn(oldPath, newPath).catch(() => false)) return true;
    if (oldPath === newPath || oldPath.toLowerCase() !== newPath.toLowerCase()) return false;
    // Only the upper/lower case changes, and that was refused (some systems take the new name for the old file): done
    // in two steps, through a short-lived name of its own.
    const dot = newPath.lastIndexOf(".");
    const slash = newPath.lastIndexOf("/");
    const ext = dot > slash + 1 ? newPath.slice(dot) : "";
    const temp = `${newPath.slice(0, newPath.length - ext.length)} (renaming ${crypto.randomUUID().slice(0, 6)})${ext}`;
    if (!(await this.renameOwn(oldPath, temp).catch(() => false))) return false;
    if (await this.renameOwn(temp, newPath).catch(() => false)) return true;
    await this.renameOwn(temp, oldPath).catch(() => false); // put back
    return false;
  }

  /** One rename this engine makes itself; the vault's rename event for it is recognised as ours (see `ownRenames`). */
  private async renameOwn(oldPath: string, newPath: string): Promise<boolean> {
    this.ownRenames.set(newPath, oldPath);
    try {
      return await this.deps.fs.renamePath(oldPath, newPath);
    } finally {
      // The event normally arrives during the move; drop a leftover entry so a later real rename is not swallowed.
      window.setTimeout(() => {
        if (this.ownRenames.get(newPath) === oldPath) this.ownRenames.delete(newPath);
      }, 2000);
    }
  }

  private async renameRemote(fileId: string, path: string): Promise<void> {
    try {
      const encryptedPath = await this.deps.crypto.encryptPath(path);
      await this.deps.remote.renameFile(this.deps.vaultId, fileId, encryptedPath.ciphertext, encryptedPath.iv);
    } catch (err) {
      // Not fatal: this device keeps its name for now, and the next full sync reports it again.
      console.warn(`Syncstone: neuer Name "${path}" konnte nicht an den Server gemeldet werden`, err);
    }
  }

  /**
   * Two files of the vault whose names differ only in upper/lower case (made on a device that allows that, or before
   * this check existed). Obsidian cannot have both under that name, so one of them becomes a conflict copy on every
   * device. Which one is decided the same way everywhere (the one with the greater id), so all devices agree.
   * Returns where `item` lives here now.
   */
  private async settleCaseClash(
    item: DecodedFileListItem,
    record: LocalIndexRecord | undefined,
    serverPath: string,
    owner: LocalIndexRecord,
    twin: TFile,
  ): Promise<string> {
    if (item.id > owner.fileId) {
      // This one moves aside: fetched (or kept) under a conflict name, and every device is told that name.
      const alternative = await this.conflictPathFor(serverPath);
      const ownCopy = record && record.localPath !== twin.path ? this.deps.fs.getFileByPath(record.localPath) : null;
      if (ownCopy && (await this.moveLocal(ownCopy.path, alternative))) {
        await this.deps.localIndex.put({ ...(record as LocalIndexRecord), localPath: alternative });
      } else {
        await this.downloadFile(item, alternative, "new");
      }
      await this.renameRemote(item.id, alternative);
      this.deps.log?.add({ kind: "conflict", path: serverPath, args: [alternative] });
      return alternative;
    }
    // The other one moves aside, this one takes the name.
    await this.withFileLock(owner.fileId, async () => {
      const alternative = await this.conflictPathFor(twin.path);
      if (await this.moveLocal(twin.path, alternative)) {
        await this.deps.localIndex.put({ ...owner, localPath: alternative });
        await this.renameRemote(owner.fileId, alternative);
        this.deps.log?.add({ kind: "conflict", path: twin.path, args: [alternative] });
      }
    });
    return serverPath;
  }

  /** `Folder/Note.md` -> `Folder/Note (conflict 2026-11-13 21-04).md`, the first such name that is free here. */
  private async conflictPathFor(path: string): Promise<string> {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const base = dot > slash + 1 ? path.slice(0, dot) : path;
    const ext = path.slice(base.length);
    const stamp = conflictStamp();
    let candidate = `${base} (conflict ${stamp})${ext}`;
    for (let counter = 2; (await this.deps.fs.existsOnDisk(candidate)) || this.deps.fs.getFileByPathIgnoringCase(candidate); counter++) {
      candidate = `${base} (conflict ${stamp} ${counter})${ext}`;
    }
    return candidate;
  }

  /** `Folder/Note.md` -> `Folder/Note 2.md` (the first name that is free here). */
  private async freeSiblingPath(path: string): Promise<string> {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const hasExt = dot > slash + 1;
    const stem = hasExt ? path.slice(0, dot) : path;
    const ext = hasExt ? path.slice(dot) : "";
    for (let n = 2; ; n++) {
      const candidate = `${stem} ${n}${ext}`;
      if (!(await this.deps.fs.existsOnDisk(candidate)) && (await this.deps.localIndex.getAllByPath(candidate)).length === 0) return candidate;
    }
  }

  /**
   * Earlier versions could leave two index records on one path. Neither may then be trusted with the file there: the
   * one the server also places at that path keeps it, the others are forgotten and handled like files this device has
   * not seen yet (they are fetched to their own place). Returns the records that remain.
   */
  private async repairDuplicatePaths(records: LocalIndexRecord[], remoteById: Map<string, DecodedFileListItem>): Promise<LocalIndexRecord[]> {
    const byPath = new Map<string, LocalIndexRecord[]>();
    for (const record of records) byPath.set(record.localPath, [...(byPath.get(record.localPath) ?? []), record]);
    const dropped = new Set<string>();
    for (const [path, group] of byPath) {
      if (group.length < 2) continue;
      const keepers: LocalIndexRecord[] = [];
      for (const record of group) {
        const remote = remoteById.get(record.fileId);
        if (!remote || remote.isDeleted) continue;
        try {
          if ((await this.deps.crypto.decryptPath(remote.pathCiphertext, remote.pathNonce)) === path) keepers.push(record);
        } catch {
          // unreadable path: not a keeper
        }
      }
      const keep = keepers.length === 1 ? keepers[0].fileId : null;
      console.warn(`Syncstone: ${group.length} Index-Einträge für "${path}" - werden neu zugeordnet.`);
      for (const record of group) {
        if (record.fileId === keep) continue;
        dropped.add(record.fileId);
        await this.deps.localIndex.delete(record.fileId);
      }
    }
    return records.filter((record) => !dropped.has(record.fileId));
  }

  // ============================================================
  // Shared reconciliation / transfer primitives
  // ============================================================

  /**
   * --- Conflict resolution policy ---
   * Both a local file and a remote (non-deleted) file exist for the same
   * path/fileId. If their content hashes already match, there's nothing to
   * do. Otherwise content differs on at least one side since the last sync:
   * there is no merge UI and no `expected_version` check anywhere in this
   * codebase. If the local index remembers what was synced last, a side that
   * did not change since then never overwrites the one that did. Only when both
   * changed (or nothing is known) does the strictly newer timestamp win, and
   * the other side is silently overwritten. Ties (identical millisecond
   * timestamps) favor the remote side, arbitrarily but deterministically.
   * Exception: for Markdown/text notes both-changed is first tried as a three-way merge against the text of the last
   * sync (`LocalIndex` keeps it), see `tryMerge`. Only when that cannot combine the edits does the newer side win -
   * and the other one is then saved as a conflict copy next to the note instead of being thrown away.
   */
  private async reconcileExisting(item: DecodedFileListItem, path: string, localFile: TFile, rechecked = false): Promise<void> {
    const localBytes = await this.readLocal(localFile);
    if (!localBytes) return; // deleted while the sync was busy: the delete event takes care of it
    const localHash = await this.deps.crypto.hashContent(localBytes);
    const localHashBase64 = toBase64(localHash);
    const remoteHashBase64 = toBase64(item.contentHashBlinded);

    if (localHashBase64 === remoteHashBase64) {
      // Both sides already agree on content - just refresh bookkeeping.
      await this.deps.localIndex.put({
        fileId: item.id,
        localPath: path,
        lastKnownVersion: item.version,
        lastContentHashBlinded: remoteHashBase64,
        lastSyncedAt: new Date().toISOString(),
      });
      await this.rememberBase(item.id, path, localBytes, localHashBase64);
      this.bumpGlobalVersion(item.version);
      return;
    }

    // What both sides looked like at the last sync tells who actually changed something. Timestamps alone are wrong
    // here: a rename on another device bumps the server's `updatedAt` without touching the content and would make
    // that side "newer" than a local edit that was not uploaded yet, and the clocks of the devices are not in step.
    const lastHash = (await this.deps.localIndex.get(item.id))?.lastContentHashBlinded;
    let remoteWins: boolean;
    if (lastHash === remoteHashBase64) remoteWins = false; // the server content is the one we last synced: only the local side changed
    else if (lastHash === localHashBase64) remoteWins = true; // the local file is the one we last synced: only the remote side changed
    else remoteWins = this.isRemoteNewer(item.updatedAt, this.deps.fs.getMtime(localFile)); // both changed (or no history): newer wins

    const bothChanged = lastHash !== remoteHashBase64 && lastHash !== localHashBase64;
    const live = this.deps.isCollabLive?.(item.id) ?? false;
    if (live) {
      await this.reconcileLive(item, path, localBytes, lastHash);
      return;
    }
    let copied = false;
    if (bothChanged && !live && isMergeablePath(path)) {
      const outcome = await this.tryMerge(item, path, localFile, localBytes, lastHash, remoteWins);
      if (outcome === "merged") return;
      copied = outcome === "copied";
    }

    if (remoteWins) {
      if (live) return; // the live session already carries this content
      // The note may be open with typing that is not saved yet: saved first, and if that changed it, compared again
      // (merged or kept as a copy) instead of overwritten.
      if (!rechecked && (await this.deps.saveOpenEditor?.(path))) {
        const now = await this.readLocal(localFile);
        if (now && toBase64(await this.deps.crypto.hashContent(now)) !== localHashBase64) {
          await this.reconcileExisting(item, path, localFile, true);
          return;
        }
      }
      // Both sides changed and this device's version loses: it must not just vanish. (A losing server version stays in
      // the version history; a losing local one exists nowhere else.) Notes that could be merged were handled above;
      // this covers everything else - images, PDFs, notes too large or not readable as text.
      const willDownload = !(Platform.isMobile && item.contentSize > this.mobileLimit());
      if (bothChanged && !copied && willDownload) await this.saveConflictCopy(path, localBytes);
      await this.downloadFile(item, path, bothChanged ? "newer" : "remote");
    } else {
      // Both sides changed and the server's version loses: it is kept next to the note as a copy (for notes that could
      // not be merged this happened above already), so the other device's work does not just disappear from the vault.
      if (bothChanged && !copied && !(Platform.isMobile && item.contentSize > this.mobileLimit())) {
        await this.saveConflictCopy(path, await this.fetchRemotePlaintext(item));
      }
      await this.uploadFile(localFile, item.id, { plaintext: localBytes, hash: localHash }, bothChanged ? "newer" : "local", remoteHashBase64);
    }
  }

  /**
   * A note that is co-edited live here, and the server has other content than this device. The editors in the session
   * all show the same text, and only the host writes it (see `isCollabWriter`). If the server's content is what was
   * synced last, only the session changed it: the host sends the session's text. Otherwise a device outside the session
   * changed the note: the host merges that edit into the session (or, if the two overlap, keeps the server's version as
   * a copy) instead of overwriting it, and from then on writes on top of the server's version.
   */
  private async reconcileLive(item: DecodedFileListItem, path: string, localBytes: Uint8Array, lastHash: string | undefined): Promise<void> {
    if (!(this.deps.isCollabWriter?.(item.id) ?? true)) return; // the host takes care of it
    const remoteHash = toBase64(item.contentHashBlinded);
    const file = this.deps.fs.getFileByPath(path);
    if (!file) return;
    if (lastHash === remoteHash) {
      // Only the session changed it: send what is saved (the editor saves newer typing a moment later, sent the same way).
      await this.uploadFile(file, item.id, { plaintext: localBytes, hash: await this.deps.crypto.hashContent(localBytes) }, "local", remoteHash);
      return;
    }
    if (!this.deps.mergeIntoLive) return;
    const remoteBytes = await this.fetchRemotePlaintext(item);
    const remoteText = decodeText(remoteBytes);
    if (remoteText === null) return;
    // Merged against the editor's text, not the file: the file lags behind what is being typed right now.
    const base = lastHash ? await this.deps.localIndex.getBase(item.id).catch(() => undefined) : undefined;
    const outcome = base && base.hash === lastHash ? await this.deps.mergeIntoLive(item.id, base.text, remoteText) : null;
    if (outcome === false) {
      // The session ended a moment ago: compared like any other file. Still live but the editor is not ready: tried again.
      if (this.deps.isCollabLive?.(item.id)) throw new Error(t("p.fail.changedMeanwhile"));
      await this.reconcileExisting(item, path, file);
      return;
    }
    if (outcome === null) await this.saveConflictCopy(path, remoteText);
    // The session now builds on the server's version: that is the base of the next write.
    await this.deps.localIndex.put({
      fileId: item.id,
      localPath: path,
      lastKnownVersion: item.version,
      lastContentHashBlinded: remoteHash,
      lastSyncedAt: new Date().toISOString(),
    });
    await this.rememberBase(item.id, path, remoteBytes, remoteHash);
    this.bumpGlobalVersion(item.version);
    if (outcome !== null) this.deps.log?.add({ kind: "merged", path });
    // The editor saves the session's text a moment later; then it is compared with the server's version and sent.
    this.handleLocalEvent("modify", file);
  }

  /** Remembers the text of a small note as the merge base for its next conflict (best effort - merging just stays off without it). */
  private async rememberBase(fileId: string, path: string, plaintext: Uint8Array, hashBase64: string): Promise<void> {
    if (!isMergeablePath(path) || plaintext.byteLength > MERGE_MAX_BYTES) {
      await this.deps.localIndex.deleteBase(fileId).catch(() => undefined);
      return;
    }
    const text = decodeText(plaintext);
    try {
      if (text === null) await this.deps.localIndex.deleteBase(fileId);
      else await this.deps.localIndex.putBase({ fileId, hash: hashBase64, text });
    } catch (err) {
      console.warn("Syncstone: Merge-Basis konnte nicht gespeichert werden", err);
    }
  }

  private async fetchRemotePlaintext(item: DecodedFileListItem): Promise<Uint8Array> {
    const blob = await this.deps.remote.downloadBlob(this.deps.vaultId, item.id, item.contentSize);
    const { ciphertext, iv } = unpackBlob(blob);
    return this.deps.crypto.decryptContent(ciphertext, iv);
  }

  /**
   * Both sides edited a note since the last sync. With the text of that sync as common ancestor the two edits are merged
   * (and the result written here and uploaded), so nothing is lost. Without an ancestor, or when the same lines were
   * changed differently, nothing is merged: the loser of the timestamp rule is then saved as a conflict copy and `false`
   * is returned so the caller applies the usual "newer wins".
   */
  private async tryMerge(
    item: DecodedFileListItem,
    path: string,
    localFile: TFile,
    localBytes: Uint8Array,
    lastHash: string | undefined,
    remoteWins: boolean,
  ): Promise<"merged" | "copied" | "none"> {
    if (localBytes.byteLength > MERGE_MAX_BYTES || item.contentSize > MERGE_MAX_BYTES) return "none";
    let remoteBytes: Uint8Array;
    try {
      remoteBytes = await this.fetchRemotePlaintext(item);
    } catch (err) {
      console.warn("Syncstone: Server-Version für den Merge nicht ladbar", err);
      return "none";
    }
    const localText = decodeText(localBytes);
    const remoteText = decodeText(remoteBytes);
    if (localText === null || remoteText === null) return "none";

    const base = lastHash ? await this.deps.localIndex.getBase(item.id).catch(() => undefined) : undefined;
    const merged = base && base.hash === lastHash ? merge3(base.text, localText, remoteText) : containingText(localText, remoteText);

    if (merged === null) {
      await this.saveConflictCopy(path, remoteWins ? localText : remoteText);
      return "copied";
    }
    if (merged === remoteText) {
      await this.downloadFile(item, path, "newer");
    } else if (merged === localText) {
      await this.uploadFile(localFile, item.id, { plaintext: localBytes, hash: await this.deps.crypto.hashContent(localBytes) }, "newer", toBase64(item.contentHashBlinded));
    } else {
      const bytes = textEncoder.encode(merged);
      await this.deps.fs.writeBinary(path, bytes);
      const file = this.deps.fs.getFileByPath(path) ?? localFile;
      await this.uploadFile(file, item.id, { plaintext: bytes, hash: await this.deps.crypto.hashContent(bytes) }, "newer", toBase64(item.contentHashBlinded));
      new Notice(t("merge.merged", { path }), 8000);
      this.deps.log?.add({ kind: "merged", path });
    }
    return "merged";
  }

  /** Puts the text that is about to lose against the other version next to the note (it syncs like any new note). */
  private async saveConflictCopy(path: string, content: string | Uint8Array): Promise<void> {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const base = dot > slash + 1 ? path.slice(0, dot) : path;
    const ext = path.slice(base.length);
    const stamp = conflictStamp();
    let candidate = `${base} (conflict ${stamp})${ext}`;
    for (let counter = 2; await this.deps.fs.existsOnDisk(candidate); counter++) {
      candidate = `${base} (conflict ${stamp} ${counter})${ext}`;
    }
    try {
      await this.deps.fs.writeBinary(candidate, typeof content === "string" ? textEncoder.encode(content) : content);
      new Notice(t("merge.conflictCopy", { path, copy: candidate }), 12_000);
      this.deps.log?.add({ kind: "conflict", path, args: [candidate] });
    } catch (err) {
      console.error("Syncstone: Konfliktkopie konnte nicht erstellt werden", err);
    }
  }

  /**
   * A file was deleted on the server but still exists here. If it is exactly what was synced last, nobody edited it, so
   * the delete is the only change and wins - whatever the timestamps say (a re-downloaded file has a fresh mtime and
   * device clocks differ). A file edited here after the last sync always beats the delete: that edit exists nowhere else
   * and deleting it would lose it for good, while bringing the file back loses nothing (it can simply be deleted again).
   */
  private async remoteDeleteWins(record: LocalIndexRecord, localFile: TFile): Promise<boolean> {
    const localBytes = await this.readLocal(localFile);
    if (!localBytes) return true; // gone here as well: nothing to weigh
    return toBase64(await this.deps.crypto.hashContent(localBytes)) === record.lastContentHashBlinded;
  }

  private isRemoteNewer(remoteUpdatedAt: string, localMtimeMs: number): boolean {
    return new Date(remoteUpdatedAt).getTime() >= localMtimeMs;
  }

  /**
   * `base`: the content (blinded hash) this write changes - what this device last had in common with the server for the
   * file, or null for a new file. If another device wrote in between, the server refuses the write and the two versions
   * are combined like any other conflict (`resolveStaleWrite`) instead of this one silently replacing the other.
   */
  private async uploadFile(
    file: TFile,
    fileId: string,
    precomputed: { plaintext: Uint8Array; hash: Uint8Array } | undefined,
    why: LogReason | undefined,
    base: string | null,
  ): Promise<void> {
    if (Platform.isMobile && file.stat.size > this.mobileLimit()) {
      this.deps.transfers?.fail(file.path, t("p.fail.tooBigMobile", { size: formatBytes(file.stat.size) }));
      if (!this.warnedOversizedIds.has(fileId)) {
        this.warnedOversizedIds.add(fileId);
        this.deps.log?.add({ kind: "skipped", path: file.path, args: [file.stat.size] });
        new Notice(
          t("p.sync.tooBigMobile", { path: file.path, size: formatBytes(file.stat.size) }),
        );
      }
      return;
    }

    // Read-only account: every write would be refused, so don't even encrypt and send. The file stays un-synced and
    // is picked up by the full sync that runs when the account can write again.
    if (this.deps.isReadOnly?.()) return;

    if (!this.deps.fs.getFileByPath(file.path)) return; // deleted before its turn came

    const transferPath = file.path;
    const startedAt = Date.now();
    this.deps.transfers?.begin(transferPath);
    let result: { version: number } | undefined;
    let hash: Uint8Array | undefined;
    let uploadedPlaintext: Uint8Array | undefined;
    let stale: DecodedFileListItem | null = null;
    try {
      const plaintext = precomputed?.plaintext ?? (await this.readLocal(file));
      if (!plaintext) return; // deleted while it was being read
      uploadedPlaintext = plaintext;
      hash = precomputed?.hash ?? (await this.deps.crypto.hashContent(plaintext));
      const encryptedContent = await this.deps.crypto.encryptContent(plaintext);
      const encryptedPath = await this.deps.crypto.encryptPath(file.path);

      result = await this.deps.remote.uploadFile(
        this.deps.vaultId,
        fileId,
        {
          pathCiphertext: encryptedPath.ciphertext,
          pathNonce: encryptedPath.iv,
          contentHashBlinded: hash,
          contentSize: plaintext.byteLength,
          contentIv: encryptedContent.iv,
          contentCiphertext: encryptedContent.ciphertext,
          editSessionId: this.touchEditSession(fileId),
          baseHash: base,
        },
        (loaded, total) => this.deps.transfers?.progress(transferPath, loaded, total),
        // A large file goes up in chunks: deleting it meanwhile ends the upload instead of sending the rest.
        () => this.goneSince(transferPath, startedAt),
      );
    } catch (err) {
      // Deleted on purpose while it was on its way (or gone before it could be read): nothing to report.
      if (err instanceof TransferCancelled || !this.deps.fs.getFileByPath(file.path)) return;
      stale = staleBaseItem(err);
      // A refused upload must not abort the whole sync run (the other files still have to go through).
      if (!stale && this.handleRefusedUpload(err, file)) return;
      if (!stale) throw err;
    } finally {
      this.deps.transfers?.end(transferPath);
    }
    if (stale) {
      await this.resolveStaleWrite(file, stale);
      return;
    }
    if (!result || !hash || !uploadedPlaintext) return;

    const record: LocalIndexRecord = {
      fileId,
      localPath: file.path,
      lastKnownVersion: result.version,
      lastContentHashBlinded: toBase64(hash),
      lastSyncedAt: new Date().toISOString(),
    };
    await this.deps.localIndex.put(record);
    this.noteOwnWrite(result.version);
    // Deleted here while it was on its way up (a small file is sent in one piece): the copy that just arrived at the server
    // goes again - the delete event found nothing to delete at the time and would otherwise never come back to it.
    if (this.goneSince(transferPath, startedAt)) {
      await this.deleteRemote(record);
      return;
    }
    this.deps.log?.add({ kind: "up", path: file.path, why, args: [uploadedPlaintext.byteLength] });
    await this.rememberBase(fileId, file.path, uploadedPlaintext, toBase64(hash));
  }

  /**
   * The server refused a write because another device changed the file after the content it was based on (409). The
   * server's version and this one are then compared and combined exactly like in a sync (merge, or keep the losing side
   * as a copy). Should that be refused again (yet another write in between), the file is simply tried again later.
   */
  private async resolveStaleWrite(file: TFile, current: DecodedFileListItem): Promise<void> {
    if (this.resolvingStale.has(current.id)) throw new Error(t("p.fail.changedMeanwhile"));
    this.resolvingStale.add(current.id);
    try {
      const local = this.deps.fs.getFileByPath(file.path);
      if (local) await this.reconcileExisting(current, file.path, local);
    } finally {
      this.resolvingStale.delete(current.id);
    }
  }

  /**
   * The server says "not this file": account read-only (402), file over the size limit or storage full (413 with a
   * `code`). Tells the user once and lets the sync carry on. Returns false for every other error.
   */
  private handleRefusedUpload(err: unknown, file: TFile): boolean {
    if (!(err instanceof SyncstoneApiError)) return false;
    const body = (err.body ?? {}) as { code?: string; maxFileBytes?: number };
    if (err.status === 402) {
      this.deps.onWriteRefused?.("read-only");
      return true;
    }
    if (err.status === 413 && body.code === "file_too_large") {
      this.deps.transfers?.fail(file.path, t("p.fail.tooBigServer", { size: formatBytes(file.stat.size), limit: formatBytes(body.maxFileBytes ?? 0) }));
      if (!this.warnedOversizedIds.has(file.path)) {
        this.warnedOversizedIds.add(file.path);
        new Notice(t("p.sync.tooBigServer", { path: file.path, size: formatBytes(file.stat.size), limit: formatBytes(body.maxFileBytes ?? 0) }), 15_000);
      }
      return true;
    }
    if (err.status === 413 && body.code === "quota_exceeded") {
      this.deps.transfers?.fail(file.path, t("p.fail.quota"));
      this.deps.onWriteRefused?.("storage-full");
      return true;
    }
    return false;
  }

  private async downloadFile(item: DecodedFileListItem, path: string, why?: LogReason): Promise<void> {
    if (isMarkerPath(path)) {
      // Folder marker: nothing to download, just make sure the (empty) folder exists here.
      await this.deps.fs.writeMarker(path);
      await this.deps.localIndex.put({
        fileId: item.id,
        localPath: path,
        lastKnownVersion: item.version,
        lastContentHashBlinded: toBase64(item.contentHashBlinded),
        lastSyncedAt: new Date().toISOString(),
      });
      this.bumpGlobalVersion(item.version);
      return;
    }

    if (Platform.isMobile && item.contentSize > this.mobileLimit()) {
      this.deps.transfers?.fail(path, t("p.fail.tooBigMobile", { size: formatBytes(item.contentSize) }));
      if (!this.warnedOversizedIds.has(item.id)) {
        this.warnedOversizedIds.add(item.id);
        this.deps.log?.add({ kind: "skipped", path, args: [item.contentSize] });
        new Notice(
          t("p.sync.tooBigMobile", { path, size: formatBytes(item.contentSize) }),
        );
      }
      return;
    }

    const startedAt = Date.now();
    this.deps.transfers?.begin(path);
    let downloaded: Uint8Array;
    try {
      const blob = await this.deps.remote.downloadBlob(
        this.deps.vaultId,
        item.id,
        item.contentSize,
        (loaded, total) => this.deps.transfers?.progress(path, loaded, total),
        () => this.deletedSince(path, startedAt),
      );
      // Deleted here (the file or its folder) while it came down: writing it now would undo that.
      if (this.deletedSince(path, startedAt)) return;
      const { ciphertext, iv } = unpackBlob(blob);
      const plaintext = await this.deps.crypto.decryptContent(ciphertext, iv);
      await this.deps.fs.writeBinary(path, plaintext);
      downloaded = plaintext;
    } catch (err) {
      if (err instanceof TransferCancelled) return;
      throw err;
    } finally {
      this.deps.transfers?.end(path);
    }
    await this.deps.localIndex.put({
      fileId: item.id,
      localPath: path,
      lastKnownVersion: item.version,
      lastContentHashBlinded: toBase64(item.contentHashBlinded),
      lastSyncedAt: new Date().toISOString(),
    });
    this.deps.log?.add({ kind: "down", path, why, args: [downloaded.byteLength] });
    await this.rememberBase(item.id, path, downloaded, toBase64(item.contentHashBlinded));
    this.bumpGlobalVersion(item.version);
  }

  private async applyRemoteDelete(fileId: string, path: string): Promise<void> {
    await this.deps.fs.deleteByPath(path);
    await this.deps.localIndex.delete(fileId);
    if (!isMarkerPath(path)) this.deps.log?.add({ kind: "delete-down", path });
    this.deps.transfers?.clearFailure(path);
  }

  private bumpGlobalVersion(version: number): void {
    if (version > this.currentGlobalVersion) this.currentGlobalVersion = version;
  }

  /**
   * The server numbers every write of the vault consecutively, so our own write may only move the cursor when it is the
   * very next number. Anything else means another device wrote in between; jumping over that version would make the next
   * poll (`since=cursor`) miss the change for good. Our own write is then simply fetched again by the next poll, where it
   * turns out to match the local file.
   */
  private noteOwnWrite(version: number): void {
    if (version === this.currentGlobalVersion + 1) this.currentGlobalVersion = version;
  }

  private async persistState(): Promise<void> {
    await this.deps.onStateChange({
      lastSyncAt: new Date().toISOString(),
      globalVersion: this.currentGlobalVersion,
    });
  }
}

/**
 * Two versions of a note without a known common ancestor (e.g. the same daily note created on two devices before they
 * synced): when one of them contains the other completely (the template on one side, the filled-in note on the other),
 * the fuller one loses nothing of either and is taken. Null otherwise.
 */
function containingText(a: string, b: string): string | null {
  const core = (text: string) => text.trim();
  if (core(b).includes(core(a))) return b;
  if (core(a).includes(core(b))) return a;
  return null;
}

/** Local date and time for conflict copies: `2026-11-13 21-04` (no colon, it is not allowed in file names everywhere). */
export function conflictStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

/** `"a/b/c"` -> `"a/b"`, `""` at the top level. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "" : path.slice(0, slash);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export type { LocalIndexRecord };

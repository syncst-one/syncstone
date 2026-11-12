/**
 * Syncs `.obsidian/*` config files (core settings, community plugins,
 * themes, snippets, hotkeys, workspace layout), with one switch per
 * category. Off by default (see `ConfigSyncSettings` in
 * types.ts).
 *
 * Deliberately a SEPARATE engine from the main `SyncEngine`, not a mode of
 * it, because config files live in a fundamentally different part of
 * Obsidian's API:
 *  - `.obsidian/**` is excluded from `vault.getFiles()` and never fires
 *    `vault.on('create'|'modify'|'delete'|'rename', ...)` events - there is
 *    no event-driven change detection available, only `adapter.list()` /
 *    `adapter.stat()` polling.
 *  - Files aren't represented as `TFile` objects, so none of the main
 *    engine's TFile-typed plumbing applies.
 * Keeping this fully isolated (own reconciliation loop, own "last synced
 * version" cursor, no shared local-index table) means it can never interact
 * with - or risk corrupting the behavior of - the already-solid note sync
 * engine. The one deliberate coupling point is that `SyncEngine` explicitly
 * skips any remote item whose decrypted path falls under the config
 * directory, so the two engines never both try to own the same file.
 *
 * FileIds for config files are derived deterministically from their path
 * (see `deterministicFileId`) rather than tracked in a local index table:
 * since config files are rarely "renamed" the way notes are, every device
 * can independently compute the same fileId for the same path without any
 * shared bookkeeping, and reconciliation becomes a live per-path compare
 * (local content hash vs. the remote item's `contentHashBlinded`) instead
 * of needing persisted per-file state.
 */
import { t } from "../i18n/index.js";
import { Notice, Platform, type App } from "obsidian";
import { MOBILE_MAX_SYNC_FILE_SIZE_BYTES, toBase64, unpackBlob } from "@websync/shared";
import type { ConfigSyncSettings } from "../types.js";
import type { CryptoService } from "./CryptoService.js";
import type { DecodedFileListItem, RemoteApiClient } from "./RemoteApiClient.js";
import type { SyncLog } from "./SyncLog.js";
import { errorArgs } from "./errorArgs.js";

type ConfigCategory = Exclude<keyof ConfigSyncSettings, "enabled" | "lastSyncedGlobalVersion" | "known">;

export interface ConfigSyncEngineDeps {
  app: App;
  vaultId: string;
  pluginDir: string;
  crypto: CryptoService;
  remote: RemoteApiClient;
  getSettings: () => ConfigSyncSettings;
  log?: SyncLog;
  onLastVersionChange: (version: number) => void | Promise<void>;
  /**
   * Settings sync meets settings on this device that differ from the server's and were never synced before (it was just
   * switched on, or a category was added). Only the user knows which side is right, so they are asked once: "local" =
   * this device's settings, "remote" = those of the other devices, null = do not sync settings (dismissed, or "don't
   * sync"). Without it the server's side is taken, as before.
   */
  chooseFirstContact?: (paths: string[]) => Promise<"local" | "remote" | null>;
  /** The user declined the question: switch back off what was just switched on (nothing has been synced yet). */
  onFirstContactDeclined?: () => void | Promise<void>;
}

/** Which side wins where both sides differ: the chosen one; for JSON settings the other side's extra entries are kept. */
type Side = "local" | "remote";

/** Category -> the `.obsidian`-relative files/folders it covers. Folders are scanned recursively. */
function categoryRoots(configDir: string): Record<ConfigCategory, string[]> {
  return {
    coreSettings: [
      `${configDir}/app.json`,
      `${configDir}/appearance.json`,
      `${configDir}/core-plugins.json`,
      `${configDir}/core-plugins-migration.json`,
      `${configDir}/graph.json`,
      `${configDir}/types.json`,
      // Templates core plugin (template folder, date/time format) - the web workspace reads it to offer "Vorlage einfügen".
      `${configDir}/templates.json`,
      // Daily notes core plugin (folder, date format, template) and the bookmarks - the web workspace has both as well.
      `${configDir}/daily-notes.json`,
      `${configDir}/bookmarks.json`,
    ],
    communityPlugins: [`${configDir}/community-plugins.json`, `${configDir}/plugins`],
    themes: [`${configDir}/themes`],
    snippets: [`${configDir}/snippets`],
    hotkeys: [`${configDir}/hotkeys.json`],
    workspace: [`${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`],
  };
}

export class ConfigSyncEngine {
  private syncing = false;
  private readonly configDir: string;
  private readonly warnedOversizedPaths = new Set<string>();
  /**
   * The remote list is only a delta (`since` = cursor), so "not in the list" means "unchanged remotely", not "new". To
   * tell a local file that really needs uploading from one that is simply in sync, remember the modification time each
   * file had when it was last reconciled; a file whose mtime still matches is left alone.
   */
  private readonly reconciledMtimes = new Map<string, number>();
  /** The first run of a session, and every run after the set of synced categories changed, compares against the whole remote list. */
  private fullyListed = false;
  private lastRootsKey = "";
  /** The answer to the first-contact question, used by the next run and then cleared. */
  private firstContactChoice: Side | null = null;
  private askingFirstContact = false;
  /** Declined without a way to switch settings sync off: not synced for the rest of this Obsidian session. */
  private firstContactPostponed = false;

  constructor(private readonly deps: ConfigSyncEngineDeps) {
    this.configDir = deps.app.vault.configDir;
  }

  get isSyncing(): boolean {
    return this.syncing;
  }

  async run(): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled || this.syncing || this.askingFirstContact || this.firstContactPostponed) return;

    this.syncing = true;
    try {
      await this.reconcile(settings);
    } catch (err) {
      this.deps.log?.add({ kind: "error", path: t("p.log.settingsPath"), args: errorArgs(err) });
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  private knownKey(path: string): string {
    return `${this.deps.vaultId}|${path}`;
  }

  private remember(settings: ConfigSyncSettings, path: string, hash: Uint8Array): void {
    settings.known[this.knownKey(path)] = toBase64(hash);
  }

  private forget(settings: ConfigSyncSettings, path: string): void {
    delete settings.known[this.knownKey(path)];
  }

  private async reconcile(settings: ConfigSyncSettings): Promise<void> {
    settings.known ??= {};
    const roots = categoryRoots(this.configDir);
    const enabledRootPaths = (Object.keys(roots) as ConfigCategory[])
      .filter((cat) => settings[cat])
      .flatMap((cat) => roots[cat]);

    // A category that is switched off syncs nothing on this device. What it last agreed on is forgotten, so switching it
    // on again compares from scratch (and asks if needed) instead of reading what changed meanwhile as deletions.
    const knownPrefix = `${this.deps.vaultId}|`;
    for (const key of Object.keys(settings.known)) {
      if (!key.startsWith(knownPrefix)) continue;
      const category = this.categoryFor(key.slice(knownPrefix.length), roots);
      if (!category || !settings[category]) delete settings.known[key];
    }

    const localFiles = await this.scanLocal(enabledRootPaths);

    // Without the full list a local file that is missing from the delta could be one the server already has (from
    // before this session, or from a category that was just switched on) and would be uploaded over it blindly.
    const rootsKey = enabledRootPaths.join("|");
    const fullList = !this.fullyListed || rootsKey !== this.lastRootsKey;
    const remoteResp = await this.deps.remote.listFiles(this.deps.vaultId, fullList ? 0 : settings.lastSyncedGlobalVersion, true);
    const configPrefix = `${this.configDir}/`;
    const remoteByPath = new Map<string, DecodedFileListItem>();
    for (const item of remoteResp.files) {
      let path: string;
      try {
        path = await this.deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce);
      } catch {
        continue; // not decryptable with this passphrase's key - ignore, main engine already logs a warning for its own items
      }
      if (!path.startsWith(configPrefix) || this.isOwnPluginPath(path)) continue;
      remoteByPath.set(path, item);
    }

    // Settings that differ between this device and the server and were never synced before: ask which side is right
    // before touching anything (see `chooseFirstContact`).
    const firstContact = new Set<string>();
    for (const [path, item] of remoteByPath) {
      if (item.isDeleted || settings.known[this.knownKey(path)] !== undefined || !localFiles.has(path)) continue;
      const category = this.categoryFor(path, roots);
      if (!category || !settings[category]) continue;
      const localBytes = await this.readLocal(path);
      if (!localBytes) continue; // removed meanwhile (e.g. a plugin being uninstalled): nothing to compare
      if (toBase64(await this.deps.crypto.hashContent(localBytes)) !== toBase64(item.contentHashBlinded)) firstContact.add(path);
    }
    let firstContactSide: Side = "remote";
    if (firstContact.size > 0 && this.deps.chooseFirstContact) {
      if (!this.firstContactChoice) {
        this.askFirstContact([...firstContact]);
        return; // nothing is synced until the question is answered; the answer starts the next run
      }
      firstContactSide = this.firstContactChoice;
    }
    this.firstContactChoice = null;

    const handled = new Set<string>();
    const deletedHere: Array<{ path: string; item: DecodedFileListItem | null }> = [];

    for (const [path, item] of remoteByPath) {
      handled.add(path);
      const category = this.categoryFor(path, roots);
      if (!category || !settings[category]) continue; // user turned this category off locally - leave it alone

      if (item.isDeleted) {
        const local = localFiles.get(path);
        if (!local) {
          this.reconciledMtimes.delete(path);
          this.forget(settings, path);
          continue;
        }
        // Never agreed on this file with the server: a deletion there is not ours to apply (nor is the file ours to push).
        const knownHash = settings.known[this.knownKey(path)];
        if (knownHash === undefined) continue;
        const localBytes = await this.readLocal(path);
        if (!localBytes) {
          this.reconciledMtimes.delete(path);
          this.forget(settings, path);
          continue;
        }
        // Deleted on another device. Unchanged here since the last sync: the delete is the only change and wins, whatever
        // the clocks say (as for notes). Changed here as well: the newer side wins.
        const unchangedHere = toBase64(await this.deps.crypto.hashContent(localBytes)) === knownHash;
        if (unchangedHere || this.isRemoteNewer(item.updatedAt, await this.statMtime(path))) {
          await this.deps.app.vault.adapter.remove(path).catch(() => undefined);
          await this.pruneEmptyFolders(path);
          this.reconciledMtimes.delete(path);
          this.forget(settings, path);
          this.deps.log?.add({ kind: "delete-down", path });
        } else {
          const hash = await this.uploadPath(path);
          if (hash) this.remember(settings, path, hash);
          this.reconciledMtimes.set(path, local.mtime);
        }
        continue;
      }

      const local = localFiles.get(path);
      if (!local && this.isDeletable(path) && settings.known[this.knownKey(path)] === toBase64(item.contentHashBlinded)) {
        // Synced before, gone here now, and nobody changed it since: it was deleted here (e.g. a plugin uninstalled).
        deletedHere.push({ path, item });
        continue;
      }
      await this.reconcilePath(settings, path, item, local, firstContact.has(path) ? firstContactSide : null);
    }

    // Files this device synced before that are gone here and did not change on the server (so they are not in a delta
    // list): deleted here as well. On a full list the server simply does not have them any more.
    for (const key of Object.keys(settings.known)) {
      if (!key.startsWith(knownPrefix)) continue;
      const path = key.slice(knownPrefix.length);
      if (handled.has(path) || localFiles.has(path)) continue;
      if (fullList || !this.isDeletable(path)) {
        this.forget(settings, path);
        continue;
      }
      deletedHere.push({ path, item: null });
    }
    await this.applyDeletedHere(settings, deletedHere);

    for (const [path, { mtime }] of localFiles) {
      if (handled.has(path)) continue;
      // Not in the remote list. On a full list that means the server does not have it; on a delta it only means it did
      // not change remotely, so upload it only if it changed here since it was last reconciled.
      if (!fullList && this.reconciledMtimes.get(path) === mtime) continue;
      const hash = await this.uploadPath(path);
      if (hash) this.remember(settings, path, hash);
      this.reconciledMtimes.set(path, mtime);
    }

    this.fullyListed = true;
    this.lastRootsKey = rootsKey;
    const newVersion = Math.max(settings.lastSyncedGlobalVersion, remoteResp.currentVersion);
    await this.deps.onLastVersionChange(newVersion);
  }

  private askFirstContact(paths: string[]): void {
    const ask = this.deps.chooseFirstContact;
    if (!ask) return;
    this.askingFirstContact = true;
    void ask(paths)
      .then((choice) => {
        this.askingFirstContact = false;
        if (!choice) {
          this.fullyListed = false;
          if (this.deps.onFirstContactDeclined) return this.deps.onFirstContactDeclined();
          this.firstContactPostponed = true;
          return;
        }
        this.firstContactChoice = choice;
        this.fullyListed = false; // the next run looks at everything again, with the answer
        // After the run that asked has fully finished (an immediate answer would otherwise find it still running).
        window.setTimeout(() => {
          this.run().catch((err) => console.error("Syncstone: Einstellungen konnten nicht abgeglichen werden", err));
        }, 0);
      })
      .catch((err) => {
        this.askingFirstContact = false;
        console.error("Syncstone: Einstellungen konnten nicht abgeglichen werden", err);
      });
  }

  /**
   * `firstContact`: this file differs from the server's and was never synced before; the user chose which side wins.
   */
  private async reconcilePath(
    settings: ConfigSyncSettings,
    path: string,
    item: DecodedFileListItem,
    local: { mtime: number } | undefined,
    firstContact: Side | null = null,
  ): Promise<void> {
    const remoteHash = toBase64(item.contentHashBlinded);
    if (!local) {
      if (await this.downloadPath(path, item)) settings.known[this.knownKey(path)] = remoteHash;
      return;
    }

    const localBytes = await this.readLocal(path);
    if (!localBytes) return; // removed while syncing (e.g. a plugin being uninstalled): the next run sees it as missing
    const localHash = await this.deps.crypto.hashContent(localBytes);
    const localB64 = toBase64(localHash);
    if (localB64 === remoteHash) {
      settings.known[this.knownKey(path)] = remoteHash;
      this.reconciledMtimes.set(path, local.mtime); // already in sync
      return;
    }

    // `baseline` is what this device and the server last agreed on. With it the side that changed since then is clear,
    // regardless of file times. Without it (first contact) the user's answer decides (see `chooseFirstContact`); with no
    // way to ask, the server's version is adopted rather than a fresh device overwriting the real settings.
    const baseline = settings.known[this.knownKey(path)];
    if (baseline === undefined && firstContact) {
      await this.settleBothSides(settings, path, item, localBytes, firstContact);
      return;
    }
    if (baseline !== undefined && baseline !== remoteHash && baseline !== localB64 && isJsonPath(path)) {
      // Both sides changed the same settings file: the entries are combined, this device's on top.
      await this.settleBothSides(settings, path, item, localBytes, "local");
      return;
    }
    let download: boolean;
    if (baseline === undefined) download = true;
    else if (baseline === remoteHash) download = false;
    else if (baseline === localB64) download = true;
    else download = this.isRemoteNewer(item.updatedAt, await this.statMtime(path));

    if (download) {
      if (await this.downloadPath(path, item)) settings.known[this.knownKey(path)] = remoteHash;
    } else {
      const hash = await this.uploadPath(path, localBytes, localHash);
      if (hash) this.remember(settings, path, hash);
      this.reconciledMtimes.set(path, local.mtime);
    }
  }

  /**
   * Both sides have their own version of a settings file and `winner` should win. A JSON object is combined: every entry
   * of the winner, plus the entries only the other side has; anything else is taken whole
   * from the winner. The result ends up on both sides.
   */
  private async settleBothSides(settings: ConfigSyncSettings, path: string, item: DecodedFileListItem, localBytes: Uint8Array, winner: Side): Promise<void> {
    let merged: Uint8Array | null = null;
    if (isJsonPath(path)) {
      const remoteBytes = await this.fetchRemote(item);
      if (remoteBytes) merged = mergeJsonSettings(localBytes, remoteBytes, winner);
    }
    if (!merged) {
      if (winner === "remote") {
        if (await this.downloadPath(path, item)) settings.known[this.knownKey(path)] = toBase64(item.contentHashBlinded);
      } else {
        const hash = await this.uploadPath(path, localBytes);
        if (hash) this.remember(settings, path, hash);
        this.reconciledMtimes.set(path, await this.statMtime(path));
      }
      return;
    }
    const mergedHash = await this.deps.crypto.hashContent(merged);
    if (toBase64(mergedHash) === toBase64(item.contentHashBlinded)) {
      // The combination is exactly the server's version: just take it over.
      if (await this.downloadPath(path, item)) settings.known[this.knownKey(path)] = toBase64(item.contentHashBlinded);
      return;
    }
    if (!sameBytes(merged, localBytes)) {
      await this.deps.app.vault.adapter.writeBinary(path, toArrayBuffer(merged));
      this.deps.log?.add({ kind: "settings-down", path });
    }
    const hash = await this.uploadPath(path, merged, mergedHash);
    if (hash) this.remember(settings, path, hash);
    this.reconciledMtimes.set(path, await this.statMtime(path));
  }

  private async fetchRemote(item: DecodedFileListItem): Promise<Uint8Array | null> {
    if (Platform.isMobile && item.contentSize > MOBILE_MAX_SYNC_FILE_SIZE_BYTES) return null;
    const blob = await this.deps.remote.downloadBlob(this.deps.vaultId, item.id, item.contentSize);
    const { ciphertext, iv } = unpackBlob(blob);
    return this.deps.crypto.decryptContent(ciphertext, iv);
  }

  private async uploadPath(path: string, precomputedBytes?: Uint8Array, precomputedHash?: Uint8Array): Promise<Uint8Array | null> {
    const bytes = precomputedBytes ?? (await this.readLocal(path));
    if (!bytes) return null; // removed while syncing: nothing to upload

    if (Platform.isMobile && bytes.byteLength > MOBILE_MAX_SYNC_FILE_SIZE_BYTES) {
      if (!this.warnedOversizedPaths.has(path)) {
        this.warnedOversizedPaths.add(path);
        new Notice(t("p.sync.tooBigConfig", { path }));
      }
      return null;
    }

    const hash = precomputedHash ?? (await this.deps.crypto.hashContent(bytes));
    const fileId = await deterministicFileId(this.deps.vaultId, path);
    const encryptedContent = await this.deps.crypto.encryptContent(bytes);
    const encryptedPath = await this.deps.crypto.encryptPath(path);

    await this.deps.remote.uploadFile(this.deps.vaultId, fileId, {
      pathCiphertext: encryptedPath.ciphertext,
      pathNonce: encryptedPath.iv,
      contentHashBlinded: hash,
      contentSize: bytes.byteLength,
      contentIv: encryptedContent.iv,
      contentCiphertext: encryptedContent.ciphertext,
    });
    this.deps.log?.add({ kind: "settings-up", path });
    return hash;
  }

  private async downloadPath(path: string, item: DecodedFileListItem): Promise<boolean> {
    if (Platform.isMobile && item.contentSize > MOBILE_MAX_SYNC_FILE_SIZE_BYTES) {
      if (!this.warnedOversizedPaths.has(path)) {
        this.warnedOversizedPaths.add(path);
        new Notice(t("p.sync.tooBigConfig", { path }));
      }
      return false;
    }

    const blob = await this.deps.remote.downloadBlob(this.deps.vaultId, item.id, item.contentSize);
    const { ciphertext, iv } = unpackBlob(blob);
    const plaintext = await this.deps.crypto.decryptContent(ciphertext, iv);
    await this.ensureParentDir(path);
    await this.deps.app.vault.adapter.writeBinary(path, toArrayBuffer(plaintext));
    this.reconciledMtimes.set(path, await this.statMtime(path)); // the write itself changed the mtime
    this.deps.log?.add({ kind: "settings-down", path });
    return true;
  }

  // ============================================================
  // Local filesystem helpers (raw adapter - `.obsidian/**` has no TFile representation)
  // ============================================================

  private async scanLocal(roots: string[]): Promise<Map<string, { mtime: number }>> {
    const out = new Map<string, { mtime: number }>();
    for (const root of roots) {
      await this.walk(root, out);
    }
    return out;
  }

  private async walk(path: string, out: Map<string, { mtime: number }>): Promise<void> {
    if (this.isOwnPluginPath(path)) return;
    const adapter = this.deps.app.vault.adapter;
    if (!(await adapter.exists(path))) return;

    const stat = await adapter.stat(path);
    if (!stat) return;

    if (stat.type === "file") {
      out.set(path, { mtime: stat.mtime });
      return;
    }

    const listing = await adapter.list(path);
    for (const filePath of listing.files) await this.walk(filePath, out);
    for (const folderPath of listing.folders) await this.walk(folderPath, out);
  }

  /**
   * Deletions travel only for what lives in a subfolder of the settings folder: plugins, themes, snippets. Obsidian's own
   * settings files (app.json, appearance.json, hotkeys.json, the plugin list ...) are never deleted, only changed; one
   * that is missing here comes back.
   */
  private isDeletable(path: string): boolean {
    const rest = path.slice(this.configDir.length + 1);
    return path.startsWith(`${this.configDir}/`) && rest.includes("/");
  }

  /** A plugin or theme counts once however many files it has (a snippet is one file). */
  private unitOf(path: string): string {
    const parts = path.slice(this.configDir.length + 1).split("/");
    return parts[0] === "snippets" ? parts.slice(0, 2).join("/") : parts.slice(0, 2).join("/");
  }

  /**
   * Sends the deletions made on this device to the server, so the other devices delete those files too. The same safety
   * rule as for notes: when much more is missing at once than anybody removes by hand (a moved or re-created settings
   * folder, for example), nothing is deleted and the files are fetched again instead.
   */
  private async applyDeletedHere(settings: ConfigSyncSettings, deletedHere: Array<{ path: string; item: DecodedFileListItem | null }>): Promise<void> {
    if (deletedHere.length === 0) return;
    const knownPrefix = `${this.deps.vaultId}|`;
    const trackedUnits = new Set(
      Object.keys(settings.known)
        .filter((key) => key.startsWith(knownPrefix))
        .map((key) => key.slice(knownPrefix.length))
        .filter((path) => this.isDeletable(path))
        .map((path) => this.unitOf(path)),
    );
    for (const { path } of deletedHere) trackedUnits.add(this.unitOf(path));
    const missingUnits = new Set(deletedHere.map(({ path }) => this.unitOf(path)));
    const allowed = missingUnits.size <= 3 || missingUnits.size <= trackedUnits.size / 2;

    if (!allowed) {
      console.warn(`Syncstone: ${missingUnits.size} von ${trackedUnits.size} Plugins/Themes fehlen hier auf einmal - sie werden wiederhergestellt statt überall gelöscht.`);
      for (const { path, item } of deletedHere) {
        if (item && (await this.downloadPath(path, item))) settings.known[this.knownKey(path)] = toBase64(item.contentHashBlinded);
      }
      this.fullyListed = false; // files that did not come with this list are fetched by the next, full one
      return;
    }

    for (const { path } of deletedHere) {
      try {
        await this.deps.remote.deleteFile(this.deps.vaultId, await deterministicFileId(this.deps.vaultId, path));
      } catch (err) {
        if ((err as { status?: unknown } | null)?.status !== 404) throw err; // already gone on the server: fine
      }
      this.forget(settings, path);
      this.reconciledMtimes.delete(path);
      this.deps.log?.add({ kind: "delete-up", path });
    }
  }

  /** After a file was removed because another device deleted it: drop folders that are empty now (a whole plugin). */
  private async pruneEmptyFolders(path: string): Promise<void> {
    const adapter = this.deps.app.vault.adapter;
    const stops = new Set([this.configDir, `${this.configDir}/plugins`, `${this.configDir}/themes`, `${this.configDir}/snippets`]);
    let folder = path.slice(0, path.lastIndexOf("/"));
    while (folder.startsWith(`${this.configDir}/`) && !stops.has(folder)) {
      try {
        const listing = await adapter.list(folder);
        if (listing.files.length > 0 || listing.folders.length > 0) return;
        await adapter.rmdir(folder, false);
      } catch {
        return;
      }
      folder = folder.slice(0, folder.lastIndexOf("/"));
    }
  }

  /**
   * The bytes of a local settings file, or null when it is gone by now. Plugins are installed, updated and removed while
   * the sync runs; a file that vanished between listing and reading must not abort the whole run ("File does not exist").
   */
  private async readLocal(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await this.deps.app.vault.adapter.readBinary(path));
    } catch (err) {
      if (!(await this.deps.app.vault.adapter.exists(path))) return null;
      throw err;
    }
  }

  private async statMtime(path: string): Promise<number> {
    const stat = await this.deps.app.vault.adapter.stat(path);
    return stat?.mtime ?? 0;
  }

  private async ensureParentDir(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash <= 0) return;
    const folder = path.slice(0, lastSlash);
    if (await this.deps.app.vault.adapter.exists(folder)) return;
    try {
      await this.deps.app.vault.adapter.mkdir(folder);
    } catch {
      // Ignore races (folder created concurrently) - a genuine failure surfaces on the writeBinary call right after.
    }
  }

  private isOwnPluginPath(path: string): boolean {
    return path === this.deps.pluginDir || path.startsWith(`${this.deps.pluginDir}/`);
  }

  private categoryFor(path: string, roots: Record<ConfigCategory, string[]>): ConfigCategory | null {
    for (const category of Object.keys(roots) as ConfigCategory[]) {
      for (const root of roots[category]) {
        if (path === root || path.startsWith(`${root}/`)) return category;
      }
    }
    return null;
  }

  private isRemoteNewer(remoteUpdatedAt: string, localMtimeMs: number): boolean {
    return new Date(remoteUpdatedAt).getTime() >= localMtimeMs;
  }
}

function isJsonPath(path: string): boolean {
  return path.toLowerCase().endsWith(".json");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Combines two versions of a JSON settings file: all top-level entries of `winner`'s side, plus the ones only the other
 * side has. Null when either side is not a JSON object (lists such as community-plugins.json are taken whole instead:
 * combining them would switch back on what one device switched off).
 */
export function mergeJsonSettings(localBytes: Uint8Array, remoteBytes: Uint8Array, winner: Side): Uint8Array | null {
  const parse = (bytes: Uint8Array): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const local = parse(localBytes);
  const remote = parse(remoteBytes);
  if (!local || !remote) return null;
  const merged = winner === "local" ? { ...remote, ...local } : { ...local, ...remote };
  const winnerBytes = winner === "local" ? localBytes : remoteBytes;
  const winnerObject = winner === "local" ? local : remote;
  // Nothing added from the other side: keep the winner's file exactly as it is (no reformatting).
  if (Object.keys(merged).length === Object.keys(winnerObject).length) return winnerBytes;
  return new TextEncoder().encode(JSON.stringify(merged, null, 2));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Deterministic, UUID-shaped id derived from the vault id + path, so every
 * device independently computes the same fileId for the same config path
 * without needing a shared local-index table. Not a real random UUID and
 * not a spec-compliant UUIDv5 - just SHA-256 truncated to 16 bytes with the
 * version/variant nibbles fixed up so it passes the server's `z.string().uuid()`
 * validation.
 */
async function deterministicFileId(vaultId: string, path: string): Promise<string> {
  const data = new TextEncoder().encode(`websync-config-fileid-v1:${vaultId}:${path}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

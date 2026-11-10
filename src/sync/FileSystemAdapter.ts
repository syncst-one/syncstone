import { normalizePath, TFile, TFolder, type App } from "obsidian";

/**
 * Remote paths are authored by other devices of the vault. Reject anything that could leave the vault root
 * (parent segments, absolute or drive paths, backslashes) before it reaches a write, rename or delete.
 */
export function assertInsideVault(path: string): void {
  const bad =
    path.includes("\\") ||
    path.includes("\u0000") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.split("/").some((segment) => segment === ".." || segment === ".");
  if (bad) throw new Error("Refusing a path outside the vault: " + JSON.stringify(path));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Thin wrapper around Obsidian's high-level Vault API for binary file I/O.
 * Deliberately uses `this.app.vault` (not `vault.adapter` directly, and
 * never Node's `fs`) so that:
 *  - it works identically on desktop (Electron) and mobile (Capacitor
 *    WebView), since `this.app.vault` is backed by whichever concrete
 *    adapter Obsidian chose for the current platform;
 *  - normal Obsidian bookkeeping (the file/metadata cache, other plugins'
 *    vault event listeners, the file explorer) stays consistent, which
 *    calling `vault.adapter` directly can silently bypass.
 */
export class FileSystemAdapter {
  constructor(private readonly app: App) {}

  /**
   * All files currently in the vault. `vault.getFiles()` is the idiomatic
   * Obsidian API for "every file in the vault": it reads from Obsidian's
   * already-built file index rather than manually walking the adapter, and
   * it naturally excludes the `.obsidian` config directory and Obsidian's
   * own internal bookkeeping - exactly the set of files a sync plugin like
   * this one should be syncing. (We deliberately did NOT use
   * `adapter.list()` recursively for this, which would require re-inventing
   * that exclusion logic by hand.)
   */
  listAllFiles(): TFile[] {
    return this.app.vault.getFiles();
  }

  getFileByPath(path: string): TFile | null {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    return file instanceof TFile ? file : null;
  }

  exists(path: string): boolean {
    return this.getFileByPath(path) !== null;
  }

  /** Whether anything (file or folder) is at `path` on disk - also files Obsidian does not index (dot-files, unknown extensions). */
  async existsOnDisk(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    if (!normalized || normalized === "/") return true;
    if (this.app.vault.getAbstractFileByPath(normalized)) return true;
    try {
      return await this.app.vault.adapter.exists(normalized);
    } catch {
      return true; // when in doubt, the file is still there - never turn an I/O hiccup into a delete
    }
  }

  getFolderByPath(path: string): TFolder | null {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return folder instanceof TFolder ? folder : null;
  }

  /** Empty, non-hidden folders (never the vault root) - candidates for a folder marker. */
  listEmptyFolders(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter(
        (f): f is TFolder =>
          f instanceof TFolder && !f.isRoot() && f.children.length === 0 && !f.path.split("/").some((segment) => segment.startsWith(".")),
      );
  }

  /**
   * Creates the hidden folder marker file (see FOLDER_MARKER_FILENAME) - and with it the folder - if it isn't there
   * yet. Written through the raw adapter because Obsidian's vault never indexes dot-files. Having the marker
   * physically on disk also keeps `pruneEmptyParentFolders` from removing a folder that is meant to stay.
   */
  async writeMarker(markerPath: string): Promise<void> {
    const normalized = normalizePath(markerPath);
    await this.ensureParentFolder(normalized);
    if (await this.app.vault.adapter.exists(normalized)) return;
    await this.app.vault.adapter.writeBinary(normalized, new ArrayBuffer(0));
  }

  async readBinary(file: TFile): Promise<Uint8Array> {
    const buffer = await this.app.vault.readBinary(file);
    return new Uint8Array(buffer);
  }

  async readBinaryByPath(path: string): Promise<Uint8Array | null> {
    const file = this.getFileByPath(path);
    if (!file) return null;
    return this.readBinary(file);
  }

  /** Creates or overwrites the file at `path` with `data`, creating parent folders as needed. */
  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    assertInsideVault(path);
    const normalized = normalizePath(path);
    const existing = this.getFileByPath(normalized);
    const arrayBuffer = toArrayBuffer(data);
    if (existing) {
      await this.app.vault.modifyBinary(existing, arrayBuffer);
      return;
    }
    await this.ensureParentFolder(normalized);
    try {
      await this.app.vault.createBinary(normalized, arrayBuffer);
    } catch (err) {
      // On mobile the vault index can lag behind the disk (or differ in
      // letter case), so the file exists on disk but `getFileByPath` missed
      // it. Overwrite it through the adapter instead of failing the sync.
      // The vault index picks the file up via its own file watcher, so it may
      // not be visible through `getFileByPath` yet - that is fine.
      if (!isAlreadyExistsError(err)) throw err;
      await this.app.vault.adapter.writeBinary(normalized, arrayBuffer);
    }
  }

  async deleteByPath(path: string): Promise<void> {
    assertInsideVault(path);
    const normalized = normalizePath(path);
    const file = this.getFileByPath(normalized);
    if (file) {
      // Hard delete via `vault.delete` (not `vault.trash`): the file is
      // already tombstoned server-side, so mirroring that as a real local
      // deletion - rather than moving it to Obsidian's local trash - keeps
      // both sides consistent instead of silently resurrecting it locally.
      await this.app.vault.delete(file);
    } else {
      // The file can be on disk without being a `TFile` in the vault index
      // (e.g. "Detect all file extensions" is off, so unknown extensions are
      // invisible to `vault`). Remove it through the adapter, otherwise it
      // lingers forever and keeps its folder alive.
      const adapter = this.app.vault.adapter;
      const stat = await adapter.stat(normalized);
      if (stat?.type === "file") await adapter.remove(normalized);
    }
    await this.pruneEmptyParentFolders(normalized);
  }

  /**
   * Moves the file at `oldPath` to `newPath`. Returns false when nothing was moved because something else already lives
   * at `newPath` (both stay untouched). The caller must then NOT treat the file at `newPath` as the moved one.
   * True when it was moved, or when there was nothing at `oldPath` to move.
   */
  async renamePath(oldPath: string, newPath: string): Promise<boolean> {
    assertInsideVault(oldPath);
    assertInsideVault(newPath);
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    if (normalizedOld === normalizedNew) return true;

    const file = this.getFileByPath(normalizedOld);
    if (!file) {
      // Same unindexed-file case as in `deleteByPath`.
      const adapter = this.app.vault.adapter;
      const stat = await adapter.stat(normalizedOld);
      if (stat?.type !== "file") return true;
      if (await this.isTakenBySomethingElse(normalizedOld, normalizedNew)) return false;
      await this.ensureParentFolder(normalizedNew);
      await adapter.rename(normalizedOld, normalizedNew);
      await this.pruneEmptyParentFolders(normalizedOld);
      return true;
    }

    if (await this.isTakenBySomethingElse(normalizedOld, normalizedNew)) return false;
    await this.ensureParentFolder(normalizedNew);
    try {
      await this.app.vault.rename(file, normalizedNew);
    } catch (err) {
      if (!isAlreadyExistsError(err)) throw err;
      console.warn(`Syncstone: Umbenennen von "${normalizedOld}" nach "${normalizedNew}" übersprungen - Ziel existiert bereits.`);
      return false;
    }
    await this.pruneEmptyParentFolders(normalizedOld);
    return true;
  }

  /** Something other than the file itself sits at `target` (a case-only rename on a case-insensitive disk is fine). */
  private async isTakenBySomethingElse(source: string, target: string): Promise<boolean> {
    if (source.toLowerCase() === target.toLowerCase()) return false;
    return this.existsOnDisk(target);
  }

  /**
   * Only files are synced, never folders - so when another device deletes or
   * moves the last file out of a folder, the (now empty) folder would stay
   * behind here. Walks up from `path`'s parent and removes each folder that is
   * empty on disk, stopping at the first non-empty one (or the vault root).
   * Best effort: a failure here must never fail the sync itself.
   */
  private async pruneEmptyParentFolders(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    let folderPath = parentFolderOf(path);
    while (folderPath) {
      try {
        if (await adapter.exists(folderPath)) {
          const listing = await adapter.list(folderPath);
          // Obsidian never shows these, so a folder holding nothing else looks empty to the user (and to the empty-folder
          // sync) - but it would not count as empty here and would be left behind.
          const junk = listing.files.filter((file) => OS_JUNK_FILES.has(file.slice(file.lastIndexOf("/") + 1).toLowerCase()));
          if (listing.files.length > junk.length || listing.folders.length > 0) return;
          for (const file of junk) await adapter.remove(file);
          const folder = this.app.vault.getAbstractFileByPath(folderPath);
          try {
            if (folder instanceof TFolder) await this.app.vault.delete(folder, true);
            else await adapter.rmdir(folderPath, false);
          } catch (err) {
            // The vault index can lag behind the disk (mobile) and still list a child that is already gone, which makes
            // `vault.delete` refuse. The folder is verified empty on disk above, so remove it there directly - otherwise
            // it stays behind, and the next full sync would even give it a marker and bring it back everywhere.
            if (await adapter.exists(folderPath)) {
              console.warn(`Syncstone: Ordner "${folderPath}" über den Vault nicht löschbar, entferne ihn direkt`, err);
              await adapter.rmdir(folderPath, false);
            }
          }
        }
      } catch (err) {
        console.warn(`Syncstone: leerer Ordner "${folderPath}" konnte nicht entfernt werden`, err);
        return;
      }
      folderPath = parentFolderOf(folderPath);
    }
  }

  /** Removes the folders above `path` that are empty now - for a file that was already gone, `deleteByPath` never gets that far. */
  async pruneEmptyParents(path: string): Promise<void> {
    await this.pruneEmptyParentFolders(normalizePath(path));
  }

  getMtime(file: TFile): number {
    return file.stat.mtime;
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash <= 0) return;
    const folderPath = path.slice(0, lastSlash);
    if (this.app.vault.getAbstractFileByPath(folderPath)) return;
    try {
      await this.app.vault.createFolder(folderPath);
    } catch (err) {
      // Ignore "folder already exists" races (e.g. two files landing in a
      // brand-new folder concurrently, or - on mobile - a folder that is on
      // disk but not yet / differently-cased in the vault index); rethrow
      // anything else.
      if (this.app.vault.getAbstractFileByPath(folderPath)) return;
      if (isAlreadyExistsError(err) || (await this.app.vault.adapter.exists(folderPath))) return;
      throw err;
    }
  }
}

/** Files the operating system drops into folders on its own (lower case, compared case-insensitively). */
const OS_JUNK_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/** `"a/b/c.md"` -> `"a/b"`; `""` for a top-level path. */
function parentFolderOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash <= 0 ? "" : path.slice(0, lastSlash);
}

function isAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(message);
}

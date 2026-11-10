/**
 * IndexedDB-backed mapping table {fileId -> localPath, lastKnownVersion,
 * lastContentHashBlinded, lastSyncedAt}. One database per linked vault
 * (`websync-index-${vaultId}`) so switching vaults never mixes indexes.
 *
 * Uses the raw `indexedDB` global directly rather than a dependency like
 * `idb` - it's a handful of methods, and `indexedDB` is available
 * identically in the Electron renderer and the Capacitor WebView.
 */

export interface LocalIndexRecord {
  fileId: string;
  localPath: string;
  /**
   * The file's server-side `version` as of the last successful
   * upload/download of this file. Informational/diagnostic - the actual
   * sync reconciliation (SyncEngine) decides what to do based on content
   * hash comparison and updatedAt/mtime timestamps, not this field, so a
   * temporarily-stale value here never causes incorrect sync behavior.
   */
  lastKnownVersion: number;
  /** base64-encoded HMAC-SHA256(SHA-256(plaintext), vaultHmacKey), as last uploaded/observed for this file. */
  lastContentHashBlinded: string;
  /** ISO timestamp. */
  lastSyncedAt: string;
}

const STORE_NAME = "files";
const PATH_INDEX = "by-local-path";
const BASE_STORE = "bases";
const DB_VERSION = 2;

/**
 * The text of a note as it was at the last sync (what both devices agreed on). It is the common ancestor that lets a
 * conflicting edit on two devices be merged instead of one overwriting the other. Only small text notes are kept.
 */
export interface SyncBase {
  fileId: string;
  /** Same blinded hash as `LocalIndexRecord.lastContentHashBlinded` - the base is only valid while they match. */
  hash: string;
  text: string;
}

export class LocalIndex {
  private db: IDBDatabase | null = null;

  constructor(private readonly vaultId: string) {}

  private get dbName(): string {
    return `websync-index-${this.vaultId}`;
  }

  async open(): Promise<void> {
    if (this.db) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "fileId" });
          store.createIndex(PATH_INDEX, "localPath", { unique: false });
        }
        if (!db.objectStoreNames.contains(BASE_STORE)) db.createObjectStore(BASE_STORE, { keyPath: "fileId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Syncstone: IndexedDB konnte nicht geöffnet werden."));
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private store(mode: IDBTransactionMode): IDBObjectStore {
    if (!this.db) throw new Error("Syncstone: LocalIndex ist nicht geöffnet - open() wurde nicht aufgerufen.");
    return this.db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  async get(fileId: string): Promise<LocalIndexRecord | undefined> {
    return this.request<LocalIndexRecord | undefined>(this.store("readonly").get(fileId));
  }

  /**
   * The record of the file at `localPath`. Undefined when none - and also when several records claim the same path:
   * picking one of them at random is how content used to end up in the wrong file, so an unclear case is "unknown".
   */
  async getByPath(localPath: string): Promise<LocalIndexRecord | undefined> {
    const records = await this.getAllByPath(localPath);
    if (records.length > 1) {
      console.warn(`Syncstone: ${records.length} Einträge für "${localPath}" im Index - Zuordnung unklar, wird übersprungen.`);
      return undefined;
    }
    return records[0];
  }

  /** Every record that claims `localPath` (normally zero or one). */
  async getAllByPath(localPath: string): Promise<LocalIndexRecord[]> {
    const index = this.store("readonly").index(PATH_INDEX);
    return this.request<LocalIndexRecord[]>(index.getAll(localPath));
  }

  async put(record: LocalIndexRecord): Promise<void> {
    await this.request(this.store("readwrite").put(record));
  }

  async delete(fileId: string): Promise<void> {
    await this.request(this.store("readwrite").delete(fileId));
    await this.deleteBase(fileId);
  }

  async getBase(fileId: string): Promise<SyncBase | undefined> {
    return this.request<SyncBase | undefined>(this.baseStore("readonly").get(fileId));
  }

  async putBase(base: SyncBase): Promise<void> {
    await this.request(this.baseStore("readwrite").put(base));
  }

  async deleteBase(fileId: string): Promise<void> {
    await this.request(this.baseStore("readwrite").delete(fileId));
  }

  private baseStore(mode: IDBTransactionMode): IDBObjectStore {
    if (!this.db) throw new Error("Syncstone: LocalIndex ist nicht geöffnet - open() wurde nicht aufgerufen.");
    return this.db.transaction(BASE_STORE, mode).objectStore(BASE_STORE);
  }

  async getAll(): Promise<LocalIndexRecord[]> {
    return this.request<LocalIndexRecord[]>(this.store("readonly").getAll());
  }

  private request<T>(req: IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error("Syncstone: IndexedDB-Anfrage fehlgeschlagen."));
    });
  }

  /** Permanently deletes a vault's local index database (e.g. if the user explicitly wants to purge it after unlinking). */
  static async destroy(vaultId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(`websync-index-${vaultId}`);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(request.error ?? new Error("Syncstone: IndexedDB-Datenbank konnte nicht gelöscht werden."));
      request.onblocked = () => resolve();
    });
  }
}

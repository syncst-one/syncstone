import { t } from "../i18n/index.js";
import type {
  CompleteChunkedUploadRequest,
  CreateVaultRequest,
  FileListItem,
  FileRevisionListResponse,
  FileListResponse,
  MeResponse,
  RenameDeviceRequest,
  RenameFileRequest,
  RestoreRevisionRequest,
  SessionListItem,
  StartChunkedUploadRequest,
  StartChunkedUploadResponse,
  UploadFileMeta,
  VaultDetail,
  VaultListItem,
} from "@websync/shared";
import { fromBase64, toBase64, UPLOAD_CHUNK_SIZE_BYTES, type PublishedNote, type PublishOptions } from "@websync/shared";
import type { BillingInfo } from "./billing.js";
import { apiRequest, apiRequestBinary, TransferCancelled } from "./httpClient.js";

export interface DecodedFileListItem {
  id: string;
  pathCiphertext: Uint8Array;
  pathNonce: Uint8Array;
  contentHashBlinded: Uint8Array;
  contentSize: number;
  version: number;
  isDeleted: boolean;
  updatedAt: string;
}

export interface DecodedFileListResponse {
  files: DecodedFileListItem[];
  currentVersion: number;
}

export interface UploadFilePayload {
  pathCiphertext: Uint8Array;
  pathNonce: Uint8Array;
  contentHashBlinded: Uint8Array;
  contentSize: number;
  /**
   * Sent as two separate multipart parts (not pre-concatenated via
   * `packBlob`) so the client never has to allocate one extra full-size
   * copy of a potentially large file just to combine them - the server
   * does that trivial concatenation instead, where memory isn't scarce.
   */
  contentIv: Uint8Array;
  contentCiphertext: Uint8Array;
  /** See `UploadFileMetaSchema.editSessionId` - folds a burst of saves into one history entry. */
  editSessionId?: string;
}

/** Bytes done / total of one transfer (the encrypted blob, so a bit larger than the file). */
export type TransferProgress = (loaded: number, total: number) => void;

/** Bytes `start..end` (exclusive) of `a || b`, without building the concatenation. */
function sliceOfPair(a: Uint8Array, b: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start);
  let written = 0;
  if (start < a.length) {
    const part = a.subarray(start, Math.min(end, a.length));
    out.set(part, 0);
    written = part.length;
  }
  const bStart = Math.max(0, start - a.length);
  const bEnd = end - a.length;
  if (bEnd > bStart) out.set(b.subarray(bStart, bEnd), written);
  return out;
}

export interface UploadFileResult {
  version: number;
  updatedAt: string;
}

/**
 * Typed wrapper for the /vaults... REST surface. All base64<->Uint8Array
 * conversion for the binary DTO fields happens right here, at the network
 * boundary - the rest of the plugin (SyncEngine, LocalIndex, CryptoService,
 * ...) only ever deals with Uint8Array.
 */
export class RemoteApiClient {
  constructor(
    private readonly getServerUrl: () => string,
    private readonly getSessionToken: () => string | null,
    /** This plugin's version, reported with the online check so the account's device list can show it. */
    private readonly pluginVersion?: string,
  ) {}

  private get serverUrl(): string {
    const url = this.getServerUrl();
    if (!url) throw new Error("Syncstone: Server-URL ist nicht konfiguriert.");
    return url;
  }

  private get token(): string {
    const token = this.getSessionToken();
    if (!token) throw new Error("Syncstone: nicht angemeldet.");
    return token;
  }

  /** The device name the server has stored for this plugin's session (null if it can't be found). */
  async getCurrentDeviceName(): Promise<string | null> {
    const sessions = await apiRequest<SessionListItem[]>(this.serverUrl, { path: "/sessions", token: this.token });
    return sessions.find((session) => session.current)?.deviceName ?? null;
  }

  /** Renames this device server-side (web panel + the name shown next to live cursors). */
  async renameCurrentDevice(deviceName: string): Promise<void> {
    const body: RenameDeviceRequest = { deviceName };
    await apiRequest<unknown>(this.serverUrl, { method: "PATCH", path: "/sessions/current", token: this.token, json: body });
  }

  /** The account with its storage numbers, plan state and limits (drives the storage row and the sync icon warning). */
  /** Also the device's online check: it tells the server which plugin version this device runs (stored only when it changed). */
  async getMe(): Promise<MeResponse> {
    const headers = this.pluginVersion ? { "X-Syncstone-Client": `plugin/${this.pluginVersion}` } : undefined;
    return apiRequest<MeResponse>(this.serverUrl, { path: "/auth/me", token: this.token, headers });
  }

  /** Plan and subscription of the account - hosted service only (a self-hosted server answers 404). */
  async getBilling(): Promise<BillingInfo> {
    return apiRequest<BillingInfo>(this.serverUrl, { path: "/billing", token: this.token });
  }

  /** The notes of the vault that have a public link (only the vault's owner can see and change them). */
  async listPublications(vaultId: string): Promise<PublishedNote[]> {
    return apiRequest<PublishedNote[]>(this.serverUrl, { path: `/vaults/${vaultId}/publish`, token: this.token });
  }

  /** Publishes (or refreshes) a note: `blob` is the base64 of the sealed snapshot. */
  async publishNote(vaultId: string, fileId: string, blob: string, options: PublishOptions): Promise<PublishedNote> {
    return apiRequest<PublishedNote>(this.serverUrl, { method: "PUT", path: `/vaults/${vaultId}/publish/${fileId}`, token: this.token, json: { blob, ...options } });
  }

  /** Changes expiry / password of an existing link without uploading the note again. */
  async updatePublication(vaultId: string, fileId: string, options: PublishOptions): Promise<PublishedNote> {
    return apiRequest<PublishedNote>(this.serverUrl, { method: "PATCH", path: `/vaults/${vaultId}/publish/${fileId}`, token: this.token, json: options });
  }

  async removePublication(vaultId: string, fileId: string): Promise<void> {
    await apiRequest<unknown>(this.serverUrl, { method: "DELETE", path: `/vaults/${vaultId}/publish/${fileId}`, token: this.token });
  }

  async listVaults(): Promise<VaultListItem[]> {
    return apiRequest<VaultListItem[]>(this.serverUrl, { path: "/vaults", token: this.token });
  }

  async getVaultDetail(vaultId: string): Promise<VaultDetail> {
    return apiRequest<VaultDetail>(this.serverUrl, { path: `/vaults/${vaultId}`, token: this.token });
  }

  async createVault(request: CreateVaultRequest): Promise<VaultDetail> {
    return apiRequest<VaultDetail>(this.serverUrl, {
      method: "POST",
      path: "/vaults",
      json: request,
      token: this.token,
    });
  }

  async listFiles(vaultId: string, since: number, includeDeleted = true): Promise<DecodedFileListResponse> {
    const query = new URLSearchParams({ since: String(since), include_deleted: String(includeDeleted) });
    const response = await apiRequest<FileListResponse>(this.serverUrl, {
      path: `/vaults/${vaultId}/files?${query.toString()}`,
      token: this.token,
    });
    return {
      currentVersion: response.currentVersion,
      files: response.files.map((f) => ({
        id: f.id,
        pathCiphertext: fromBase64(f.pathCiphertext),
        pathNonce: fromBase64(f.pathNonce),
        contentHashBlinded: fromBase64(f.contentHashBlinded),
        contentSize: f.contentSize,
        version: f.version,
        isDeleted: f.isDeleted,
        updatedAt: f.updatedAt,
      })),
    };
  }

  /** `shouldStop`: asked between the chunks of a large file - true ends the upload (the file was deleted meanwhile). */
  async uploadFile(vaultId: string, fileId: string, payload: UploadFilePayload, onProgress?: TransferProgress, shouldStop?: () => boolean): Promise<UploadFileResult> {
    const meta: UploadFileMeta = {
      pathCiphertext: toBase64(payload.pathCiphertext),
      pathNonce: toBase64(payload.pathNonce),
      contentHashBlinded: toBase64(payload.contentHashBlinded),
      contentSize: payload.contentSize,
      editSessionId: payload.editSessionId,
    };

    const total = payload.contentIv.length + payload.contentCiphertext.length;
    // A proxy/tunnel in front of the server caps one request body (Cloudflare: 100 MB) - large files go in chunks.
    if (total > UPLOAD_CHUNK_SIZE_BYTES) return this.uploadChunked(vaultId, fileId, meta, payload, onProgress, shouldStop);

    // Assumption (not a formally listed DTO in @websync/shared as of writing
    // this): the server's "updated file row" response to this PUT has the
    // same shape as a `FileListItem` from the list endpoint. We only read
    // `.version`/`.updatedAt` off it, so if the actual response shape ends
    // up narrower than FileListItem, only those two fields need to exist.
    onProgress?.(0, total);
    const response = await apiRequest<FileListItem>(this.serverUrl, {
      method: "PUT",
      path: `/vaults/${vaultId}/files/${fileId}`,
      token: this.token,
      multipart: [
        {
          name: "meta",
          filename: "meta.json",
          contentType: "application/json",
          data: new TextEncoder().encode(JSON.stringify(meta)),
        },
        {
          name: "iv",
          filename: "iv",
          contentType: "application/octet-stream",
          data: payload.contentIv,
        },
        {
          name: "ciphertext",
          filename: "ciphertext",
          contentType: "application/octet-stream",
          data: payload.contentCiphertext,
        },
      ],
    });
    onProgress?.(total, total);
    return { version: response.version, updatedAt: response.updatedAt };
  }

  /** Uploads the packed blob (`iv || ciphertext`) in chunks, then commits it like a normal upload. */
  private async uploadChunked(
    vaultId: string,
    fileId: string,
    meta: UploadFileMeta,
    payload: UploadFilePayload,
    onProgress?: TransferProgress,
    shouldStop?: () => boolean,
  ): Promise<UploadFileResult> {
    const total = payload.contentIv.length + payload.contentCiphertext.length;
    const start: StartChunkedUploadRequest = { fileId, size: total };
    const session = await apiRequest<StartChunkedUploadResponse>(this.serverUrl, {
      method: "POST",
      path: `/vaults/${vaultId}/uploads`,
      token: this.token,
      json: start,
    });
    try {
      onProgress?.(0, total);
      for (let index = 0; index < session.chunkCount; index++) {
        if (shouldStop?.()) throw new TransferCancelled();
        const from = index * session.chunkSize;
        const to = Math.min(total, from + session.chunkSize);
        const chunk = sliceOfPair(payload.contentIv, payload.contentCiphertext, from, to);
        // One retry per chunk: a single dropped request should not throw away everything uploaded so far.
        for (let attempt = 0; ; attempt++) {
          try {
            await apiRequest<unknown>(this.serverUrl, {
              method: "PUT",
              path: `/vaults/${vaultId}/uploads/${session.uploadId}/chunks/${index}`,
              token: this.token,
              raw: chunk,
            });
            break;
          } catch (err) {
            if (attempt >= 2) throw err;
          }
        }
        onProgress?.(to, total);
      }
      const complete: CompleteChunkedUploadRequest = { meta };
      const response = await apiRequest<FileListItem>(this.serverUrl, {
        method: "POST",
        path: `/vaults/${vaultId}/uploads/${session.uploadId}/complete`,
        token: this.token,
        json: complete,
      });
      return { version: response.version, updatedAt: response.updatedAt };
    } catch (err) {
      void apiRequest<unknown>(this.serverUrl, {
        method: "DELETE",
        path: `/vaults/${vaultId}/uploads/${session.uploadId}`,
        token: this.token,
      }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Downloads a file's encrypted blob. With `expectedSize` (the plaintext size from the file list) a large blob is
   * fetched in ranges, which gives progress and keeps each response small.
   */
  async downloadBlob(vaultId: string, fileId: string, expectedSize?: number, onProgress?: TransferProgress, shouldStop?: () => boolean): Promise<Uint8Array> {
    const path = `/vaults/${vaultId}/files/${fileId}/blob`;
    const total = expectedSize === undefined ? 0 : expectedSize + 28; // iv (12) + GCM tag (16)
    if (total <= UPLOAD_CHUNK_SIZE_BYTES) {
      const bytes = await apiRequestBinary(this.serverUrl, { path, token: this.token });
      onProgress?.(bytes.length, bytes.length);
      return bytes;
    }
    const out = new Uint8Array(total);
    onProgress?.(0, total);
    for (let from = 0; from < total; from += UPLOAD_CHUNK_SIZE_BYTES) {
      if (shouldStop?.()) throw new TransferCancelled();
      const to = Math.min(total, from + UPLOAD_CHUNK_SIZE_BYTES) - 1;
      const part = await apiRequestBinary(this.serverUrl, { path, token: this.token, headers: { Range: `bytes=${from}-${to}` } });
      if (part.length === total && from === 0) {
        // The server ignored the range and sent everything at once.
        onProgress?.(total, total);
        return part;
      }
      if (part.length !== to - from + 1) throw new Error(t("p.incompleteDownload", { got: part.length, expected: to - from + 1 }));
      out.set(part, from);
      onProgress?.(to + 1, total);
    }
    return out;
  }

  async deleteFile(vaultId: string, fileId: string): Promise<void> {
    await apiRequest<unknown>(this.serverUrl, {
      method: "DELETE",
      path: `/vaults/${vaultId}/files/${fileId}`,
      token: this.token,
    });
  }

  async renameFile(vaultId: string, fileId: string, newPathCiphertext: Uint8Array, newPathNonce: Uint8Array): Promise<void> {
    const request: RenameFileRequest = {
      newPathCiphertext: toBase64(newPathCiphertext),
      newPathNonce: toBase64(newPathNonce),
    };
    await apiRequest<unknown>(this.serverUrl, {
      method: "POST",
      path: `/vaults/${vaultId}/files/${fileId}/rename`,
      token: this.token,
      json: request,
    });
  }

  /** Version history of one file, or of the whole vault without `fileId` (newest first, paths still encrypted). */
  async getHistory(vaultId: string, fileId?: string, before?: number): Promise<FileRevisionListResponse> {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", String(before));
    const base = fileId ? `/vaults/${vaultId}/files/${fileId}/history` : `/vaults/${vaultId}/history`;
    return apiRequest<FileRevisionListResponse>(this.serverUrl, { path: `${base}?${query.toString()}`, token: this.token });
  }

  /** Encrypted blob (`iv || ciphertext`) of an older version. */
  async downloadRevision(vaultId: string, fileId: string, revisionId: string): Promise<Uint8Array> {
    return apiRequestBinary(this.serverUrl, { path: `/vaults/${vaultId}/files/${fileId}/revisions/${revisionId}/blob`, token: this.token });
  }

  /** Makes an older version current again (also brings back a deleted file, optionally under another path). */
  async restoreRevision(
    vaultId: string,
    fileId: string,
    revisionId: string,
    newPath?: { ciphertext: Uint8Array; iv: Uint8Array },
    appliedLive = false,
  ): Promise<void> {
    const body: RestoreRevisionRequest = newPath ? { pathCiphertext: toBase64(newPath.ciphertext), pathNonce: toBase64(newPath.iv) } : {};
    if (appliedLive) body.appliedLive = true;
    await apiRequest<unknown>(this.serverUrl, {
      method: "POST",
      path: `/vaults/${vaultId}/files/${fileId}/revisions/${revisionId}/restore`,
      token: this.token,
      json: body,
    });
  }
}

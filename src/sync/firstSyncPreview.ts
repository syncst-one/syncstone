import { FOLDER_MARKER_FILENAME, toBase64 } from "@websync/shared";
import type { CryptoService } from "./CryptoService.js";
import type { RemoteApiClient } from "./RemoteApiClient.js";
import type { FileSystemAdapter } from "./FileSystemAdapter.js";

/** What the first sync of this device would do, counted before anything is transferred. */
export interface FirstSyncPreview {
  remote: number;
  local: number;
  /** Same path, same content: nothing to transfer. */
  same: number;
  /** Same path, different content: the newer one wins, the older one is kept. */
  differ: number;
  download: number;
  upload: number;
}

export interface FirstSyncPreviewDeps {
  vaultId: string;
  remote: RemoteApiClient;
  crypto: CryptoService;
  fs: FileSystemAdapter;
  isConfigPath: (path: string) => boolean;
}

const isMarkerPath = (path: string): boolean => path === FOLDER_MARKER_FILENAME || path.endsWith(`/${FOLDER_MARKER_FILENAME}`);

export async function previewFirstSync(deps: FirstSyncPreviewDeps): Promise<FirstSyncPreview> {
  const local = deps.fs.listAllFiles().filter((file) => !deps.isConfigPath(file.path));
  const localByPath = new Map(local.map((file) => [file.path, file] as const));

  const list = await deps.remote.listFiles(deps.vaultId, 0, false);
  const remotePaths = new Set<string>();
  let same = 0;
  let differ = 0;
  let download = 0;
  for (const item of list.files) {
    if (item.isDeleted) continue;
    let path: string;
    try {
      path = await deps.crypto.decryptPath(item.pathCiphertext, item.pathNonce);
    } catch {
      continue; // the sync skips these as well
    }
    if (deps.isConfigPath(path) || isMarkerPath(path) || remotePaths.has(path)) continue;
    remotePaths.add(path);

    const file = localByPath.get(path);
    if (!file) {
      download++;
    } else if (file.stat.size !== item.contentSize) {
      differ++;
    } else {
      const hash = await deps.crypto.hashContent(await deps.fs.readBinary(file));
      if (toBase64(hash) === toBase64(item.contentHashBlinded)) same++;
      else differ++;
    }
  }

  const upload = local.filter((file) => !remotePaths.has(file.path)).length;
  return {
    remote: remotePaths.size,
    local: local.length,
    same,
    differ,
    download,
    upload,
  };
}

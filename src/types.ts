/**
 * Shape of the plugin's `data.json` (via `Plugin.loadData()`/`saveData()`).
 * The file-level sync mapping table (fileId -> localPath -> version/hash)
 * lives in IndexedDB instead (see sync/LocalIndex.ts) - it scales much
 * better than a monolithic JSON blob once a vault has many files.
 */

import type { VaultMemberKey } from "@websync/shared";

export interface LinkedVaultConfig {
  vaultId: string;
  vaultName: string;
  kdfAlgo: string;
  /** base64 */
  kdfSalt: string;
  kdfIterations: number;
  /** base64 */
  verificationBlob: string;
  /** base64 */
  verificationNonce: string;
  /**
   * Set when this is somebody else's vault that was shared with the user: their own passphrase-wrapped copy of the
   * vault key (see `VaultMemberKey` in @websync/shared). The `kdf*` fields above are then the owner's and are NOT
   * what the passphrase unlocks - this is.
   */
  memberKey?: VaultMemberKey | null;
  /**
   * The highest vault-wide `currentVersion` this device has fully applied.
   * Used as the `since=` cursor for incremental polling. Distinct from any
   * individual file's `version` field.
   */
  lastSyncedGlobalVersion: number;
}

export interface CachedKeyMaterial {
  /**
   * Base64-encoded raw PBKDF2 output ("root bits"), NOT the passphrase and
   * NOT a CryptoKey. See CryptoService.ts for why this exists and how it's
   * used - in short, it lets "remember key on this device" skip the
   * expensive PBKDF2 step on every plugin startup.
   */
  rootBitsBase64: string;
}

/**
 * Optional sync of `.obsidian/*` config files (plugins, themes, snippets,
 * hotkeys, core settings, workspace layout), one switch per category.
 * Off by default: existing users shouldn't
 * suddenly start syncing plugin code/settings without opting in. Handled by
 * a completely separate ConfigSyncEngine, not the main note SyncEngine - see
 * that file for why.
 */
export interface ConfigSyncSettings {
  enabled: boolean;
  coreSettings: boolean;
  communityPlugins: boolean;
  themes: boolean;
  snippets: boolean;
  hotkeys: boolean;
  /**
   * Workspace layout (open tabs/panes) is device-specific by nature (a
   * phone's layout doesn't make sense on a desktop) - default OFF even
   * though the rest of config sync may be on.
   */
  workspace: boolean;
  /**
   * What this device last agreed on with the server, per setting file (key `<vaultId>|<path>`, value the blinded content
   * hash). It tells apart "I changed it" from "the server changed it" - and a file this device has never reconciled before
   * (a new device with default settings) is not in it: there the server's version is taken over, never overwritten.
   */
  known: Record<string, string>;
  /** This device's last-applied vault-wide version for config files specifically - a separate cursor from `linkedVault.lastSyncedGlobalVersion`, since the two engines poll independently. */
  lastSyncedGlobalVersion: number;
}

export interface SyncstoneSettings {
  /** Self-hosting: use `serverUrl` instead of the hosted service (see hosted.ts). */
  selfHosted: boolean;
  /** Address of the API server of the user's own installation; only used while `selfHosted` is on. */
  serverUrl: string;
  sessionToken: string | null;
  sessionExpiresAt: string | null;
  accountUsername: string | null;
  /** This device's name as registered on the server (shown in the web panel and next to live cursors). */
  deviceName: string | null;

  linkedVault: LinkedVaultConfig | null;

  /** "Schlüssel auf diesem Gerät merken" - default OFF. */
  rememberKey: boolean;
  /** Only ever populated when `rememberKey` is true. */
  cachedKeyMaterial: CachedKeyMaterial | null;

  /**
   * The user confirmed the check before the first sync of the linked vault (backup hint + what the sync would transfer,
   * see BackupNoticeModal). Nothing is synced before. Linking a vault resets it; installs from before the notice existed
   * count as confirmed.
   */
  backupAcknowledged: boolean;

  syncPaused: boolean;
  lastSyncAt: string | null;

  /**
   * Largest file (MB) this device syncs while it is a phone / tablet; 0 = no limit. Encrypting a file needs several times its
   * size in memory at once, and big attachments have crashed the Android app - hence a limit, 25 MB by default.
   */
  mobileMaxFileMb: number;

  /**
   * Live collaboration: show where other devices are in a note (coloured
   * cursors with their device name) and edit together in real time whenever
   * two or more devices have the same note open. Off = always plain file sync.
   */
  collabEnabled: boolean;

  configSync: ConfigSyncSettings;
}

export const DEFAULT_SETTINGS: SyncstoneSettings = {
  selfHosted: false,
  serverUrl: "",
  sessionToken: null,
  sessionExpiresAt: null,
  accountUsername: null,
  deviceName: null,

  linkedVault: null,

  rememberKey: false,
  cachedKeyMaterial: null,

  backupAcknowledged: false,

  syncPaused: false,
  lastSyncAt: null,

  mobileMaxFileMb: 25,

  collabEnabled: true,

  configSync: {
    enabled: false,
    coreSettings: true,
    // Off until chosen: plugins differ between devices (desktop-only ones, different sets on the phone), and their
    // folders carry the most files.
    communityPlugins: false,
    themes: true,
    snippets: true,
    hotkeys: true,
    workspace: false,
    known: {},
    lastSyncedGlobalVersion: 0,
  },
};

import { z } from "zod";
import { BILLING_STATES } from "./billing";
import { CLIENT_TYPES, COLLAB_MAX_RELAY_BASE64_LENGTH, LOCALES, MIN_PASSWORD_LENGTH, TWO_FACTOR_METHODS } from "./constants";

// --- Auth ---

/** Login names: 3-32 characters, letters / digits / `.` `_` `-`, starting with a letter or digit. Case-insensitive. */
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
export const UsernameSchema = z.string().trim().regex(USERNAME_PATTERN);

export const RegisterRequestSchema = z.object({
  username: UsernameSchema,
  password: z.string().min(MIN_PASSWORD_LENGTH),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  // Not held to USERNAME_PATTERN: only the name when the account was made counts, and a wrong one is simply "no such account".
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1),
  clientType: z.enum(CLIENT_TYPES),
  deviceName: z.string().min(1).max(100),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  pendingLoginToken: z.string(),
  method: z.enum(TWO_FACTOR_METHODS),
  /** Every second factor this account can use right now; the login page offers the ones besides `method` as a switch. */
  availableMethods: z.array(z.enum(TWO_FACTOR_METHODS)).min(1),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * Result of `POST /auth/login`: a second factor is still needed (`LoginResponse`), or - for an account without
 * authenticator / passkey - the password alone was enough and the session is issued right away.
 */
export type LoginResult = LoginResponse | SessionTokenResponse;
export function loginFinished(result: LoginResult): result is SessionTokenResponse {
  return "sessionToken" in result;
}

export const SwitchLoginMethodRequestSchema = z.object({
  pendingLoginToken: z.string().uuid(),
  method: z.enum(TWO_FACTOR_METHODS),
});
export type SwitchLoginMethodRequest = z.infer<typeof SwitchLoginMethodRequestSchema>;

export const TwoFactorPreferenceRequestSchema = z.object({
  method: z.enum(TWO_FACTOR_METHODS),
});
export type TwoFactorPreferenceRequest = z.infer<typeof TwoFactorPreferenceRequestSchema>;

export const LoginVerifyRequestSchema = z.object({
  pendingLoginToken: z.string(),
  code: z.string().min(6).max(10),
});
export type LoginVerifyRequest = z.infer<typeof LoginVerifyRequestSchema>;

export const SessionTokenResponseSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.string(),
});
export type SessionTokenResponse = z.infer<typeof SessionTokenResponseSchema>;

export const TotpSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type TotpSetupResponse = z.infer<typeof TotpSetupResponseSchema>;

export const TotpConfirmRequestSchema = z.object({
  code: z.string().min(6).max(10),
});
export type TotpConfirmRequest = z.infer<typeof TotpConfirmRequestSchema>;

/** Turning the authenticator off again needs a current code from it, so a stolen session can't strip the second factor. */
export const TotpDisableRequestSchema = z.object({
  code: z.string().min(6).max(10),
});
export type TotpDisableRequest = z.infer<typeof TotpDisableRequestSchema>;

export const MeResponseSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  totpEnabled: z.boolean(),
  /** Second factor asked for first at login; the other one (if set up) stays available as a switch. */
  preferredTwoFactor: z.enum(TWO_FACTOR_METHODS).default("totp"),
  /** Only ever informational for the UI - the server checks the role itself on every admin request. */
  role: z.enum(["user", "admin"]).default("user"),
  /** Summed size of the user's live files and the account's limit (null = unlimited) - drives the "almost full" banner. */
  storageUsedBytes: z.number().int().nonnegative().default(0),
  storageQuotaBytes: z.number().int().nonnegative().nullable().default(null),
  /** Billing: see BILLING_STATES. "unmanaged" on servers without billing. */
  billingState: z.enum(BILLING_STATES).default("unmanaged"),
  /** True while the account may not change files (trial / subscription over) - the sync shows a warning icon. */
  readOnly: z.boolean().default(false),
  /** Largest file the server accepts for this account. */
  maxFileBytes: z.number().int().positive().nullable().default(null),
  plan: z.string().nullable().default(null),
  trialEndsAt: z.string().nullable().default(null),
  dataDeleteAt: z.string().nullable().default(null),
  /** Address of the web app (plan page links from the plugin). */
  webUrl: z.string().nullable().default(null),
  /** Chosen UI language; null until the user picks one. */
  locale: z.enum(LOCALES).nullable().default(null),
  /** Number of registered passkeys (a passkey counts as a second factor at login). */
  passkeyCount: z.number().int().nonnegative().default(0),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const SetLocaleRequestSchema = z.object({ locale: z.enum(LOCALES) });
export type SetLocaleRequest = z.infer<typeof SetLocaleRequestSchema>;

// --- Device pairing (browser-based login, replaces typing credentials into the plugin) ---

export const DeviceStartRequestSchema = z.object({
  clientType: z.enum(CLIENT_TYPES),
  deviceName: z.string().min(1).max(100),
});
export type DeviceStartRequest = z.infer<typeof DeviceStartRequestSchema>;

export const DeviceStartResponseSchema = z.object({
  pairingCode: z.string(),
  pollToken: z.string(),
  verificationUrl: z.string(),
  expiresAt: z.string(),
});
export type DeviceStartResponse = z.infer<typeof DeviceStartResponseSchema>;

export const DevicePollResponseSchema = z.object({
  status: z.enum(["pending", "approved", "denied", "expired"]),
  sessionToken: z.string().optional(),
  vaultId: z.string().uuid().optional(),
});
export type DevicePollResponse = z.infer<typeof DevicePollResponseSchema>;

export const DeviceLookupResponseSchema = z.object({
  clientType: z.enum(CLIENT_TYPES),
  deviceName: z.string(),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  expiresAt: z.string(),
});
export type DeviceLookupResponse = z.infer<typeof DeviceLookupResponseSchema>;

export const DeviceApproveRequestSchema = z.object({
  pairingCode: z.string(),
  vaultId: z.string().uuid(),
});
export type DeviceApproveRequest = z.infer<typeof DeviceApproveRequestSchema>;

export const DeviceDenyRequestSchema = z.object({
  pairingCode: z.string(),
});
export type DeviceDenyRequest = z.infer<typeof DeviceDenyRequestSchema>;

// --- Live sync (WebSocket push) ---

/** Sent by the server over `/ws` whenever a vault's current_version changes. */
export const VaultChangedMessageSchema = z.object({
  type: z.literal("vault_changed"),
  currentVersion: z.number().int(),
});
export type VaultChangedMessage = z.infer<typeof VaultChangedMessageSchema>;

// --- Live collaboration (presence + co-editing, relayed over the same `/ws`) ---
//
// A "room" is one file (`fileId`) of one vault. The server only tracks who is
// in which room and forwards `collab_relay` payloads; everything inside `data`
// (document updates, cursor positions) is end-to-end encrypted by the plugin,
// so the server never sees note content or selections.

/** Client -> server: this device now has the file open. */
export const CollabJoinMessageSchema = z.object({
  type: z.literal("collab_join"),
  fileId: z.string().uuid(),
});
export type CollabJoinMessage = z.infer<typeof CollabJoinMessageSchema>;

/** Client -> server: this device closed the file. */
export const CollabLeaveMessageSchema = z.object({
  type: z.literal("collab_leave"),
  fileId: z.string().uuid(),
});
export type CollabLeaveMessage = z.infer<typeof CollabLeaveMessageSchema>;

/** Client -> server: forward `data` to one peer (`to`) or to everybody else in the room. */
export const CollabRelayRequestSchema = z.object({
  type: z.literal("collab_relay"),
  fileId: z.string().uuid(),
  to: z.string().uuid().optional(),
  data: z.string().min(1).max(COLLAB_MAX_RELAY_BASE64_LENGTH), // base64 of an encrypted payload
});
export type CollabRelayRequest = z.infer<typeof CollabRelayRequestSchema>;

export const CollabClientMessageSchema = z.discriminatedUnion("type", [
  CollabJoinMessageSchema,
  CollabLeaveMessageSchema,
  CollabRelayRequestSchema,
]);
export type CollabClientMessage = z.infer<typeof CollabClientMessageSchema>;

export const CollabPeerSchema = z.object({
  /** Unique per WebSocket connection (so two Obsidian windows on one device are two peers). */
  peerId: z.string().uuid(),
  /** The device name from the session, as shown in the plugin settings / web panel. */
  deviceName: z.string(),
  /** Lowest index not used by anybody else in the room - clients map it to a cursor colour. */
  colorIndex: z.number().int().min(0),
  /** Join order within the server's lifetime; the lowest `seq` among the others seeds new joiners. */
  seq: z.number().int(),
});
export type CollabPeer = z.infer<typeof CollabPeerSchema>;

/** Server -> client: the full member list of a room, sent to every member whenever it changes. */
export const CollabPeersMessageSchema = z.object({
  type: z.literal("collab_peers"),
  fileId: z.string().uuid(),
  /** The receiving connection's own `peerId` (it is also part of `peers`). */
  you: z.string().uuid(),
  peers: z.array(CollabPeerSchema),
});
export type CollabPeersMessage = z.infer<typeof CollabPeersMessageSchema>;

/** Server -> client: an encrypted payload from another peer of the room. */
export const CollabRelayMessageSchema = z.object({
  type: z.literal("collab_relay"),
  fileId: z.string().uuid(),
  from: z.string().uuid(),
  data: z.string(),
});
export type CollabRelayMessage = z.infer<typeof CollabRelayMessageSchema>;

/**
 * Server -> client: an older version of a note that this connection has open was restored by a device that is not part
 * of the live session. The live document still holds the text from before, so the room's host (lowest `seq`) loads the
 * restored content and puts it into the session; otherwise the next autosave would overwrite the restore.
 */
export const CollabRestoredMessageSchema = z.object({
  type: z.literal("collab_restored"),
  fileId: z.string().uuid(),
  /** The vault version the restore got; clients ignore it once they have seen a newer write of the file. */
  version: z.number().int(),
});
export type CollabRestoredMessage = z.infer<typeof CollabRestoredMessageSchema>;

export const CollabServerMessageSchema = z.discriminatedUnion("type", [
  CollabPeersMessageSchema,
  CollabRelayMessageSchema,
  CollabRestoredMessageSchema,
]);
export type CollabServerMessage = z.infer<typeof CollabServerMessageSchema>;

// --- Server info ---

/**
 * `GET /health`: liveness plus what a client needs to check that it fits this server. Every field but `status` and
 * `protocolVersion` is optional, so older servers (which only send those two) still parse.
 */
export const HealthResponseSchema = z.object({
  status: z.string(),
  protocolVersion: z.number().int(),
  /** Plugins below this protocol level must update before they may sync. */
  minClientProtocolVersion: z.number().int().optional(),
  /** Version of the server software. */
  serverVersion: z.string().optional(),
  /** The newest released plugin version the server knows about (empty when it does not know). */
  latestPluginVersion: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// --- Sessions / devices ---

export const SessionListItemSchema = z.object({
  id: z.string().uuid(),
  deviceName: z.string(),
  clientType: z.enum(CLIENT_TYPES),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  current: z.boolean(),
});
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

/** `PATCH /sessions/current`: rename the device the calling session belongs to. */
export const RenameDeviceRequestSchema = z.object({
  deviceName: z.string().trim().min(1).max(100),
});
export type RenameDeviceRequest = z.infer<typeof RenameDeviceRequestSchema>;

// --- Vaults ---

export const CreateVaultRequestSchema = z.object({
  name: z.string().min(1).max(100),
  kdfAlgo: z.string(),
  kdfSalt: z.string(), // base64
  kdfIterations: z.number().int().positive(),
  verificationBlob: z.string(), // base64
  verificationNonce: z.string(), // base64
});
export type CreateVaultRequest = z.infer<typeof CreateVaultRequestSchema>;

export const VaultListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  createdAt: z.string(),
  currentVersion: z.number().int(),
  /** `member` = somebody else's vault that was shared with the caller (see "Vault sharing" below). */
  role: z.enum(["owner", "member"]).default("owner"),
  /** Set for shared vaults: who owns it. */
  ownerUsername: z.string().nullable().default(null),
});
export type VaultListItem = z.infer<typeof VaultListItemSchema>;

/**
 * A member's own copy of the vault key: the vault's root bits sealed under a passphrase only the member knows
 * (`salt`/`iterations` feed PBKDF2, see `wrapRootBitsForMember`). Present instead of the owner's kdf* fields
 * being usable: a member unlocks with this, never with the owner's passphrase.
 */
export const VaultMemberKeySchema = z.object({
  /** The caller's user id, needed as part of what the wrapped key is bound to. */
  userId: z.string().uuid(),
  salt: z.string(), // base64
  iterations: z.number().int().positive(),
  wrapped: z.string(), // base64
});
export type VaultMemberKey = z.infer<typeof VaultMemberKeySchema>;

export const VaultDetailSchema = VaultListItemSchema.extend({
  kdfAlgo: z.string(),
  kdfSalt: z.string(),
  kdfIterations: z.number().int(),
  verificationBlob: z.string(),
  verificationNonce: z.string(),
  /** Only for `role: "member"`. */
  memberKey: VaultMemberKeySchema.nullable().default(null),
});
export type VaultDetail = z.infer<typeof VaultDetailSchema>;

// --- Vault sharing ---
//
// Two separate layers: the SERVER decides who may sync a vault (`vault_members`), the KEY decides who can read it.
// The key never passes through the server in the clear - see the "Vault sharing" comment in crypto.ts.

/**
 * `POST /vaults/:id/invites` (owner). `wrappedKey` = base64 of `wrapRootBitsForInvite`. The secret that opens it (the
 * invitation code) never reaches the server: the owner passes it on to the invitee themselves.
 */
export const CreateInviteRequestSchema = z.object({
  username: UsernameSchema,
  wrappedKey: z.string().min(1).max(4096),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;

/** What the owner sees about an invitation that has not been accepted yet. */
export const InviteItemSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type InviteItem = z.infer<typeof InviteItemSchema>;

export const VaultMemberItemSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  joinedAt: z.string(),
});
export type VaultMemberItem = z.infer<typeof VaultMemberItemSchema>;

/** `GET /vaults/:id/sharing` (owner). */
export const VaultSharingSchema = z.object({
  members: z.array(VaultMemberItemSchema),
  invites: z.array(InviteItemSchema),
});
export type VaultSharing = z.infer<typeof VaultSharingSchema>;

/** The invitation as far as it is public: what the join page shows before anything is unlocked. */
export const IncomingInviteSchema = z.object({
  id: z.string().uuid(),
  vaultName: z.string(),
  ownerUsername: z.string(),
  expiresAt: z.string(),
});
export type IncomingInvite = z.infer<typeof IncomingInviteSchema>;

/** `GET /invites/:id`: everything the invitee's browser needs to unwrap the key with the invitation code and check it. */
export const InvitePreviewSchema = IncomingInviteSchema.extend({
  vaultId: z.string().uuid(),
  wrappedKey: z.string(), // base64
  verificationBlob: z.string(),
  verificationNonce: z.string(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

/** `POST /invites/:id/accept`: the invitee's own passphrase-wrapped copy of the key (see `VaultMemberKeySchema`). */
export const AcceptInviteRequestSchema = z.object({
  keySalt: z.string().min(1).max(256),
  keyIterations: z.number().int().min(100_000).max(5_000_000),
  keyWrapped: z.string().min(1).max(4096),
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>;

// --- Sync ---

export const FileListItemSchema = z.object({
  id: z.string().uuid(),
  pathCiphertext: z.string(), // base64
  pathNonce: z.string(), // base64
  contentHashBlinded: z.string(), // base64
  contentSize: z.number().int(),
  version: z.number().int(),
  isDeleted: z.boolean(),
  updatedAt: z.string(),
});
export type FileListItem = z.infer<typeof FileListItemSchema>;

export const FileListResponseSchema = z.object({
  files: z.array(FileListItemSchema),
  currentVersion: z.number().int(),
});
export type FileListResponse = z.infer<typeof FileListResponseSchema>;

export const UploadFileMetaSchema = z.object({
  pathCiphertext: z.string(),
  pathNonce: z.string(),
  contentHashBlinded: z.string(),
  contentSize: z.number().int(),
  /**
   * Opaque id the client keeps for as long as it considers itself "still editing" this file (see
   * HISTORY_EDIT_SESSION_IDLE_MS) - a fresh id after switching away from the file or being idle on it for a while.
   * Consecutive "modify" writes with the same id are folded into one history entry instead of one per debounced save.
   */
  editSessionId: z.string().uuid().optional(),
  /**
   * The content this write is based on: the blinded hash the client last had in common with the server for this file,
   * or null for a file the client believes is new. When the server's current content is a different one (another
   * device wrote in between), the write is refused with 409 `stale_base` and the current state, so the client merges
   * instead of silently overwriting. Absent (older clients): no check. A deleted file may always be written again.
   */
  baseHash: z.string().nullable().optional(),
});
export type UploadFileMeta = z.infer<typeof UploadFileMetaSchema>;

/** Body of a 409 answer to an upload whose `baseHash` is no longer the server's content. */
export const StaleBaseResponseSchema = z.object({
  error: z.string(),
  code: z.literal("stale_base"),
  current: FileListItemSchema,
});
export type StaleBaseResponse = z.infer<typeof StaleBaseResponseSchema>;

export const RenameFileRequestSchema = z.object({
  newPathCiphertext: z.string(),
  newPathNonce: z.string(),
});
export type RenameFileRequest = z.infer<typeof RenameFileRequestSchema>;

/** `POST /vaults/:id/uploads`: starts a chunked upload of `size` bytes (the packed `iv || ciphertext` blob). */
export const StartChunkedUploadRequestSchema = z.object({
  fileId: z.string().uuid(),
  size: z.number().int().positive(),
});
export type StartChunkedUploadRequest = z.infer<typeof StartChunkedUploadRequestSchema>;

export const StartChunkedUploadResponseSchema = z.object({
  uploadId: z.string().uuid(),
  chunkSize: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
});
export type StartChunkedUploadResponse = z.infer<typeof StartChunkedUploadResponseSchema>;

/** `POST /vaults/:id/uploads/:uploadId/complete`: the same metadata a single-request upload sends. */
export const CompleteChunkedUploadRequestSchema = z.object({
  meta: UploadFileMetaSchema,
});
export type CompleteChunkedUploadRequest = z.infer<typeof CompleteChunkedUploadRequestSchema>;

// --- Version history ---

export const FILE_REVISION_ACTIONS = ["create", "modify", "rename", "delete", "restore"] as const;
export type FileRevisionAction = (typeof FILE_REVISION_ACTIONS)[number];

/** One entry of the history of a vault (`GET /vaults/:id/history`) or of one file (`.../files/:fileId/history`). */
export const FileRevisionItemSchema = z.object({
  id: z.string().uuid(),
  fileId: z.string().uuid(),
  version: z.number().int(),
  action: z.enum(FILE_REVISION_ACTIONS),
  pathCiphertext: z.string(), // base64
  pathNonce: z.string(), // base64
  contentHashBlinded: z.string(), // base64
  contentSize: z.number().int(),
  /** False when the content of this version was not kept (too large, or already pruned) - it cannot be restored. */
  hasContent: z.boolean(),
  deviceName: z.string().nullable(),
  /** Username of the account that made the change (null once the account is gone). */
  username: z.string().nullable(),
  createdAt: z.string(),
});
export type FileRevisionItem = z.infer<typeof FileRevisionItemSchema>;

export const FileRevisionListResponseSchema = z.object({
  revisions: z.array(FileRevisionItemSchema),
  /** Pass as `before` to load older entries; null when there are none. */
  nextBefore: z.number().int().nullable(),
  retentionDays: z.number().int(),
});
export type FileRevisionListResponse = z.infer<typeof FileRevisionListResponseSchema>;

/** `POST .../revisions/:revisionId/restore`. Path defaults to the current one (or the revision's, for a deleted file). */
export const RestoreRevisionRequestSchema = z.object({
  pathCiphertext: z.string().optional(),
  pathNonce: z.string().optional(),
  /**
   * The restoring device is in the note's live session and already put the restored text into it. The other members get
   * it through the session, so the server must not ask the room's host to apply it a second time.
   */
  appliedLive: z.boolean().optional(),
});
export type RestoreRevisionRequest = z.infer<typeof RestoreRevisionRequestSchema>;

// --- Public note links ---

/** Largest encrypted snapshot of a published note (text plus inlined images). */
export const PUBLISH_MAX_BLOB_BYTES = 12 * 1024 * 1024;
export const PUBLISH_MAX_PER_VAULT = 200;

export const PublishedNoteSchema = z.object({
  id: z.string(),
  fileId: z.string().uuid(),
  updatedAt: z.string(),
  /** ISO time after which the link stops working; null = never. */
  expiresAt: z.string().nullable(),
  hasPassword: z.boolean(),
  views: z.number().int(),
});
export type PublishedNote = z.infer<typeof PublishedNoteSchema>;

/** `PUT /vaults/:id/publish/:fileId`: `blob` is base64 of `iv || ciphertext`, encrypted with the key that stays in the link. */
/** A link password is at most this long; the reader types it before the (still encrypted) blob is handed out. */
export const PUBLISH_PASSWORD_MAX = 200;
/** For the optional fields: omitted = keep what the link has, null = remove it. */
export const PublishOptionsSchema = z.object({
  expiresAt: z.string().datetime().nullable().optional(),
  password: z.string().min(1).max(PUBLISH_PASSWORD_MAX).nullable().optional(),
});
export type PublishOptions = z.infer<typeof PublishOptionsSchema>;

export const PublishNoteRequestSchema = PublishOptionsSchema.extend({ blob: z.string().min(1) });
export type PublishNoteRequest = z.infer<typeof PublishNoteRequestSchema>;

// --- Passkeys (WebAuthn) as a second factor ---

export const PasskeyItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** Synced across the user's devices by a platform/password manager (true) or bound to one device (false). */
  backedUp: z.boolean(),
});
export type PasskeyItem = z.infer<typeof PasskeyItemSchema>;

/** `POST /auth/passkeys/register/verify`: the browser's answer to the registration options plus a name for the list. */
export const PasskeyRegisterVerifyRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  response: z.record(z.unknown()),
});
export type PasskeyRegisterVerifyRequest = z.infer<typeof PasskeyRegisterVerifyRequestSchema>;

export const PasskeyLoginOptionsRequestSchema = z.object({ pendingLoginToken: z.string().uuid() });
export type PasskeyLoginOptionsRequest = z.infer<typeof PasskeyLoginOptionsRequestSchema>;

/** `POST /auth/login/passkey/discover/verify`: password-less login, the passkey alone identifies and authenticates the account. */
export const PasskeyDiscoverVerifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  response: z.record(z.unknown()),
  deviceName: z.string().min(1).max(100),
  clientType: z.enum(CLIENT_TYPES),
});
export type PasskeyDiscoverVerifyRequest = z.infer<typeof PasskeyDiscoverVerifyRequestSchema>;

export const PasskeyLoginVerifyRequestSchema = z.object({
  pendingLoginToken: z.string().uuid(),
  response: z.record(z.unknown()),
});
export type PasskeyLoginVerifyRequest = z.infer<typeof PasskeyLoginVerifyRequestSchema>;

// --- Setup / public server info ---

/** `GET /public-config` - what the web app needs to know before anybody is signed in. */
export interface PublicConfig {
  /** No account exists yet: the first-run setup page must be shown. */
  needsSetup: boolean;
  registrationOpen: boolean;
  protocolVersion: number;
}

export const SetupRequestSchema = z.object({
  /** The one-time token the server printed to its log at start-up. */
  setupToken: z.string().min(1).max(200),
  username: UsernameSchema,
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1000),
});
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(1000),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(1000),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

import { MarkdownView, normalizePath, Notice, Plugin, TFile } from "obsidian";
import { applyHistoryTexts, t } from "./i18n";
import { REMOTE_POLL_INTERVAL_MS, toBase64, unpackBlob, type HealthResponse, type MeResponse } from "@websync/shared";
import { DEFAULT_SETTINGS, localIndexNameFor, type SyncstoneSettings } from "./types.js";
import { HOSTED_SERVER_URL, normalizeServerUrl } from "./hosted.js";
import { AuthClient } from "./sync/AuthClient.js";
import { RemoteApiClient } from "./sync/RemoteApiClient.js";
import type { BillingInfo } from "./sync/billing.js";
import { SyncstoneApiError, apiRequest } from "./sync/httpClient.js";
import { COMPAT_UNKNOWN, evaluateCompat, type CompatInfo } from "./sync/compat.js";
import { CryptoService } from "./sync/CryptoService.js";
import { VaultLinkManager } from "./sync/VaultLinkManager.js";
import { FileSystemAdapter } from "./sync/FileSystemAdapter.js";
import { LocalIndex } from "./sync/LocalIndex.js";
import { SyncEngine } from "./sync/SyncEngine.js";
import { ConfigSyncEngine } from "./sync/ConfigSyncEngine.js";
import { SyncLog } from "./sync/SyncLog.js";
import { LiveSyncClient } from "./sync/LiveSyncClient.js";
import { CollabManager } from "./collab/CollabManager.js";
import { collabCompartment } from "./collab/editorBinding.js";
import { SyncstoneSettingsTab } from "./settings/SettingsTab.js";
import { SyncstoneStatusBar } from "./ui/StatusBar.js";
import { SyncstoneHeaderActions } from "./ui/HeaderActions.js";
import { ExplorerProgressRings, createTransferTracker } from "./ui/TransferProgress.js";
import { HISTORY_VIEW_TYPE, HistoryView } from "./ui/HistoryView.js";
import { PublishService } from "./publish/PublishService.js";
import { PublishModal } from "./ui/PublishModal.js";
import { SyncLogModal } from "./ui/SyncLogModal.js";
import { BackupNoticeModal } from "./ui/BackupNoticeModal.js";
import { MissingFilesModal } from "./ui/MissingFilesModal.js";
import { ConfigFirstContactModal } from "./ui/ConfigFirstContactModal.js";
import { previewFirstSync, type FirstSyncPreview } from "./sync/firstSyncPreview.js";
import { HISTORY_DIFF_VIEW_TYPE, HistoryDiffView } from "./ui/HistoryDiffView.js";

export default class SyncstonePlugin extends Plugin {
  settings: SyncstoneSettings = DEFAULT_SETTINGS;

  authClient!: AuthClient;
  remoteApi!: RemoteApiClient;
  cryptoService!: CryptoService;
  vaultLinkManager!: VaultLinkManager;
  fsAdapter!: FileSystemAdapter;

  syncEngine: SyncEngine | null = null;
  configSyncEngine: ConfigSyncEngine | null = null;
  localIndex: LocalIndex | null = null;
  liveSyncClient: LiveSyncClient | null = null;
  /** Presence + live co-editing on top of the file sync; only exists while sync runs. */
  collabManager: CollabManager | null = null;
  /** Updated by LiveSyncClient's onStatusChange - purely informational, read by SettingsTab for the optional "Live-Sync: verbunden/getrennt" indicator. */
  liveSyncConnected = false;
  /** The signed-in account with storage numbers and plan state; null until the first answer (or without a session). */
  account: MeResponse | null = null;
  private lastAccountLoad = 0;
  /** The plan of the account on a hosted server; null on a self-hosted one (or while unknown). See loadBilling(). */
  billing: BillingInfo | null = null;
  /** Server + session `billing` was last asked for, so a changed server or a new login asks again. */
  private billingKey = "";
  private lastBillingLoad = 0;
  /** Which "can't sync any more" notice was already shown in the current blocked period (shown once, not on every refused file). */
  private blockedNoticeShown: "read-only" | "storage-full" | null = null;
  /** Uploads/downloads in flight (explorer progress rings, "syncing" status). */
  readonly transfers = createTransferTracker();

  private settingsTab: SyncstoneSettingsTab | null = null;
  private statusBar!: SyncstoneStatusBar;
  private headerActions!: SyncstoneHeaderActions;
  /** What the sync did (the "Sync log" dialog); lives as long as the plugin, across unlink / relink. */
  syncLog!: SyncLog;
  private progressRings!: ExplorerProgressRings;
  /** The settings-sync switch the user flipped on last ("enabled" = the main one), so declining the first-contact question can flip exactly that one back. */
  lastConfigToggle: "enabled" | "coreSettings" | "communityPlugins" | "themes" | "snippets" | "hotkeys" | "workspace" | null = null;
  /** Whether plugin and server fit together, and whether a newer plugin is out (see checkCompat). */
  compat: CompatInfo = COMPAT_UNKNOWN;
  /** The last compat result that was shown to the user, so the same hint is not repeated within one Obsidian start. */
  private compatAnnounced = "ok|";

  async onload(): Promise<void> {
    applyHistoryTexts(); // the change log (shared with the web app) speaks Obsidian's language
    await this.loadSettings();

    this.authClient = new AuthClient(() => this.serverUrl);
    this.remoteApi = new RemoteApiClient(
      () => this.serverUrl,
      () => this.settings.sessionToken,
      this.manifest.version,
    );
    this.cryptoService = new CryptoService();
    this.vaultLinkManager = new VaultLinkManager(this.remoteApi, this.cryptoService);
    this.fsAdapter = new FileSystemAdapter(this.app);
    this.syncLog = new SyncLog(this.app, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/sync-log.json`);
    void this.syncLog.load();

    this.settingsTab = new SyncstoneSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    // The web page opens obsidian://syncstone-pair once the sign-in is confirmed there: that brings Obsidian to the front
    // and the plugin asks the server at once instead of waiting for the next poll tick.
    this.registerObsidianProtocolHandler("syncstone-pair", () => this.settingsTab?.pollPairingNow());
    // The old link name, still opened by web pages that have not been updated yet.
    this.registerObsidianProtocolHandler("websync-pair", () => this.settingsTab?.pollPairingNow());

    // Every markdown editor gets an (empty) slot the CollabManager fills with
    // the Yjs binding while a note is co-edited. Must be registered up front.
    this.registerEditorExtension(collabCompartment.of([]));

    this.statusBar = new SyncstoneStatusBar(this);
    this.statusBar.start();

    // Note header (top right, next to the reading-view toggle): the sync status
    // icon (with its menu) and the live avatars, on every platform.
    this.headerActions = new SyncstoneHeaderActions(this, this.statusBar);
    this.statusBar.onRefresh = () => this.headerActions.refresh();
    this.app.workspace.onLayoutReady(() => this.headerActions.start());
    this.progressRings = new ExplorerProgressRings(this.app, this.transfers, () => this.openSyncLog());
    this.app.workspace.onLayoutReady(() => this.progressRings.start());

    // Version history: a sidebar view (right by default, can be dragged anywhere like any Obsidian view), plus a
    // main-area view for comparing one version against the current content (opened from a row in the sidebar view).
    this.registerView(HISTORY_VIEW_TYPE, (leaf) => new HistoryView(leaf, this));
    this.registerView(HISTORY_DIFF_VIEW_TYPE, (leaf) => new HistoryDiffView(leaf, this));
    this.app.workspace.onLayoutReady(() => void this.ensureHistoryLeaf());
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !this.settings.linkedVault) return;
        menu.addItem((item) =>
          item
            .setTitle(t("p.history"))
            .setIcon("history")
            .setSection("view")
            .onClick(() => void this.openHistory(file)),
        );
        if (file.extension.toLowerCase() === "md") {
          menu.addItem((item) =>
            item
              .setTitle(t("p.pub.menu"))
              .setIcon("link")
              .setSection("view")
              .onClick(() => void this.openPublish(file)),
          );
        }
      }),
    );
    this.addCommand({
      id: "share-link",
      name: t("p.pub.cmd"),
      callback: () => void this.openPublish(this.app.workspace.getActiveFile()),
    });
    this.addCommand({
      id: "file-history",
      name: t("p.cmd.fileHistory"),
      callback: () => void this.openHistory(this.app.workspace.getActiveFile()),
    });
    this.addCommand({
      id: "vault-history",
      name: t("p.cmd.vaultHistory"),
      callback: () => void this.openHistory(null, true),
    });

    this.addCommand({
      id: "sync-log",
      name: t("p.log.cmd"),
      callback: () => this.openSyncLog(),
    });
    this.addCommand({
      id: "sync-now",
      name: t("p.cmd.syncNow"),
      callback: () => void this.runManualSync(),
    });

    // Defer starting sync until Obsidian's own vault index/metadata cache is
    // fully built - `vault.getFiles()` and vault events are not reliable
    // before layout-ready fires.
    this.app.workspace.onLayoutReady(() => {
      // Before the first sync of a linked vault, tryStartSync shows the first-sync check (backup hint + what would happen).
      void this.tryStartSync().then(() => {
        // Not signed in: tryStartSync did not ask the server, but a newer plugin version is still worth a hint.
        if (!this.settings.sessionToken || !this.settings.linkedVault) void this.checkCompat();
      });
    });
    // An updated server (or one that now needs a newer plugin) takes effect without restarting Obsidian.
    this.registerInterval(window.setInterval(() => void this.recheckCompat(), 30 * 60 * 1000));
  }

  private backupNoticeOpen = false;

  /**
   * The check before the first sync of a linked vault (see BackupNoticeModal): counts what the sync would download and
   * upload, then shows that with the backup hint. Confirming it starts the sync. Needs the vault unlocked (paths are
   * encrypted on the server), so tryStartSync calls it after unlocking.
   */
  private async showBackupNotice(): Promise<void> {
    const linked = this.settings.linkedVault;
    if (this.backupNoticeOpen || this.settings.backupAcknowledged || !linked || !this.cryptoService.isUnlocked()) return;
    this.backupNoticeOpen = true;
    const checking = new Notice(t("p.firstSync.checking"), 0);
    let preview: FirstSyncPreview | null = null;
    try {
      preview = await previewFirstSync({
        vaultId: linked.vaultId,
        remote: this.remoteApi,
        crypto: this.cryptoService,
        fs: this.fsAdapter,
        isConfigPath: (path) => this.isConfigPath(path),
      });
    } catch (err) {
      console.warn("Syncstone: Vorschau für den ersten Sync nicht möglich", err);
    } finally {
      checking.hide();
    }
    // Unlinked, switched to another vault or confirmed elsewhere meanwhile: this check is out of date.
    if (this.settings.backupAcknowledged || this.settings.linkedVault?.vaultId !== linked.vaultId) {
      this.backupNoticeOpen = false;
      return;
    }
    new BackupNoticeModal(
      this.app,
      preview,
      () => this.acknowledgeBackup(),
      () => {
        this.backupNoticeOpen = false;
      },
    ).open();
  }

  /** Paths owned by ConfigSyncEngine (the config folder), which the file sync leaves alone. */
  private isConfigPath(path: string): boolean {
    return normalizePath(path).toLowerCase().startsWith(`${this.app.vault.configDir}/`.toLowerCase());
  }

  /** The user confirmed they have a backup (from the notice, the settings tab or the status menu): start syncing. */
  async acknowledgeBackup(): Promise<void> {
    this.settings.backupAcknowledged = true;
    await this.saveSettings();
    await this.tryStartSync();
    this.settingsTab?.display();
  }

  openSyncLog(): void {
    new SyncLogModal(this.app, this.syncLog).open();
  }

  onunload(): void {
    void this.syncLog?.flush();
    this.stopSync();
    this.statusBar?.dispose();
    this.headerActions?.dispose();
    this.progressRings?.dispose();
  }

  /**
   * Re-reads the account (storage used / quota, trial, read-only). Cheap, so it runs after syncs and on a timer;
   * `force` skips the small throttle (used right after the server refused a write). Never throws.
   */
  async refreshAccount(force = false): Promise<void> {
    if (!this.settings.sessionToken || !this.serverUrl) {
      if (this.account) {
        this.account = null;
        this.statusBar?.refresh();
      }
      return;
    }
    if (!force && Date.now() - this.lastAccountLoad < 10_000) return;
    this.lastAccountLoad = Date.now();
    try {
      const account = await this.remoteApi.getMe();
      const wasBlocked = this.writeBlockReason() !== null;
      const changed = JSON.stringify([account.storageUsedBytes, account.storageQuotaBytes, account.readOnly]) !== JSON.stringify([this.account?.storageUsedBytes, this.account?.storageQuotaBytes, this.account?.readOnly]);
      this.account = account;
      if (changed) this.statusBar?.refresh();
      const reason = this.writeBlockReason();
      if (reason) this.notifyWriteBlocked(reason);
      else if (wasBlocked) {
        // Room again (files deleted, plan bought): forget the notice and upload what was skipped meanwhile.
        this.blockedNoticeShown = null;
        void this.syncEngine?.runFullSync().catch((err) => console.error("Syncstone: Sync nach Freigabe fehlgeschlagen", err));
      }
    } catch {
      // Offline or the server is busy: keep what we knew.
    }
  }

  /**
   * Asks the server for the plan of the account. Only the hosted service answers; a self-hosted server has no such
   * endpoint (404), which just means "no plan section". Never throws; offline keeps what we knew. Returns true when the
   * answer changed, so the settings can redraw.
   */
  async loadBilling(force = false): Promise<boolean> {
    const key = `${this.serverUrl}|${this.settings.sessionToken ? "in" : "out"}`;
    if (key !== this.billingKey) {
      this.billingKey = key;
      this.billing = null;
      this.lastBillingLoad = 0;
    }
    if (!this.settings.sessionToken || !this.serverUrl) return false;
    if (!force && this.lastBillingLoad && Date.now() - this.lastBillingLoad < 15_000) return false;
    this.lastBillingLoad = Date.now();
    const before = JSON.stringify(this.billing);
    try {
      this.billing = await this.remoteApi.getBilling();
    } catch (err) {
      // 4xx = this server has no plans (self-hosted); anything else (offline, busy) keeps the last answer.
      if (err instanceof SyncstoneApiError && err.status >= 400 && err.status < 500) this.billing = null;
    }
    return JSON.stringify(this.billing) !== before;
  }

  /** Why changes can't be synced right now (null = they can). */
  writeBlockReason(): "read-only" | "storage-full" | null {
    const account = this.account;
    if (!account) return null;
    if (account.readOnly) return "read-only";
    if (account.storageQuotaBytes && account.storageUsedBytes >= account.storageQuotaBytes) return "storage-full";
    return null;
  }

  /** One visible message per blocked period (with a link to the plan page), so it is not only a small icon. */
  notifyWriteBlocked(reason: "read-only" | "storage-full"): void {
    if (this.blockedNoticeShown === reason) return;
    this.blockedNoticeShown = reason;
    const message = createFragment();
    message.append(t(reason === "read-only" ? "p.notice.readOnly" : "p.notice.storageFull"));
    const webUrl = this.account?.webUrl;
    if (webUrl && this.account?.billingState !== "unmanaged") {
      message.append(" ");
      message.append(
        createEl("a", {
          text: t("p.openPlan"),
          href: `${webUrl.replace(/\/+$/, "")}/account/billing`,
          attr: { target: "_blank" },
        }),
      );
    }
    new Notice(message, 20_000);
  }

  async loadSettings(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as Partial<SyncstoneSettings>;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    // Installs from before the hosted service had its own address: an address that is not the hosted one is a
    // self-hosted server and stays in use.
    if (stored.selfHosted === undefined) {
      const own = normalizeServerUrl(stored.serverUrl ?? "");
      this.settings.selfHosted = own !== "" && own !== normalizeServerUrl(HOSTED_SERVER_URL);
    }
    // Settings sync that was never used yet starts with community plugins off, like a new install; who already syncs
    // settings keeps their choice.
    const config = stored.configSync;
    if (config && !config.enabled && Object.keys(config.known ?? {}).length === 0) {
      this.settings.configSync = { ...config, communityPlugins: false };
    }
    // Installs from before the backup notice existed already sync: it does not stop them.
    if (stored.backupAcknowledged === undefined && (stored.sessionToken || stored.linkedVault)) this.settings.backupAcknowledged = true;
  }

  /** The API server in use: the user's own one while self-hosting is on, else the hosted service. */
  get serverUrl(): string {
    return normalizeServerUrl(this.settings.selfHosted ? this.settings.serverUrl : HOSTED_SERVER_URL);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * (Re)starts the sync engine if we're logged in, a vault is linked, and
   * the crypto service can be unlocked (either it already is, or a cached
   * key is available). Called on load, and again after login/logout,
   * link/unlink, and unlock actions from the settings tab. Safe to call
   * repeatedly - always stops any previous engine first.
   */
  /**
   * Asks the server (`/health`) whether this plugin and the server fit together and whether a newer plugin is out. An
   * unreachable server changes nothing: being offline is no reason to stop. Returns the (possibly unchanged) result.
   */
  async checkCompat(): Promise<CompatInfo> {
    const serverUrl = this.serverUrl;
    if (!serverUrl) return this.compat;
    try {
      const health = await apiRequest<Partial<HealthResponse> | undefined>(serverUrl, { path: "/health" });
      this.compat = evaluateCompat(health, this.manifest.version);
    } catch {
      // offline / server busy: keep what we knew
    }
    this.announceCompat();
    return this.compat;
  }

  /** Tells the user once per Obsidian start (and per state / version) what the last check found. */
  private announceCompat(): void {
    const { state, updateAvailable } = this.compat;
    const key = `${state}|${updateAvailable ?? ""}`;
    if (key === this.compatAnnounced) return;
    this.compatAnnounced = key;
    this.statusBar?.refresh();
    if (state === "plugin-outdated") new Notice(t("p.update.requiredNotice"), 0);
    else if (state === "server-outdated") new Notice(this.isSelfHosted() ? t("p.update.serverNotice") : t("p.update.serverBusy"), 0);
    else if (updateAvailable) new Notice(t("p.update.available", { version: updateAvailable }), 15_000);
  }

  /** True when the plugin talks to a server other than the hosted Syncstone service. */
  isSelfHosted(): boolean {
    return this.serverUrl !== normalizeServerUrl(HOSTED_SERVER_URL);
  }

  /** Re-checked regularly: an updated server (or one that needs an update now) takes effect without a restart. */
  private async recheckCompat(): Promise<void> {
    const before = this.compat.state;
    const after = (await this.checkCompat()).state;
    if (before === after) return;
    if (after === "ok") void this.tryStartSync();
    else this.stopSync();
  }

  async tryStartSync(): Promise<void> {
    this.stopSync();
    if (!this.settings.sessionToken || !this.settings.linkedVault) return;
    // Plugin and server must fit together; if they do not, nothing is synced (local changes stay and go up after the update).
    if ((await this.checkCompat()).state !== "ok") {
      this.statusBar?.refresh();
      return;
    }
    if (!this.cryptoService.isUnlocked()) {
      const remembered = await this.tryUnlockFromCache();
      if (!remembered) {
        // No cached key and no passphrase available right now - the user
        // has to unlock via the settings tab before sync can run.
        this.statusBar?.refresh();
        return;
      }
    }

    // Nothing is synced before the first-sync check was confirmed.
    if (!this.settings.backupAcknowledged) {
      void this.showBackupNotice();
      this.statusBar?.refresh();
      return;
    }

    const linkedVault = this.settings.linkedVault;
    // A vault folder copied on this computer brings the copied settings along: it gets an index of its own.
    const appId = (this.app as unknown as { appId?: string }).appId;
    if (linkedVault.localIndexName && appId && !linkedVault.localIndexName.endsWith(appId)) {
      linkedVault.localIndexName = localIndexNameFor(linkedVault.vaultId, appId);
      await this.saveSettings();
    }
    const localIndex = new LocalIndex(linkedVault.vaultId, linkedVault.localIndexName);
    await localIndex.open();
    this.localIndex = localIndex;

    const syncEngine = new SyncEngine({
      vaultId: linkedVault.vaultId,
      crypto: this.cryptoService,
      remote: this.remoteApi,
      fs: this.fsAdapter,
      localIndex,
      isPaused: () => this.settings.syncPaused,
      mobileMaxFileBytes: () => (this.settings.mobileMaxFileMb > 0 ? this.settings.mobileMaxFileMb * 1024 * 1024 : Number.POSITIVE_INFINITY),
      isConfigPath: (path) => this.isConfigPath(path),
      isCollabLive: (fileId) => this.collabManager?.isLive(fileId) ?? false,
      isCollabWriter: (fileId) => this.collabManager?.isWriter(fileId) ?? true,
      saveOpenEditor: async (path) => {
        let open = false;
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view;
          if (view instanceof MarkdownView && view.file?.path === path) {
            open = true;
            await view.save().catch(() => undefined);
          }
        }
        return open;
      },
      askAboutMissingFiles: (count) => new Promise((resolve) => new MissingFilesModal(this.app, count, resolve).open()),
      mergeIntoLive: async (fileId, base, remote) => (this.collabManager ? await this.collabManager.mergeIntoLive(fileId, base, remote) : false),
      transfers: this.transfers,
      log: this.syncLog,
      initialGlobalVersion: linkedVault.lastSyncedGlobalVersion,
      onStateChange: async (state) => {
        this.settings.lastSyncAt = state.lastSyncAt;
        if (this.settings.linkedVault) {
          this.settings.linkedVault.lastSyncedGlobalVersion = state.globalVersion;
        }
        await this.saveSettings();
        void this.refreshAccount();
      },
      isReadOnly: () => this.account?.readOnly === true,
      onWriteRefused: (reason) => {
        this.notifyWriteBlocked(reason);
        void this.refreshAccount(true);
      },
    });
    this.syncEngine = syncEngine;

    this.configSyncEngine = new ConfigSyncEngine({
      app: this.app,
      vaultId: linkedVault.vaultId,
      pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
      crypto: this.cryptoService,
      remote: this.remoteApi,
      getSettings: () => this.settings.configSync,
      log: this.syncLog,
      onLastVersionChange: async (version) => {
        this.settings.configSync.lastSyncedGlobalVersion = version;
        await this.saveSettings();
      },
      chooseFirstContact: (paths) =>
        new Promise((resolve) => new ConfigFirstContactModal(this.app, paths, this.app.vault.configDir, resolve).open()),
      onFirstContactDeclined: async () => {
        // Switch back off what was just switched on: the category toggled last, else settings sync as a whole.
        const config = this.settings.configSync;
        const last = this.lastConfigToggle;
        if (last && last !== "enabled") {
          config[last] = false;
          config.rejoin = [...new Set([...(config.rejoin ?? []), last])];
        } else {
          config.enabled = false;
          config.rejoin = ["coreSettings", "communityPlugins", "themes", "snippets", "hotkeys", "workspace"];
        }
        this.lastConfigToggle = null;
        await this.saveSettings();
        this.settingsTab?.display();
      },
    });

    this.registerEvent(this.app.vault.on("create", (file) => syncEngine.handleLocalEvent("create", file)));
    this.registerEvent(this.app.vault.on("modify", (file) => syncEngine.handleLocalEvent("modify", file)));
    this.registerEvent(this.app.vault.on("delete", (file) => syncEngine.handleLocalEvent("delete", file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => syncEngine.handleLocalRename(file, oldPath)));

    // Switching away from a note ends its "still editing" history session (see SyncEngine.touchEditSession): the next
    // edit to it, even moments later, gets its own history entry instead of amending the last one.
    let lastActiveNotePath = this.app.workspace.getActiveFile()?.path ?? null;
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        const newPath = file?.path ?? null;
        const previousPath = lastActiveNotePath;
        lastActiveNotePath = newPath;
        if (previousPath && previousPath !== newPath) {
          void localIndex.getByPath(previousPath).then((record) => record && syncEngine.endEditSession(record.fileId));
        }
      }),
    );

    // The first sync of a big vault takes minutes. It runs in the background: unlocking / signing in is finished at once
    // (the status icon and the explorer rings show the progress) instead of the settings tab waiting for every file.
    const configSyncEngine = this.configSyncEngine;
    void (async () => {
      try {
        await syncEngine.runFullSync();
      } catch (err) {
        // Stopped meanwhile (unlinked, signed out, locked): the failure is a consequence of that, not news.
        if (this.syncEngine === syncEngine) {
          console.error("Syncstone: initialer Full-Sync fehlgeschlagen", err);
          new Notice(t("p.syncFailed", { error: (err as Error).message }));
        }
      }
      if (this.syncEngine !== syncEngine) return;
      try {
        await configSyncEngine.run();
      } catch (err) {
        console.error("Syncstone: initialer Einstellungs-Sync fehlgeschlagen", err);
      }
      this.statusBar?.refresh();
    })();

    // The engine ignores a poll while a sync is running, so these can start right away.
    this.registerInterval(window.setInterval(() => this.pollNow(), REMOTE_POLL_INTERVAL_MS));
    this.registerInterval(window.setInterval(() => void this.refreshAccount(), 2 * 60 * 1000));
    void this.refreshAccount(true);

    // Live-push channel: the 30s interval above keeps running as a fallback
    // safety net regardless, but this makes changes from other devices show
    // up in ~1s instead of up to 30s by triggering an immediate extra poll
    // whenever the server says the vault changed. A dropped/failed
    // connection just falls back to relying on the interval alone - see
    // LiveSyncClient's own reconnect-with-backoff handling.
    if (this.settings.sessionToken) {
      // Live collaboration rides on the same socket; the manager exists
      // before the client so its callbacks are ready when the socket opens.
      const collabManager = new CollabManager({
        app: this.app,
        crypto: this.cryptoService,
        send: (message) => this.liveSyncClient?.send(message) ?? false,
        getFileId: async (path) => {
          try {
            return (await localIndex.getByPath(path))?.fileId ?? null;
          } catch {
            return null; // index closed while shutting down
          }
        },
        isTextSynced: async (path, text) => {
          const record = await localIndex.getByPath(path);
          if (!record) return false;
          const hash = await this.cryptoService.hashContent(new TextEncoder().encode(text));
          return toBase64(hash) === record.lastContentHashBlinded;
        },
        mergeBase: async (path) => {
          const record = await localIndex.getByPath(path);
          if (!record) return null;
          const base = await localIndex.getBase(record.fileId).catch(() => undefined);
          return base && base.hash === record.lastContentHashBlinded ? base.text : null;
        },
        log: this.syncLog,
        isEnabled: () => this.settings.collabEnabled && !this.settings.syncPaused,
        loadServerText: async (fileId) => {
          try {
            const { ciphertext, iv } = unpackBlob(await this.remoteApi.downloadBlob(linkedVault.vaultId, fileId));
            const bytes = await this.cryptoService.decryptContent(ciphertext, iv);
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch (err) {
            console.warn("Syncstone: wiederhergestellte Version konnte nicht geladen werden", err);
            return null;
          }
        },
        onPresenceChange: () => this.headerActions?.refresh(),
        onLiveEnded: (file) => this.syncEngine?.handleLocalEvent("modify", file),
      });
      this.collabManager = collabManager;

      this.liveSyncClient = new LiveSyncClient(
        this.serverUrl,
        this.settings.sessionToken,
        linkedVault.vaultId,
        () => this.pollNow(),
        (connected) => {
          this.liveSyncConnected = connected;
          if (connected) collabManager.handleConnected();
          else collabManager.handleDisconnected();
          this.statusBar?.refresh();
        },
        (message) => collabManager.handleServerMessage(message),
        () => new Notice(t("session.ended"), 15_000),
      );
    }
    this.statusBar?.refresh();
    for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)) {
      if (leaf.view instanceof HistoryView) leaf.view.refresh();
    }
  }

  /** Puts the history view into the right sidebar once (as a tab next to backlinks etc.), without focusing it. */
  private async ensureHistoryLeaf(): Promise<void> {
    if (this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE).length > 0) return;
    await this.app.workspace.getRightLeaf(false)?.setViewState({ type: HISTORY_VIEW_TYPE, active: false });
  }

  /**
   * "Share as link" for a note, like in the web editor: the dialog creates the public link (an encrypted snapshot, the key
   * stays in the link), copies it, and sets expiry / password. Only the owner of the vault can publish.
   */
  async openPublish(file: TFile | null): Promise<void> {
    if (!file) return;
    const linked = this.settings.linkedVault;
    if (!linked || !this.syncEngine || !this.localIndex || !this.cryptoService.isUnlocked()) {
      new Notice(t("p.pub.needVault"));
      return;
    }
    if (linked.memberKey) {
      new Notice(t("p.pub.onlyOwner"));
      return;
    }
    if (file.extension.toLowerCase() !== "md") {
      new Notice(t("p.pub.onlyNotes"));
      return;
    }
    const record = await this.localIndex.getByPath(file.path);
    if (!record) {
      new Notice(t("p.pub.notSynced"));
      return;
    }
    if (!this.account?.webUrl) await this.refreshAccount(true);
    if (!this.account?.webUrl) {
      new Notice(t("p.pub.noWeb"));
      return;
    }
    const service = new PublishService({
      app: this.app,
      remote: this.remoteApi,
      crypto: this.cryptoService,
      vaultId: linked.vaultId,
      webBase: () => this.account?.webUrl ?? null,
    });
    new PublishModal(this.app, service, file, record.fileId).open();
  }

  /** Reveals the history view wherever the user docked it and shows `file` (or the vault's change log). */
  async openHistory(file: TFile | null, vault = false): Promise<void> {
    await this.ensureHistoryLeaf();
    const leaf = this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0];
    if (!leaf) return;
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!(view instanceof HistoryView)) return;
    if (vault) await view.showVault();
    else await view.showFile(file);
  }

  /** Opens (or updates) the main-area diff tab comparing `revisionId` of `fileId` against the current content. */
  async openRevisionDiff(fileId: string, revisionId: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(HISTORY_DIFF_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: HISTORY_DIFF_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof HistoryDiffView) await leaf.view.setTarget(fileId, revisionId);
  }

  /**
   * Writes what is typed in `path` to disk now and uploads it right away instead of after the usual delays. Used before
   * a restore: an edit still waiting there would otherwise be saved over the restored version a moment later.
   */
  async flushNote(path: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) {
        try {
          await view.save();
        } catch (err) {
          console.warn("Syncstone: Notiz konnte vor dem Wiederherstellen nicht gespeichert werden", err);
        }
      }
    }
    await this.syncEngine?.flushPath(path);
  }

  /** Shared by the periodic poll interval and the LiveSyncClient's push trigger (and a restore from the history view). */
  pollNow(): void {
    if (this.settings.syncPaused) return;
    void this.syncEngine?.runIncrementalPoll().catch((err) => {
      console.error("Syncstone: Remote-Polling fehlgeschlagen", err);
    });
    void this.configSyncEngine?.run().catch((err) => {
      console.error("Syncstone: Einstellungs-Sync fehlgeschlagen", err);
    });
  }

  /** Called from the settings tab when collaboration is switched on/off (or sync is paused/resumed). */
  refreshCollab(): void {
    this.collabManager?.requestRefresh();
  }

  private stopSync(): void {
    this.collabManager?.dispose();
    this.collabManager = null;
    this.liveSyncClient?.dispose();
    this.liveSyncClient = null;
    this.liveSyncConnected = false;
    this.syncEngine?.dispose();
    this.syncEngine = null;
    this.configSyncEngine = null;
    this.localIndex?.close();
    this.localIndex = null;
    this.statusBar?.refresh();
  }

  async runManualSync(): Promise<void> {
    if (!this.settings.backupAcknowledged) {
      await this.tryStartSync(); // shows the first-sync check
      return;
    }
    if (!this.syncEngine) {
      new Notice(t("p.noVaultOrPaused"));
      return;
    }
    new Notice(t("p.syncStarted"));
    this.statusBar?.refresh();
    try {
      this.syncEngine.retryFailed();
      await this.syncEngine.runFullSync();
      await this.configSyncEngine?.run();
      const failed = this.syncEngine.failedCount;
      new Notice(failed > 0 ? t("p.syncPartial", { count: failed }) : t("p.syncDone"));
    } catch (err) {
      console.error("Syncstone: Synchronisierung fehlgeschlagen", err);
      new Notice(t("p.syncFailed", { error: (err as Error).message }));
    }
    this.statusBar?.refresh();
  }

  /** Tries to unlock the crypto service from cached root bits in data.json (see CryptoService.ts for what these are). */
  private async tryUnlockFromCache(): Promise<boolean> {
    if (!this.settings.rememberKey || !this.settings.cachedKeyMaterial) return false;
    try {
      await this.cryptoService.unlockWithCachedRootBits(this.settings.cachedKeyMaterial.rootBitsBase64);
      return true;
    } catch (err) {
      console.error("Syncstone: gecachter Schlüssel konnte nicht verwendet werden", err);
      return false;
    }
  }
}

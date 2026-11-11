import { showsPlanSection } from "../sync/billing.js";
import { t } from "../i18n/index.js";
import { App, Notice, Platform, PluginSettingTab, Setting, setIcon, type TextComponent } from "obsidian";
import { defaultDeviceName } from "../deviceName.js";
import type SyncstonePlugin from "../main.js";
import type { LinkedVaultConfig } from "../types.js";
import { VaultLinkError, type VaultLinkResult } from "../sync/VaultLinkManager.js";
import { SyncstoneApiError } from "../sync/httpClient.js";
import { formatBytes } from "../ui/historyFormat.js";
import { HOSTED_SERVER_URL, normalizeServerUrl } from "../hosted.js";
import { openExternal } from "../openExternal.js";
import { RELEASES_URL } from "../sync/compat.js";

type PairingState = "idle" | "starting" | "waiting" | "denied" | "expired" | "error";

function describeError(err: unknown): string {
  if (err instanceof VaultLinkError) return err.message;
  if (err instanceof SyncstoneApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

interface PassphraseFormOptions {
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (passphrase: string, remember: boolean) => void | Promise<void>;
  onCancel?: () => void;
}

/**
 * Settings tab with three sections:
 *   1. Account          - server URL, browser-based device-pairing login
 *                          (like `gh auth login --web`), logout.
 *   2. Vault-Verknüpfung - local passphrase unlock for the ONE vault chosen
 *                          on the web panel during pairing (no in-plugin
 *                          vault list/creation any more - see
 *                          VaultLinkManager.ts).
 *   3. Sync-Status       - last sync time, manual sync, pause toggle, and an
 *                          optional live-sync connection indicator.
 *
 * Follows the common Obsidian settings-tab pattern of re-rendering the whole
 * tab (`this.display()`) after every state change instead of hand-patching
 * the DOM - simpler to keep correct for a tab with this much conditional
 * form state.
 */
export class SyncstoneSettingsTab extends PluginSettingTab {
  /**
   * Which collapsible sections are open. Kept on the tab (not re-derived) because
   * every state change re-renders the whole tab via display().
   */
  private readonly openSections = new Set<string>();

  // --- Account / device-pairing state ---
  private deviceName = "";
  private pairingState: PairingState = "idle";
  private pairingCode: string | null = null;
  private verificationUrl: string | null = null;
  private pollToken: string | null = null;
  private pairingError: string | null = null;
  private pollTimer: ReturnType<typeof window.setInterval> | null = null;
  /** A poll request is on its way: a second one must not start (the answer "approved" is single-use). */
  private pollInFlight = false;
  /** Asks at once when the app comes back to the front (the browser was in front meanwhile). */
  private resumeHandler: (() => void) | null = null;

  // --- Vault unlock state ---
  // Set once a device-pairing approval hands us a vaultId that isn't (yet)
  // the currently linked+configured one - see handleApproved().
  private pendingUnlockVaultId: string | null = null;
  private linkBusy = false;
  private linkError: string | null = null;

  constructor(
    app: App,
    private readonly plugin: SyncstonePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("syncstone-settings");
    this.renderStatus(containerEl);

    this.renderAccountSection(containerEl);
    this.renderVaultLinkSection(containerEl);
    this.renderPlanSection(containerEl);
    this.renderSyncStatusSection(containerEl);
    this.renderConfigSyncSection(containerEl);
    this.renderAdvancedSection(containerEl);
  }

  /** The top of the tab: one line that says where things stand (not signed in / locked / connected). */
  private renderStatus(parent: HTMLElement): void {
    const settings = this.plugin.settings;
    let tone: "off" | "warn" | "ok" = "off";
    let icon = "log-in";
    let text = t("p.hero.signedOut");
    if (settings.sessionToken) {
      if (!settings.linkedVault) {
        tone = "warn";
        icon = "unlink";
        text = t("p.hero.noVault");
      } else if (this.plugin.compat.state === "plugin-outdated" || this.plugin.compat.state === "server-outdated") {
        tone = "warn";
        icon = "circle-arrow-up";
        text = t(this.plugin.compat.state === "plugin-outdated" ? "p.hero.updateRequired" : "p.hero.serverUpdateRequired");
      } else if (!this.plugin.cryptoService.isUnlocked()) {
        tone = "warn";
        icon = "lock";
        text = t("p.hero.locked", { vault: settings.linkedVault.vaultName });
      } else {
        tone = "ok";
        icon = "check";
        text = t("p.hero.connected", { vault: settings.linkedVault.vaultName });
      }
    }
    const status = parent.createDiv({ cls: "syncstone-status" });
    setIcon(status.createSpan({ cls: `syncstone-status-icon is-${tone}` }), icon);
    status.createSpan({ cls: "syncstone-status-text", text });
    if (settings.accountUsername && settings.sessionToken) status.createSpan({ cls: "syncstone-status-account", text: settings.accountUsername });
    this.renderUpdateInfo(parent);

    // "Not now" on the first-sync check: sync stays off until it is confirmed (opened again from here or the status menu).
    if (settings.linkedVault && !settings.backupAcknowledged) {
      new Setting(parent)
        .setName(t("p.firstSync.title"))
        .setDesc(t("p.backup.pending"))
        .addButton((btn) =>
          btn
            .setButtonText(t("p.firstSync.open"))
            .setCta()
            .onClick(() => void this.plugin.tryStartSync()),
        );
    }
  }

  /** A newer plugin is out, or plugin and server do not fit together: said at the very top, with the way out. */
  private renderUpdateInfo(parent: HTMLElement): void {
    const { state, updateAvailable } = this.plugin.compat;
    if (state === "ok" && !updateAvailable) return;
    const installed = t("p.update.installed", { version: this.plugin.manifest.version });
    let name: string;
    let desc: string;
    if (state === "plugin-outdated") {
      name = t("p.update.requiredTitle");
      desc = t("p.update.required");
    } else if (state === "server-outdated") {
      name = t("p.update.serverTitle");
      desc = this.plugin.isSelfHosted() ? t("p.update.serverOutdated") : t("p.update.serverBusy");
    } else {
      name = t("p.update.availableTitle", { version: updateAvailable ?? "" });
      desc = t("p.update.availableDesc");
    }
    const setting = new Setting(parent).setName(name).setDesc(`${desc} ${installed}`);
    setting.settingEl.addClass("syncstone-update-info");
    if (state !== "server-outdated") {
      setting.addButton((btn) =>
        btn
          .setButtonText(t("p.update.open"))
          .setCta()
          .onClick(() => {
            const app = this.app as unknown as { setting: { openTabById(id: string): void } };
            app.setting.openTabById("community-plugins");
          }),
      );
    }
    setting.addButton((btn) => btn.setButtonText(t("p.update.whatsNew")).onClick(() => openExternal(RELEASES_URL)));
  }

  /**
   * A group of settings under a heading, the way Obsidian's own tabs and most plugins do it. Returns the element to
   * render the group's settings into. `collapsible` (native <details>, so it works with touch and keyboard) is for the
   * rarely needed groups; `nested` is a lighter dropdown inside a group.
   */
  private section(parent: HTMLElement, id: string, title: string, options: { nested?: boolean; collapsible?: boolean; summary?: string } = {}): HTMLElement {
    if (!options.nested && !options.collapsible) {
      const group = parent.createDiv({ cls: "syncstone-group" });
      new Setting(group).setName(title).setHeading();
      return group;
    }

    const details = parent.createEl("details", { cls: options.nested ? "syncstone-dropdown" : "syncstone-section" });
    details.open = this.openSections.has(id);
    details.addEventListener("toggle", () => {
      if (details.open) this.openSections.add(id);
      else this.openSections.delete(id);
    });

    const summary = details.createEl("summary", { cls: "syncstone-section-title" });
    summary.createSpan({ text: title });
    if (options.summary) summary.createSpan({ cls: "syncstone-section-summary", text: options.summary });
    return details.createDiv({ cls: "syncstone-section-body" });
  }

  hide(): void {
    // The settings tab can be closed mid-pairing (e.g. user switches to
    // another settings pane) - stop polling rather than leaking a timer that
    // keeps firing (and re-rendering a DOM nobody can see) in the
    // background. A fresh pairing attempt can always be started again.
    this.clearPollTimer();
  }

  // ============================================================
  // 1. Account
  // ============================================================

  private renderAccountSection(parent: HTMLElement): void {
    const containerEl = this.section(parent, "account", "Account");

    // The hosted service is the default and needs no address. This build may not know it yet (see hosted.ts).
    if (!this.plugin.settings.selfHosted && !normalizeServerUrl(HOSTED_SERVER_URL) && !this.plugin.settings.sessionToken) {
      containerEl.createEl("p", { text: t("p.hostedMissing"), cls: "syncstone-warning-text" });
    }

    if (this.plugin.settings.sessionToken) {
      new Setting(containerEl)
        .setName(t("p.signedIn"))
        .setDesc(this.plugin.settings.accountUsername ?? "")
        .addButton((btn) =>
          btn.setButtonText(t("p.signOut")).onClick(() => {
            void this.logout();
          }),
        );
      this.renderDeviceNameSetting(containerEl);
      return;
    }

    this.renderDevicePairingFlow(containerEl, "login");
  }

  /**
   * Renders the device-pairing widget: a device-name field + start button
   * when idle, the pairing code + "waiting" state while polling, or a
   * denied/expired message with a retry button. Used both here (to log in
   * when there's no session at all) and from the vault-link section below
   * (to link a vault while already logged in, e.g. after t("p.unlink")).
   */
  private renderDevicePairingFlow(containerEl: HTMLElement, mode: "login" | "link"): void {
    if (this.pairingState === "idle") {
      let deviceName = this.deviceName || this.plugin.settings.deviceName || this.defaultDeviceName();

      new Setting(containerEl)
        .setName(t("p.deviceName"))
        .setDesc(t("p.deviceNameHint"))
        .addText((text) => text.setValue(deviceName).onChange((v) => (deviceName = v.trim())));

      new Setting(containerEl).addButton((btn) =>
        btn
          .setButtonText(mode === "link" ? t("p.linkVault") : t("p.signInBrowser"))
          .setCta()
          .onClick(() => {
            this.deviceName = deviceName || this.defaultDeviceName();
            void this.startDevicePairing();
          }),
      );
      return;
    }

    if (this.pairingState === "starting") {
      containerEl.createEl("p", { text: t("p.starting") });
      return;
    }

    if (this.pairingState === "waiting") {
      // hide() (called when the user navigates away from this tab) stops
      // the poll timer so it doesn't keep firing into a hidden tab forever;
      // if they come back while still "waiting", restart it here rather
      // than leaving the UI stuck with no active polling.
      if (this.pollToken && this.pollTimer === null) this.startPolling();

      const wrap = containerEl.createDiv({ cls: "syncstone-pairing" });
      wrap.createEl("p", { text: t("p.confirmCode") });
      wrap.createDiv({ text: this.pairingCode ?? "", cls: "syncstone-pairing-code" });

      if (this.verificationUrl) {
        const linkPara = wrap.createEl("p", { cls: "syncstone-pairing-link" });
        linkPara.appendText(t("p.browserNotOpening"));
        const link = linkPara.createEl("a", { text: this.verificationUrl, href: this.verificationUrl });
        link.setAttr("target", "_blank");
        link.setAttr("rel", "noopener noreferrer");
      }

      wrap.createEl("p", { text: t("p.waiting") });

      new Setting(wrap).addButton((btn) => btn.setButtonText(t("common.cancel")).onClick(() => this.cancelPairing()));
      return;
    }

    if (this.pairingState === "denied") {
      containerEl.createEl("p", { text: t("p.denied"), cls: "syncstone-error-text" });
      new Setting(containerEl).addButton((btn) =>
        btn
          .setButtonText(t("p.retry"))
          .setCta()
          .onClick(() => {
            this.pairingState = "idle";
            this.display();
          }),
      );
      return;
    }

    // "expired" (terminal poll status, or any poll failure/404 - see
    // pollOnce()) and "error" (starting the pairing itself failed, e.g. bad
    // server URL) both land here, just with different messages.
    containerEl.createEl("p", {
      text:
        this.pairingState === "expired"
          ? t("p.expired")
          : (this.pairingError ?? t("p.signInFailed")),
      cls: "syncstone-error-text",
    });
    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText(t("p.retry"))
        .setCta()
        .onClick(() => {
          this.pairingState = "idle";
          this.pairingError = null;
          this.display();
        }),
    );
  }

  /** Rename this device (server-side), so it's recognisable in the web panel and next to live cursors. */
  private renderDeviceNameSetting(containerEl: HTMLElement): void {
    const initial = this.plugin.settings.deviceName ?? this.defaultDeviceName();
    let name = initial;
    let input: TextComponent | null = null;

    new Setting(containerEl)
      .setName(t("p.deviceName"))
      .setDesc(t("p.deviceNameLong"))
      .addText((text) => {
        input = text;
        text.setValue(initial).onChange((value) => (name = value.trim()));
      })
      .addButton((btn) => btn.setButtonText(t("p.save")).onClick(() => void this.renameDevice(name)));

    // Devices paired before this setting existed don't have the name stored locally yet - take it from the server.
    if (!this.plugin.settings.deviceName) {
      void this.plugin.remoteApi
        .getCurrentDeviceName()
        .then(async (remoteName) => {
          if (!remoteName) return;
          this.plugin.settings.deviceName = remoteName;
          await this.plugin.saveSettings();
          if (name === initial) {
            name = remoteName; // the user hasn't typed anything yet
            input?.setValue(remoteName);
          }
        })
        .catch((err) => console.error("Syncstone: Gerätename konnte nicht geladen werden", err));
    }
  }

  private async renameDevice(name: string): Promise<void> {
    if (!name) {
      new Notice(t("p.nameEmpty"));
      return;
    }
    try {
      await this.plugin.remoteApi.renameCurrentDevice(name);
      this.plugin.settings.deviceName = name;
      await this.plugin.saveSettings();
      new Notice(t("p.nameChanged", { name }));
    } catch (err) {
      new Notice(t("p.renameFailed", { error: describeError(err) }));
    }
  }

  private defaultDeviceName(): string {
    return defaultDeviceName();
  }

  private async startDevicePairing(): Promise<void> {
    this.pairingState = "starting";
    this.pairingError = null;
    this.display();
    try {
      const result = await this.plugin.authClient.startDeviceAuth(this.deviceName || this.defaultDeviceName());
      this.pairingCode = result.pairingCode;
      this.verificationUrl = result.verificationUrl;
      this.pollToken = result.pollToken;
      this.pairingState = "waiting";
      this.display();
      // window.open (not require('electron').shell or any Node API) is the
      // correct cross-platform way to hand off to the system/external
      // browser from an Obsidian plugin on both Electron desktop and mobile
      // WebView. The clickable link rendered above is the fallback in case
      // this doesn't fire in some environment.
      openExternal(result.verificationUrl);
      this.startPolling();
    } catch (err) {
      this.pairingState = "error";
      this.pairingError = describeError(err);
      this.display();
    }
  }

  private startPolling(): void {
    this.clearPollTimer();
    this.pollTimer = window.setInterval(() => void this.pollOnce(), 1500);
    // While the browser is in front, a phone suspends Obsidian - the timer only ticks again some time after the return.
    // So ask the moment the app is visible / focused again (and when the confirmation page opens obsidian://syncstone-pair).
    this.resumeHandler = () => {
      if (document.visibilityState === "visible") void this.pollOnce();
    };
    document.addEventListener("visibilitychange", this.resumeHandler);
    window.addEventListener("focus", this.resumeHandler);
  }

  /** From the obsidian://syncstone-pair link: ask the server now. */
  pollPairingNow(): void {
    if (this.pollToken) void this.pollOnce();
  }

  private async pollOnce(): Promise<void> {
    const pollToken = this.pollToken;
    if (!pollToken || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const result = await this.plugin.authClient.pollDeviceAuth(pollToken);
      if (result.status === "pending") return; // keep polling

      this.clearPollTimer();

      if (result.status === "approved" && result.sessionToken && result.vaultId) {
        await this.handleApproved(result.sessionToken, result.vaultId);
      } else if (result.status === "denied") {
        this.pairingState = "denied";
        this.display();
      } else {
        // "expired", or an "approved" response missing its payload (should
        // not happen per the DTO, but don't hang forever if it does).
        this.pairingState = "expired";
        this.display();
      }
    } catch (err) {
      // Any poll error - including the 404 the server returns once a
      // pairing has already resolved and is polled again - is terminal:
      // stop polling and let the user retry, per AuthClient.pollDeviceAuth.
      console.error("Syncstone: Device-Pairing-Poll fehlgeschlagen", err);
      this.clearPollTimer();
      this.pairingState = "expired";
      this.display();
    } finally {
      this.pollInFlight = false;
    }
  }

  private cancelPairing(): void {
    this.clearPollTimer();
    this.pollToken = null;
    this.pairingCode = null;
    this.verificationUrl = null;
    this.pairingState = "idle";
    this.display();
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.resumeHandler) {
      document.removeEventListener("visibilitychange", this.resumeHandler);
      window.removeEventListener("focus", this.resumeHandler);
      this.resumeHandler = null;
    }
  }

  /**
   * A device pairing was approved on the web panel: we now have a fresh
   * session token and the id of the vault the user picked there. If it's
   * the same vault we already have configured, just let the normal
   * cached-key-or-manual-unlock path (tryStartSync / the "gesperrt" unlock
   * form below) handle it. Otherwise the new vault still needs its
   * encryption passphrase entered once, locally - that secret never touches
   * the server, so no browser step can hand it over.
   */
  private async handleApproved(sessionToken: string, vaultId: string): Promise<void> {
    this.plugin.settings.sessionToken = sessionToken;
    // DevicePollResponse doesn't carry an expiry (unlike the old
    // session-token response) - leave it unset rather than guessing one.
    this.plugin.settings.sessionExpiresAt = null;
    this.plugin.settings.deviceName = this.deviceName || this.defaultDeviceName();
    await this.plugin.saveSettings();

    // The account name is only decoration: it is fetched while the rest goes on instead of holding the sign-in back.
    void this.plugin.authClient
      .getMe(sessionToken)
      .then(async (me) => {
        // A self-hosted server signs in with a user name, the hosted service with an e-mail address.
        const account = me as { username?: string; email?: string };
        this.plugin.settings.accountUsername = account.username ?? account.email ?? null;
        await this.plugin.saveSettings();
        this.display();
      })
      .catch((err) => console.error("Syncstone: Kontoinformationen konnten nicht geladen werden", err));

    this.pairingState = "idle";
    this.pairingCode = null;
    this.verificationUrl = null;
    this.pollToken = null;

    const linked = this.plugin.settings.linkedVault;
    if (linked && linked.vaultId === vaultId) {
      await this.plugin.tryStartSync();
    } else {
      this.plugin.settings.linkedVault = null;
      this.plugin.settings.rememberKey = false;
      this.plugin.settings.cachedKeyMaterial = null;
      this.plugin.cryptoService.lock();
      await this.plugin.saveSettings();
      await this.plugin.tryStartSync(); // stops any previous sync engine
      this.pendingUnlockVaultId = vaultId;
    }

    // Coming back from the browser the user may not see the settings tab: say it worked and what is still missing.
    const needsPassphrase = this.pendingUnlockVaultId !== null || !this.plugin.cryptoService.isUnlocked();
    new Notice(t(needsPassphrase ? "p.pair.connectedEnterPass" : "p.pair.connected"), needsPassphrase ? 10000 : undefined);
    if (needsPassphrase) this.openOwnTab();

    this.display();
  }

  /** Brings Obsidian's settings to this plugin's tab (e.g. after the pairing so the passphrase form is in view). */
  private openOwnTab(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    try {
      setting?.open();
      setting?.openTabById(this.plugin.manifest.id);
    } catch (err) {
      console.error("Syncstone: Einstellungen konnten nicht geöffnet werden", err);
    }
  }

  private async logout(): Promise<void> {
    const token = this.plugin.settings.sessionToken;
    try {
      if (token) await this.plugin.authClient.logout(token);
    } catch (err) {
      console.error("Syncstone: Logout fehlgeschlagen", err);
    }
    this.plugin.settings.sessionToken = null;
    this.plugin.settings.sessionExpiresAt = null;
    this.plugin.settings.accountUsername = null;
    this.pendingUnlockVaultId = null;
    this.pairingState = "idle";
    await this.plugin.saveSettings();
    await this.plugin.tryStartSync(); // stops sync - sessionToken is gone
    this.display();
  }

  // ============================================================
  // 2. Vault-Verknüpfung
  // ============================================================

  /**
   * Storage used / quota with a bar, the plan state (trial, read-only) and a link to the plan page. Shown in the vault
   * and the sync section; the numbers come from the account the plugin refreshes after every sync.
   */
  private renderStorageSetting(containerEl: HTMLElement): void {
    const account = this.plugin.account;
    if (!account) {
      // Not loaded yet (or offline): ask once, the tab re-renders when the answer is in.
      void this.plugin.refreshAccount(true).then(() => this.plugin.account && this.display());
      return;
    }
    const used = account.storageUsedBytes;
    const quota = account.storageQuotaBytes;
    const full = account.readOnly ? false : quota !== null && quota > 0 && used >= quota;
    const percent = quota ? Math.min(100, Math.floor((used / quota) * 100)) : 0;
    const date = (iso: string) => new Date(iso).toLocaleDateString();

    const setting = new Setting(containerEl)
      .setName(t("p.storage"))
      .setDesc(quota ? t("p.storageOf", { used: formatBytes(used), quota: formatBytes(quota), percent }) : t("p.storageNoLimit", { used: formatBytes(used) }));

    if (quota) {
      const bar = setting.descEl.createDiv({ cls: "syncstone-storage-bar" });
      const fill = bar.createDiv({ cls: "syncstone-storage-fill" });
      fill.style.width = `${percent}%`;
      if (full) fill.addClass("is-full");
      else if (used >= quota * 0.8) fill.addClass("is-nearly");
    }
    if (account.readOnly) setting.descEl.createDiv({ cls: "syncstone-storage-warning", text: t("p.readOnly") });
    else if (full) setting.descEl.createDiv({ cls: "syncstone-storage-warning", text: t("p.storageFull") });
    if (account.billingState === "trial" && account.trialEndsAt) setting.descEl.createDiv({ text: t("p.trialEnds", { date: date(account.trialEndsAt) }) });
    if (account.dataDeleteAt && account.billingState !== "active") setting.descEl.createDiv({ cls: "syncstone-storage-warning", text: t("p.deleteOn", { date: date(account.dataDeleteAt) }) });

    if (account.billingState !== "unmanaged" && account.webUrl) {
      const planUrl = `${account.webUrl.replace(/\/+$/, "")}/account/billing`;
      setting.addButton((btn) => btn.setButtonText(t("p.openPlanBtn")).onClick(() => openExternal(planUrl)));
    }
  }

  // ============================================================
  // 2b. Plan (hosted service only)
  // ============================================================

  /**
   * Plan, subscription state, storage and limits - the same facts as the web app's "Plan" tab. Only shown when the
   * server is the hosted Syncstone service (a self-hosted server has no plans and answers nothing here).
   */
  private renderPlanSection(parent: HTMLElement): void {
    if (!this.plugin.settings.sessionToken) return;
    // Ask (the plugin throttles it); the first answer decides whether this section exists at all, so redraw then.
    void this.plugin.loadBilling().then((changed) => {
      if (changed) this.display();
    });
    const info = this.plugin.billing;
    if (!showsPlanSection(info)) return;

    const planBytes = info.plans.find((plan) => plan.id === (info.plan ?? info.compedPlan))?.quotaBytes ?? null;
    const stateLabel = t(`p.plan.state.${info.state}`) + (planBytes ? ` · ${formatBytes(planBytes)}` : "");
    const containerEl = this.section(parent, "plan", t("p.plan.title"));
    const date = (iso: string) => new Date(iso).toLocaleDateString();
    const webUrl = (this.plugin.account?.webUrl ?? this.plugin.serverUrl).replace(/\/+$/, "");
    const openPlanPage = () => openExternal(`${webUrl}/account/billing`);

    // Storage with its bar.
    const used = info.usedBytes;
    const quota = info.quotaBytes;
    const percent = quota ? Math.min(100, Math.floor((used / quota) * 100)) : 0;
    const storage = new Setting(containerEl)
      .setName(t("p.storage"))
      .setDesc(quota ? t("p.storageOf", { used: formatBytes(used), quota: formatBytes(quota), percent }) : t("p.storageNoLimit", { used: formatBytes(used) }));
    if (quota) {
      const bar = storage.descEl.createDiv({ cls: "syncstone-storage-bar" });
      const fill = bar.createDiv({ cls: "syncstone-storage-fill" });
      fill.style.width = `${percent}%`;
      if (used >= quota) fill.addClass("is-full");
      else if (used >= quota * 0.8) fill.addClass("is-nearly");
      if (used >= quota && info.state !== "read_only" && info.state !== "expired") storage.descEl.createDiv({ cls: "syncstone-storage-warning", text: t("p.storageFull") });
    }

    // State of the subscription, with what happens next.
    let detail: string | null = null;
    if (info.state === "trial" && info.trialEndsAt) detail = t("p.plan.trialEnds", { date: date(info.trialEndsAt) });
    else if ((info.state === "active" || info.state === "past_due") && info.currentPeriodEnd) {
      detail = info.cancelAtPeriodEnd ? t("p.plan.cancelsOn", { date: date(info.currentPeriodEnd) }) : t("p.plan.renews", { date: date(info.currentPeriodEnd) });
    } else if ((info.state === "read_only" || info.state === "expired") && info.dataDeleteAt) detail = t("p.plan.deleteOn", { date: date(info.dataDeleteAt) });
    else if (info.compedPlan) detail = t("p.plan.comped");
    const state = new Setting(containerEl).setName(stateLabel);
    if (detail) state.setDesc(detail);
    if (info.state === "read_only" || info.state === "expired" || info.state === "past_due") state.descEl.addClass("syncstone-storage-warning");
    if (info.hasCustomer) state.addButton((btn) => btn.setButtonText(t("p.plan.manage")).onClick(openPlanPage));

    // Limits of the plan.
    new Setting(containerEl).setName(t("p.plan.maxFile")).setDesc(formatBytes(info.maxFileBytes));
    new Setting(containerEl).setName(t("p.plan.history")).setDesc(t("p.plan.historyDays", { days: info.historyDays }));

    // Choose / change the plan (storage) on the web page.
    if (!info.visible) {
      containerEl.createEl("p", { cls: "setting-item-description", text: t("p.plan.unavailable") });
      return;
    }
    if (!info.enabled) containerEl.createEl("p", { cls: "setting-item-description", text: t("p.plan.soon") });
    if (info.soldOut && !info.hasSubscription) containerEl.createEl("p", { cls: "setting-item-description", text: t("p.plan.soldOut") });
    new Setting(containerEl)
      .setName(t("p.plan.plans"))
      .setDesc(t("p.plan.choose"))
      .addButton((btn) => btn.setButtonText(t("p.plan.manageStorage")).setCta().onClick(openPlanPage));
  }

  private renderVaultLinkSection(parent: HTMLElement): void {
    if (!this.plugin.settings.sessionToken) return;
    const containerEl = this.section(parent, "vault", t("p.vaultLink"));

    const linked = this.plugin.settings.linkedVault;
    if (linked && !this.pendingUnlockVaultId) {
      new Setting(containerEl)
        .setName(t("p.linkedTo", { name: linked.vaultName }))
        .setDesc(this.plugin.cryptoService.isUnlocked() ? t("p.unlocked") : t("p.locked"))
        .addButton((btn) =>
          btn
            .setButtonText(t("p.unlink"))
            .setWarning()
            .onClick(() => void this.unlinkVault()),
        );

      // On the hosted service the plan section below shows the storage; a self-hosted server has no plan section.
      if (!showsPlanSection(this.plugin.billing)) this.renderStorageSetting(containerEl);

      if (!this.plugin.cryptoService.isUnlocked()) {
        this.renderUnlockForm(containerEl, linked);
      }
      return;
    }

    if (this.pendingUnlockVaultId) {
      containerEl.createEl("p", {
        text: t("p.chosenEnterPass"),
      });
      this.renderPassphraseForm(containerEl, {
        submitLabel: t("p.unlock"),
        busy: this.linkBusy,
        error: this.linkError,
        onSubmit: (passphrase, remember) => this.unlockPendingVault(passphrase, remember),
      });
      return;
    }

    containerEl.createEl("p", {
      text: t("p.noVault"),
    });
    this.renderDevicePairingFlow(containerEl, "link");
  }

  /** Shared passphrase + "remember key" form, reused for unlocking a newly-picked vault and for re-unlocking an already-linked one. */
  private renderPassphraseForm(containerEl: HTMLElement, opts: PassphraseFormOptions): void {
    const wrap = containerEl.createDiv({ cls: "syncstone-passphrase-form" });

    let passphrase = "";
    let remember = false;

    new Setting(wrap).setName(t("p.passphrase")).addText((text) => {
      text.inputEl.type = "password";
      text.onChange((v) => (passphrase = v));
    });

    new Setting(wrap)
      .setName(t("p.rememberKey"))
      .setDesc(
        t("p.rememberKeyHint"),
      )
      .addToggle((toggle) => toggle.setValue(false).onChange((v) => (remember = v)));

    if (opts.error) {
      wrap.createEl("p", { text: opts.error, cls: "syncstone-error-text" });
    }

    const row = new Setting(wrap);
    row.addButton((btn) =>
      btn
        .setButtonText(opts.submitLabel)
        .setCta()
        .setDisabled(opts.busy)
        .onClick(() => {
          if (!passphrase) {
            this.linkError = t("p.enterPass");
            this.display();
            return;
          }
          void opts.onSubmit(passphrase, remember);
        }),
    );
    if (opts.onCancel) {
      const onCancel = opts.onCancel;
      row.addButton((btn) => btn.setButtonText(t("common.cancel")).onClick(onCancel));
    }
  }

  private async unlockPendingVault(passphrase: string, remember: boolean): Promise<void> {
    if (!this.pendingUnlockVaultId) return;
    this.linkBusy = true;
    this.linkError = null;
    this.display();
    try {
      const result = await this.plugin.vaultLinkManager.unlockVault(this.pendingUnlockVaultId, passphrase, remember);
      await this.applyVaultLink(result, remember);
      this.pendingUnlockVaultId = null;
      new Notice(t("p.vaultLinked", { name: result.config.vaultName }));
    } catch (err) {
      this.linkError = describeError(err);
    } finally {
      this.linkBusy = false;
      this.display();
    }
  }

  private async applyVaultLink(result: VaultLinkResult, remember: boolean): Promise<void> {
    this.plugin.settings.linkedVault = result.config;
    this.plugin.settings.backupAcknowledged = false; // a newly linked vault gets the first-sync check before anything moves
    this.plugin.settings.rememberKey = remember;
    this.plugin.settings.cachedKeyMaterial = remember && result.rootBitsBase64 ? { rootBitsBase64: result.rootBitsBase64 } : null;
    this.plugin.settings.lastSyncAt = null;
    await this.plugin.saveSettings();
    await this.plugin.tryStartSync();
  }

  private renderUnlockForm(containerEl: HTMLElement, linked: LinkedVaultConfig): void {
    this.renderPassphraseForm(containerEl, {
      submitLabel: t("p.unlock"),
      busy: this.linkBusy,
      error: this.linkError,
      onSubmit: async (passphrase, remember) => {
        this.linkBusy = true;
        this.linkError = null;
        this.display();
        try {
          let rootBitsBase64: string | null = null;
          if (linked.memberKey) {
            // Shared vault: the passphrase opens the user's own wrapped copy of the key, not the owner's kdf parameters.
            rootBitsBase64 = (await this.plugin.cryptoService.unlockMemberWithPassphrase(passphrase, linked.vaultId, linked.memberKey)).rootBitsBase64;
          } else if (remember) {
            rootBitsBase64 = (
              await this.plugin.cryptoService.unlockAndDeriveRootBitsForCaching(passphrase, linked.kdfSalt, linked.kdfIterations)
            ).rootBitsBase64;
          } else {
            await this.plugin.cryptoService.unlockWithPassphrase(passphrase, linked.kdfSalt, linked.kdfIterations);
          }
          const ok = await this.plugin.cryptoService.verifyAgainstBlob(
            linked.vaultName,
            linked.verificationBlob,
            linked.verificationNonce,
          );
          if (!ok) throw new VaultLinkError(t("p.wrongPass"));
          if (remember && rootBitsBase64) {
            this.plugin.settings.rememberKey = true;
            this.plugin.settings.cachedKeyMaterial = { rootBitsBase64 };
          }
          await this.plugin.saveSettings();
          await this.plugin.tryStartSync();
        } catch (err) {
          this.plugin.cryptoService.lock();
          this.linkError = describeError(err);
        } finally {
          this.linkBusy = false;
          this.display();
        }
      },
    });
  }

  private async unlinkVault(): Promise<void> {
    // Note: the local IndexedDB mapping table for this vault (see
    // LocalIndex.ts) is deliberately left in place, not destroyed - if the
    // user re-links the same vault later it's simply reused; it just sits
    // unused otherwise. Call `LocalIndex.destroy(vaultId)` explicitly if a
    // future UI wants an explicit "forget this vault" action.
    this.plugin.settings.linkedVault = null;
    this.plugin.settings.rememberKey = false;
    this.plugin.settings.cachedKeyMaterial = null;
    this.plugin.settings.lastSyncAt = null;
    this.plugin.cryptoService.lock();
    await this.plugin.saveSettings();
    await this.plugin.tryStartSync();
    this.display();
  }

  // ============================================================
  // 3. Sync-Status
  // ============================================================

  private renderSyncStatusSection(parent: HTMLElement): void {
    const containerEl = this.section(parent, "sync", t("p.syncStatus"));

    new Setting(containerEl)
      .setName(t("p.lastSync"))
      .setDesc(this.plugin.settings.lastSyncAt ? new Date(this.plugin.settings.lastSyncAt).toLocaleString() : t("p.never"));

    if (this.plugin.syncEngine) {
      new Setting(containerEl)
        .setName(t("p.liveSync"))
        .setDesc(this.plugin.liveSyncConnected ? t("p.connected") : t("p.disconnected"));
    }

    new Setting(containerEl)
      .setName(t("p.collab"))
      .setDesc(
        t("p.collabHint"),
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.collabEnabled).onChange(async (value) => {
          this.plugin.settings.collabEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshCollab();
        }),
      );

    // Only a phone / tablet has the limit; the choice is stored per device.
    if (Platform.isMobile) {
      new Setting(containerEl)
        .setName(t("p.mobileLimit"))
        .setDesc(t("p.mobileLimitDesc"))
        .addDropdown((dropdown) =>
          dropdown
            .addOption("25", "25 MB")
            .addOption("50", "50 MB")
            .addOption("100", "100 MB")
            .addOption("250", "250 MB")
            .addOption("0", t("p.mobileLimit.none"))
            .setValue(String(this.plugin.settings.mobileMaxFileMb))
            .onChange(async (value) => {
              this.plugin.settings.mobileMaxFileMb = Number(value);
              await this.plugin.saveSettings();
              // Files that were skipped before are picked up now.
              if (this.plugin.syncEngine) void this.plugin.runManualSync();
            }),
        );
    }

    new Setting(containerEl).setName(t("p.syncNow")).addButton((btn) =>
      btn
        .setButtonText(t("p.syncNow"))
        .setDisabled(!this.plugin.syncEngine)
        .onClick(async () => {
          await this.plugin.runManualSync();
          this.display();
        }),
    );

    new Setting(containerEl)
      .setName(t("p.paused"))
      .setDesc(t("p.pausedHint"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncPaused).onChange(async (value) => {
          this.plugin.settings.syncPaused = value;
          await this.plugin.saveSettings();
          this.plugin.refreshCollab();
        }),
      );
  }

  // ============================================================
  // 4. Einstellungen synchronisieren (.obsidian/* - plugins, themes, etc.)
  // ============================================================

  private renderConfigSyncSection(parent: HTMLElement): void {
    const config = this.plugin.settings.configSync;
    const containerEl = this.section(parent, "config", t("p.syncSettings"));
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t("p.syncSettingsHint"),
    });

    new Setting(containerEl)
      .setName(t("p.syncSettings"))
      .setDesc(t("p.syncSettingsToggle"))
      .addToggle((toggle) =>
        toggle.setValue(config.enabled).onChange(async (value) => {
          config.enabled = value;
          if (value) this.openSections.add("config-categories"); // show the choices right away
          await this.plugin.saveSettings();
          if (value) void this.plugin.configSyncEngine?.run().catch((err) => console.error("Syncstone: Einstellungs-Sync fehlgeschlagen", err));
          this.display();
        }),
      );

    // Nothing to choose while it's off - no greyed-out list cluttering the tab.
    if (!config.enabled) return;

    const categories: Array<{
      key: "coreSettings" | "communityPlugins" | "themes" | "snippets" | "hotkeys" | "workspace";
      name: string;
      desc: string;
    }> = [
      { key: "coreSettings", name: t("p.catCore"), desc: t("p.catCoreHint") },
      {
        key: "communityPlugins",
        name: t("p.catPlugins"),
        desc: t("p.catPluginsHint"),
      },
      { key: "themes", name: t("p.catThemes"), desc: t("p.catThemesHint") },
      { key: "snippets", name: t("p.catSnippets"), desc: t("p.catSnippetsHint") },
      { key: "hotkeys", name: t("p.catHotkeys"), desc: t("p.catHotkeysHint") },
      {
        key: "workspace",
        name: t("p.catWorkspace"),
        desc: t("p.catWorkspaceHint"),
      },
    ];

    const countActive = () => categories.filter((category) => config[category.key]).length;
    const dropdown = this.section(containerEl, "config-categories", t("p.whatToSync"), {
      nested: true,
      summary: `${countActive()} von ${categories.length} aktiv`,
    });

    for (const category of categories) {
      new Setting(dropdown)
        .setName(category.name)
        .setDesc(category.desc)
        .addToggle((toggle) =>
          toggle.setValue(config[category.key]).onChange(async (value) => {
            config[category.key] = value;
            await this.plugin.saveSettings();
            void this.plugin.configSyncEngine?.run().catch((err) => console.error("Syncstone: Einstellungs-Sync fehlgeschlagen", err));
            // Keep the "n von 6 aktiv" hint current without collapsing the dropdown.
            dropdown.parentElement?.querySelector(".syncstone-section-summary")?.setText(`${countActive()} von ${categories.length} aktiv`);
          }),
        );
    }
  }
  // ============================================================
  // 5. Erweitert (self-hosting)
  // ============================================================

  /**
   * Out of the way on purpose: almost everybody uses the hosted service, which needs no address. Whoever runs their own
   * server switches it on here and enters the address of its API server.
   */
  private renderAdvancedSection(parent: HTMLElement): void {
    const settings = this.plugin.settings;
    const containerEl = this.section(parent, "advanced", t("p.advanced"), {
      collapsible: true,
      summary: settings.selfHosted ? t("p.server.own") : undefined,
    });
    // The session belongs to one server: the choice can only change while signed out.
    const locked = settings.sessionToken !== null;

    new Setting(containerEl)
      .setName(t("p.selfHost"))
      .setDesc(locked ? t("p.selfHostLocked") : t("p.selfHostDesc"))
      .addToggle((toggle) =>
        toggle
          .setValue(settings.selfHosted)
          .setDisabled(locked)
          .onChange(async (value) => {
            settings.selfHosted = value;
            if (value) this.openSections.add("advanced");
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (!settings.selfHosted) {
      containerEl.createEl("p", { cls: "setting-item-description", text: t("p.server.hosted") });
      return;
    }

    new Setting(containerEl)
      .setName(t("p.apiUrl"))
      .setDesc(t("p.apiUrlHint"))
      .addText((text) =>
        text
          .setPlaceholder("https://api.example.com")
          .setValue(settings.serverUrl)
          .setDisabled(locked)
          .onChange(async (value) => {
            settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}

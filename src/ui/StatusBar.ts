/**
 * The sync status model plus its click menu. There is no bottom status bar item
 * any more: on every platform the status lives as an icon in the note header
 * (top right, see HeaderActions.ts), exactly like on mobile. This class is the
 * shared part - it computes the status from state that already lives on the
 * plugin (settings, cryptoService, syncEngine, liveSyncClient), builds the menu
 * and is nudged (`refresh`) after key actions so the header icon updates at once.
 */
import { t } from "../i18n/index.js";
import { type App, Menu, Notice } from "obsidian";
import type SyncstonePlugin from "../main.js";
import { openExternal } from "../openExternal.js";
import { RELEASES_URL } from "../sync/compat.js";

export type Status =
  | { kind: "not-configured" }
  /** The server needs a newer plugin: sync pauses until the plugin is updated. */
  | { kind: "plugin-outdated" }
  /** The plugin needs a newer server (self-hosted): sync pauses until the server is updated. */
  | { kind: "server-outdated" }
  | { kind: "locked" }
  /** The server refuses changes: the storage quota is used up. */
  | { kind: "storage-full" }
  /** The server refuses changes: trial / subscription over. */
  | { kind: "read-only" }
  | { kind: "paused" }
  | { kind: "syncing" }
  | { kind: "disconnected" }
  | { kind: "up-to-date" };

/** `app.setting` is a real, long-stable Obsidian API but isn't part of the public `obsidian` type declarations. */
interface AppWithSettingTab extends App {
  setting: { open(): void; openTabById(id: string): void };
}

export class SyncstoneStatusBar {
  /** Set by main.ts: re-renders the header icons. */
  onRefresh: (() => void) | null = null;

  constructor(private readonly plugin: SyncstonePlugin) {}

  start(): void {
    this.refresh();
  }

  dispose(): void {
    this.onRefresh = null;
  }

  /** Called by main.ts right after actions that change status, so the header icon updates instantly instead of waiting for its next poll tick. */
  refresh(): void {
    this.onRefresh?.();
  }

  /** Read by the header action (SyncstoneHeaderActions). */
  computeStatus(): Status {
    const { settings, syncEngine, liveSyncConnected } = this.plugin;

    if (!settings.sessionToken || !settings.linkedVault) return { kind: "not-configured" };
    const compat = this.plugin.compat.state;
    if (compat !== "ok") return { kind: compat };
    if (!this.plugin.cryptoService.isUnlocked()) return { kind: "locked" };
    const account = this.plugin.account;
    if (account?.readOnly) return { kind: "read-only" };
    if (account?.storageQuotaBytes && account.storageUsedBytes >= account.storageQuotaBytes) return { kind: "storage-full" };
    if (settings.syncPaused) return { kind: "paused" };
    if (syncEngine?.isSyncing || this.plugin.transfers.active) return { kind: "syncing" };
    if (!liveSyncConnected) return { kind: "disconnected" };
    return { kind: "up-to-date" };
  }

  /** `prepend` lets a caller (the header action) put its own items above the standard ones. */
  openMenu(evt: MouseEvent, prepend?: (menu: Menu) => void): void {
    const status = this.computeStatus();
    const menu = new Menu();
    prepend?.(menu);

    if (status.kind === "plugin-outdated" || this.plugin.compat.updateAvailable) {
      menu.addItem((item) =>
        item
          .setTitle(t("p.update.open"))
          .setIcon("circle-arrow-up")
          .onClick(() => this.openCommunityPlugins()),
      );
    }
    if (status.kind === "plugin-outdated" || status.kind === "server-outdated" || this.plugin.compat.updateAvailable) {
      menu.addItem((item) =>
        item
          .setTitle(t("p.update.whatsNew"))
          .setIcon("external-link")
          .onClick(() => openExternal(RELEASES_URL)),
      );
      menu.addSeparator();
    }

    menu.addItem((item) =>
      item
        .setTitle(t("p.syncNow"))
        .setIcon("refresh-cw")
        .setDisabled(!this.plugin.syncEngine || this.plugin.settings.syncPaused)
        .onClick(() => void this.plugin.runManualSync()),
    );

    if (status.kind !== "not-configured") {
      const paused = this.plugin.settings.syncPaused;
      menu.addItem((item) =>
        item
          .setTitle(paused ? t("p.resume") : t("p.pause"))
          .setIcon(paused ? "play" : "pause")
          .onClick(() => void this.togglePaused()),
      );
    }

    if (status.kind !== "not-configured") {
      menu.addItem((item) =>
        item
          .setTitle(t("p.log.menu"))
          .setIcon("list")
          .onClick(() => this.plugin.openSyncLog()),
      );
    }

    if ((status.kind === "storage-full" || status.kind === "read-only") && this.plugin.account?.webUrl) {
      const planUrl = `${this.plugin.account.webUrl.replace(/\/+$/, "")}/account/billing`;
      menu.addItem((item) =>
        item
          .setTitle(t("p.openPlan"))
          .setIcon("external-link")
          .onClick(() => openExternal(planUrl)),
      );
    }

    if (this.plugin.settings.linkedVault && !this.plugin.settings.backupAcknowledged) {
      menu.addItem((item) =>
        item
          .setTitle(t("p.firstSync.open"))
          .setIcon("play")
          .onClick(() => void this.plugin.tryStartSync()),
      );
    }

    if (status.kind === "locked") {
      menu.addItem((item) =>
        item
          .setTitle(t("p.enterPassMenu"))
          .setIcon("lock")
          .onClick(() => this.openSettings()),
      );
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(t("p.openSettings"))
        .setIcon("settings")
        .onClick(() => this.openSettings()),
    );

    menu.showAtMouseEvent(evt);
  }

  /** Obsidian's community plugins page, where the update is installed. */
  openCommunityPlugins(): void {
    const app = this.plugin.app as AppWithSettingTab;
    app.setting.open();
    app.setting.openTabById("community-plugins");
  }

  private async togglePaused(): Promise<void> {
    this.plugin.settings.syncPaused = !this.plugin.settings.syncPaused;
    await this.plugin.saveSettings();
    this.plugin.refreshCollab();
    new Notice(`Syncstone: ${this.plugin.settings.syncPaused ? "pausiert" : "fortgesetzt"}.`);
    this.refresh();
  }

  private openSettings(): void {
    const appWithSettings = this.plugin.app as AppWithSettingTab;
    appWithSettings.setting.open();
    appWithSettings.setting.openTabById(this.plugin.manifest.id);
  }
}

export function describeStatus(
  status: Status,
  lastSyncAt: string | null,
): { icon: string; text: string; tooltip: string; spin: boolean; alert?: boolean; warn?: boolean } {
  switch (status.kind) {
    case "plugin-outdated":
      return { icon: "circle-arrow-up", text: "Syncstone", tooltip: t("p.tip.pluginOutdated"), spin: false, warn: true };
    case "server-outdated":
      return { icon: "circle-arrow-up", text: "Syncstone", tooltip: t("p.tip.serverOutdated"), spin: false, warn: true };
    case "not-configured":
      return {
        icon: "cloud-off",
        text: "Syncstone",
        tooltip: t("p.tip.notConfigured"),
        spin: false,
      };
    case "locked":
      return {
        icon: "lock",
        text: "Syncstone",
        tooltip: t("p.tip.locked"),
        spin: false,
      };
    case "storage-full":
      return { icon: "alert-circle", text: "Syncstone", tooltip: t("p.tip.storageFull"), spin: false, alert: true };
    case "read-only":
      return { icon: "alert-circle", text: "Syncstone", tooltip: t("p.tip.readOnly"), spin: false, alert: true };
    case "paused":
      return { icon: "pause-circle", text: "Syncstone", tooltip: t("p.tip.paused"), spin: false };
    case "syncing":
      return { icon: "refresh-cw", text: "Syncstone", tooltip: t("p.tip.syncing"), spin: true };
    case "disconnected":
      return {
        icon: "wifi-off",
        text: "Syncstone",
        tooltip: t("p.tip.disconnected"),
        spin: false,
      };
    case "up-to-date": {
      const when = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : null;
      return {
        icon: "check-circle",
        text: "Syncstone",
        tooltip: when ? `Syncstone: synchronisiert (zuletzt ${when})` : "Syncstone: synchronisiert",
        spin: false,
      };
    }
  }
}

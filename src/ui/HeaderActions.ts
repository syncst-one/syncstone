/**
 * Syncstone's presence in the tab header (the icon row top right, next to the
 * reading-view "book" toggle and the "..." menu), built with Obsidian's own `view.addAction`:
 *
 *  - While other devices are in the same note, a compact stack of coloured
 *    avatars (initial of the device name, same colour as their cursor). The
 *    full names are in the tooltip and in the menu you get on click.
 *  - The general Syncstone status icon (synced / syncing / offline / locked ...)
 *    lives here on every note and on every platform (there is no bottom status
 *    bar item any more). Clicking it opens the sync menu; the icon alone is the
 *    label, no text.
 *
 * It is a pure view: state is read from the plugin, and the DOM is only
 * touched when the rendered result actually changes.
 */
import { t } from "../i18n/index.js";
import { ItemView, MarkdownView, Menu, Platform, setIcon, setTooltip } from "obsidian";
import type SyncstonePlugin from "../main.js";
import type { CollabPresence } from "../collab/CollabManager.js";
import { describeStatus, type SyncstoneStatusBar } from "./StatusBar.js";

const REFRESH_INTERVAL_MS = 1000;
const ACTION_CLASS = "syncstone-header-action";
/** The phone's header is narrow: fewer avatars there (the rest is counted in "+N"). */
const maxAvatars = (): number => (Platform.isMobile ? 2 : 3);

interface HeaderAction {
  el: HTMLElement;
  /** What was last rendered - skips DOM work while nothing changed. */
  signature: string;
}

export class SyncstoneHeaderActions {
  private readonly actions = new Map<ItemView, HeaderAction>();
  private timer: ReturnType<typeof window.setInterval> | null = null;

  constructor(
    private readonly plugin: SyncstonePlugin,
    private readonly statusBar: SyncstoneStatusBar,
  ) {}

  start(): void {
    const { workspace } = this.plugin.app;
    const refresh = () => this.refresh();
    this.plugin.registerEvent(workspace.on("layout-change", refresh));
    this.plugin.registerEvent(workspace.on("active-leaf-change", refresh));
    this.plugin.registerEvent(workspace.on("file-open", refresh));
    // Status changes (syncing, offline, ...) have no event of their own.
    this.timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    this.plugin.registerInterval(this.timer);
    this.refresh();
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    for (const { el } of this.actions.values()) el.remove();
    this.actions.clear();
    // Also what an earlier instance of the plugin (reload, update) or a lost entry left behind in a tab header.
    document.querySelectorAll(`.${ACTION_CLASS}`).forEach((el) => el.remove());
  }

  refresh(): void {
    const seen = new Set<ItemView>();
    this.plugin.app.workspace.iterateRootLeaves((leaf) => {
      const view = leaf.view;
      // Every tab of the main area: notes, canvas, PDF, images, the graph view and the empty "new tab" page - the sync
      // icon is the same everywhere, so it is never missing just because no file is open.
      if (!(view instanceof ItemView)) return;
      seen.add(view);
      let action = this.actions.get(view);
      // The icon lives in the tab's own header and outlasts our bookkeeping (a tab that was moved or re-laid-out for a moment, a plugin
      // reload): look at what is really there, keep ours if it is still in the header, drop everything else, and never add a second.
      const present = Array.from(view.containerEl.querySelectorAll<HTMLElement>(`.${ACTION_CLASS}`));
      if (action && !present.includes(action.el)) {
        this.actions.delete(view);
        action = undefined;
      }
      for (const extra of present) if (extra !== action?.el) extra.remove();
      if (!action) {
        const el = view.addAction("cloud", "Syncstone", (evt) => this.onClick(evt, view));
        el.addClass(ACTION_CLASS);
        action = { el, signature: "" };
        this.actions.set(view, action);
      }
      this.render(view, action);
    });

    // Tabs that were closed took their header (and our element) with them.
    for (const view of [...this.actions.keys()]) {
      if (!seen.has(view)) this.actions.delete(view);
    }
  }

  private presenceOf(view: ItemView): CollabPresence[] | null {
    if (!(view instanceof MarkdownView) || !view.file) return null;
    return this.plugin.collabManager?.presenceFor(view.file.path) ?? null;
  }

  private render(view: ItemView, action: HeaderAction): void {
    const { el } = action;
    const presence = this.presenceOf(view);
    const status = this.statusBar.computeStatus();
    const described = describeStatus(status, this.plugin.settings.lastSyncAt);
    const signature = JSON.stringify([described.icon, described.spin, described.alert ?? false, described.warn ?? false, described.tooltip, presence]);
    if (signature === action.signature) return;
    action.signature = signature;

    el.empty();
    el.show();

    const iconEl = el.createSpan({ cls: "syncstone-header-icon" });
    setIcon(iconEl, described.icon);
    iconEl.toggleClass("syncstone-status-icon-spin", described.spin);
    iconEl.toggleClass("syncstone-status-icon-alert", described.alert ?? false);
    iconEl.toggleClass("syncstone-status-icon-warn", described.warn ?? false);

    let tooltip = described.tooltip;
    if (presence && presence.length > 0) {
      const avatars = el.createSpan({ cls: "syncstone-avatars" });
      const shown = maxAvatars();
      for (const peer of presence.slice(0, shown)) {
        const avatar = avatars.createSpan({ cls: "syncstone-avatar", text: initialOf(peer.name) });
        avatar.style.backgroundColor = peer.color;
      }
      if (presence.length > shown) {
        avatars.createSpan({ cls: "syncstone-avatar syncstone-avatar-more", text: `+${presence.length - shown}` });
      }
      const live = t("p.liveWith", { names: presence.map((peer) => peer.name).join(", ") });
      tooltip = `${tooltip} · ${live}`;
    }
    setTooltip(el, tooltip, { placement: "bottom" });
  }

  private onClick(evt: MouseEvent, view: ItemView): void {
    const presence = this.presenceOf(view);
    this.statusBar.openMenu(evt, (menu: Menu) => {
      if (!presence || presence.length === 0) return;
      menu.addItem((item) => item.setTitle(t("p.liveInNote")).setIcon("users").setDisabled(true));
      for (const peer of presence) {
        menu.addItem((item) => item.setTitle(peer.name).setIcon("user").setDisabled(false));
      }
      menu.addSeparator();
    });
  }
}

/** First visible character of the device name, for the avatar. */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

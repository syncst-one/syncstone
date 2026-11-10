import { currentLocale, t } from "../i18n/index.js";
import { ItemView, Notice, TFile, normalizePath, setIcon, type WorkspaceLeaf } from "obsidian";
import { actionLabel, diffLines, fromBase64, numberDiffLines, unpackBlob, whoLabel, withContext, type RevisionEntry } from "@websync/shared";
import type SyncstonePlugin from "../main.js";
import { baseName, decoder, extOf, formatBytes, IMAGE_EXT, MAX_PREVIEW_BYTES, parentOf, TEXT_EXT } from "./historyFormat.js";

export const HISTORY_DIFF_VIEW_TYPE = "syncstone-history-diff";

/**
 * Main-area tab opened from a HistoryView row: one version compared against the file's current content, GitHub-style
 * with line numbers - the plugin's counterpart of the web workspace's diff tab.
 */
export class HistoryDiffView extends ItemView {
  private fileId: string | null = null;
  private revisionId: string | null = null;
  private entries: RevisionEntry[] = [];
  private retentionDays = 0;
  private loading = true;
  private error: string | null = null;
  private confirming = false;
  private busy = false;
  private request = 0;
  private objectUrl: string | null = null;
  /** The file's current local path (from the sync index), refreshed in `reload()` - null if it doesn't exist locally. */
  private currentLocalPath: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SyncstonePlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return HISTORY_DIFF_VIEW_TYPE;
  }

  getDisplayText(): string {
    const entry = this.entries.find((e) => e.id === this.revisionId);
    return entry?.path ? t("p.diff.title", { name: baseName(entry.path) }) : t("p.diff.titlePlain");
  }

  getIcon(): string {
    return "history";
  }

  async onClose(): Promise<void> {
    this.revokeUrl();
  }

  /** Points the view at another version (reused instead of opening a new tab every time, like the web workspace). */
  async setTarget(fileId: string, revisionId: string): Promise<void> {
    this.fileId = fileId;
    this.revisionId = revisionId;
    this.confirming = false;
    await this.reload();
  }

  private get vaultId(): string | null {
    return this.plugin.settings.linkedVault?.vaultId ?? null;
  }

  private async reload(): Promise<void> {
    const vaultId = this.vaultId;
    const fileId = this.fileId;
    if (!vaultId || !fileId || !this.plugin.cryptoService.isUnlocked()) {
      this.entries = [];
      this.error = t("p.notConnected");
      this.loading = false;
      this.render();
      return;
    }
    const id = ++this.request;
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const page = await this.plugin.remoteApi.getHistory(vaultId, fileId);
      const decrypted = await Promise.all(
        page.revisions.map(async (r): Promise<RevisionEntry> => {
          let path: string | null = null;
          try {
            path = await this.plugin.cryptoService.decryptPath(fromBase64(r.pathCiphertext), fromBase64(r.pathNonce));
          } catch {
            /* shown as unreadable */
          }
          return {
            id: r.id,
            fileId: r.fileId,
            version: r.version,
            action: r.action,
            path,
            size: r.contentSize,
            hash: r.contentHashBlinded,
            hasContent: r.hasContent,
            deviceName: r.deviceName,
            username: r.username,
            createdAt: r.createdAt,
          };
        }),
      );
      if (id !== this.request) return;
      this.entries = decrypted;
      this.retentionDays = page.retentionDays;
      const record = await this.plugin.localIndex?.get(fileId);
      if (id !== this.request) return;
      this.currentLocalPath = record?.localPath ?? null;
    } catch (err) {
      if (id === this.request) this.error = err instanceof Error ? err.message : t("p.historyLoadFailed");
    } finally {
      if (id === this.request) {
        this.loading = false;
        this.render();
      }
    }
  }

  private async restore(entry: RevisionEntry): Promise<void> {
    const vaultId = this.vaultId;
    if (!vaultId) return;
    this.busy = true;
    this.render();
    try {
      const record = await this.plugin.localIndex?.get(entry.fileId);
      let newPath: string | null = null;
      if (!record && entry.path && (await this.app.vault.adapter.exists(normalizePath(entry.path)))) {
        newPath = await this.freePath(entry.path, "wiederhergestellt");
      }
      const encrypted = newPath ? await this.plugin.cryptoService.encryptPath(newPath) : undefined;
      let appliedLive = false;
      if (record) {
        // A pending edit must reach the server before the restore, not land on top of it a moment later.
        await this.plugin.flushNote(record.localPath);
        // Co-edited right now: the open editors only learn about the restore through the live session (otherwise its
        // old text is saved over the restore with the next keystroke), so it goes in there first.
        const collab = this.plugin.collabManager;
        if (collab?.isLive(entry.fileId)) {
          const text = await this.revisionText(vaultId, entry);
          if (text !== null) appliedLive = await collab.applyLiveText(entry.fileId, text);
        }
      }
      await this.plugin.remoteApi.restoreRevision(vaultId, entry.fileId, entry.id, encrypted, appliedLive);
      new Notice(record ? t("p.restored") : t("p.fileRestored", { path: newPath ?? entry.path ?? "" }));
      this.plugin.pollNow();
      await this.reload();
    } catch (err) {
      new Notice(t("p.restoreFailed", { error: (err as Error).message }));
    } finally {
      this.busy = false;
      this.confirming = false;
      this.render();
    }
  }

  /** The text of an older version, or null for a file that is not text. */
  private async revisionText(vaultId: string, entry: RevisionEntry): Promise<string | null> {
    const blob = await this.plugin.remoteApi.downloadRevision(vaultId, entry.fileId, entry.id);
    const { ciphertext, iv } = unpackBlob(blob);
    const bytes = await this.plugin.cryptoService.decryptContent(ciphertext, iv);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }

  private async saveCopy(entry: RevisionEntry, bytes: Uint8Array): Promise<void> {
    if (!entry.path) return;
    try {
      const stamp = new Date(entry.createdAt).toLocaleString("sv-SE").slice(0, 16).replace(":", "-");
      const path = await this.freePath(entry.path, stamp);
      const folder = parentOf(path);
      if (folder && !(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
      const file = await this.app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      new Notice(t("p.savedAs", { path: file.path }));
    } catch (err) {
      new Notice(t("p.saveFailed", { error: (err as Error).message }));
    }
  }

  private async freePath(path: string, suffix: string): Promise<string> {
    const ext = extOf(path);
    const stem = ext ? path.slice(0, -(ext.length + 1)) : path;
    for (let n = 0; ; n++) {
      const candidate = `${stem} (${suffix}${n ? ` ${n}` : ""})${ext ? `.${ext}` : ""}`;
      if (!(await this.app.vault.adapter.exists(normalizePath(candidate)))) return candidate;
    }
  }

  private revokeUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("syncstone-revdiff");
    this.revokeUrl();

    const fileId = this.fileId;
    const index = this.entries.findIndex((e) => e.id === this.revisionId);
    const entry = index >= 0 ? this.entries[index] : undefined;

    if (this.loading && !entry) {
      el.createDiv({ cls: "syncstone-revdiff-empty", text: t("p.loading") });
      return;
    }
    if (this.error) {
      el.createDiv({ cls: "syncstone-revdiff-empty mod-error", text: this.error });
      return;
    }
    if (!fileId || !entry) {
      el.createDiv({ cls: "syncstone-revdiff-empty", text: t("p.versionNotFound") });
      return;
    }

    const live = this.currentLocalPath ? this.app.vault.getAbstractFileByPath(this.currentLocalPath) : null;
    const isLiveFile = live instanceof TFile;
    const isCurrent = isLiveFile && index === 0;

    const header = el.createDiv({ cls: "syncstone-revdiff-header" });
    const meta = header.createDiv({ cls: "syncstone-revdiff-meta" });
    const title = entry.path ?? t("history.unreadablePath");
    meta.createDiv({ cls: "syncstone-revdiff-title", text: baseName(title), attr: { title } });
    meta.createDiv({
      cls: "syncstone-history-note",
      text: t("p.diff.meta", { action: actionLabel(entry), date: new Date(entry.createdAt).toLocaleString(currentLocale(), { dateStyle: "long", timeStyle: "short" }), who: whoLabel(entry, true) }),
    });

    const actions = header.createDiv({ cls: "syncstone-revdiff-actions" });
    const download = actions.createEl("button", { attr: { "aria-label": t("p.saveCopyTip") } });
    setIcon(download.createSpan(), "copy-plus");
    download.createSpan({ text: t("p.saveCopy") });
    download.disabled = !entry.hasContent;
    download.onclick = () => {
      void this.plugin.remoteApi.downloadRevision(this.vaultId as string, entry.fileId, entry.id).then(async (blob) => {
        const { ciphertext, iv } = unpackBlob(blob);
        const bytes = await this.plugin.cryptoService.decryptContent(ciphertext, iv);
        void this.saveCopy(entry, bytes);
      });
    };

    if (!isCurrent) {
      const restore = actions.createEl("button", { cls: "mod-cta" });
      restore.disabled = !entry.hasContent || this.busy;
      if (this.confirming) {
        restore.setText(this.busy ? t("p.restoring") : t("p.confirmRestore"));
        restore.onclick = () => void this.restore(entry);
      } else {
        setIcon(restore.createSpan(), "rotate-ccw");
        restore.createSpan({ text: " Wiederherstellen" });
        restore.onclick = () => {
          this.confirming = true;
          this.render();
        };
      }
    }

    const body = el.createDiv({ cls: "syncstone-revdiff-body" });
    void this.fillBody(body, entry, live instanceof TFile ? live : null);
  }

  private async fillBody(body: HTMLElement, entry: RevisionEntry, liveFile: TFile | null): Promise<void> {
    const message = (text: string, cls = "") => body.createDiv({ cls: `syncstone-revdiff-empty ${cls}`, text });
    if (!entry.hasContent) {
      message(t("p.noContent", { days: this.retentionDays }));
      return;
    }
    if (entry.size > MAX_PREVIEW_BYTES) {
      message(t("p.tooBig", { size: formatBytes(entry.size) }));
      return;
    }
    const loading = message(t("p.decrypting"));
    try {
      const vaultId = this.vaultId as string;
      const blob = await this.plugin.remoteApi.downloadRevision(vaultId, entry.fileId, entry.id);
      const { ciphertext, iv } = unpackBlob(blob);
      const data = await this.plugin.cryptoService.decryptContent(ciphertext, iv);
      loading.remove();

      const ext = extOf(entry.path);
      if (IMAGE_EXT.has(ext)) {
        const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}` }));
        this.objectUrl = url;
        body.createEl("img", { cls: "syncstone-history-image", attr: { src: url } });
        return;
      }
      if (!TEXT_EXT.has(ext)) {
        message(t("p.noDiffType"));
        return;
      }
      const oldText = decoder.decode(data);
      const currentText = liveFile ? await this.app.vault.read(liveFile) : null;

      if (currentText === null) {
        body.createDiv({
          cls: "syncstone-revdiff-note",
          text: t("p.fileGone"),
        });
        body.createEl("pre", { cls: "syncstone-history-text", text: oldText });
        return;
      }
      if (oldText === currentText) {
        message(t("p.noDiff"));
        return;
      }
      const lines = diffLines(oldText, currentText);
      if (!lines) {
        message(t("p.tooManyChanges"));
        return;
      }
      const pre = body.createEl("pre", { cls: "syncstone-revdiff-diff" });
      for (const line of withContext(numberDiffLines(lines), 3)) {
        const row = pre.createDiv({ cls: line === null ? "syncstone-revdiff-line syncstone-revdiff-gap" : `syncstone-revdiff-line is-${line.kind}` });
        if (line === null) {
          row.createSpan({ cls: "syncstone-revdiff-gutter" });
          row.createSpan({ cls: "syncstone-revdiff-gutter" });
          row.createSpan({ cls: "syncstone-revdiff-code", text: "⋯" });
          continue;
        }
        row.createSpan({ cls: "syncstone-revdiff-gutter", text: line.oldLine !== null ? String(line.oldLine) : "" });
        row.createSpan({ cls: "syncstone-revdiff-gutter", text: line.newLine !== null ? String(line.newLine) : "" });
        row.createSpan({ cls: "syncstone-revdiff-sign", text: line.kind === "add" ? "+" : line.kind === "del" ? "−" : "" });
        row.createSpan({ cls: "syncstone-revdiff-code", text: line.text || " " });
      }
    } catch (err) {
      loading.remove();
      message(err instanceof Error ? err.message : t("p.versionLoadFailed"), "mod-error");
    }
  }
}

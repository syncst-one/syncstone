import { Modal, Setting, type App } from "obsidian";
import { t, tn } from "../i18n/index.js";
import type { FirstSyncPreview } from "../sync/firstSyncPreview.js";

/**
 * Shown before the first sync of a linked vault, before anything is transferred: the backup hint and what the sync would
 * do (counted by `previewFirstSync`), with a warning when this folder and the server vault look like two different vaults.
 * Confirming starts the sync; "Not now" keeps it off and asks again next time (the settings tab and the status menu
 * open this again until then). `preview` is null when it could not be counted (e.g. offline).
 */
export class BackupNoticeModal extends Modal {
  constructor(
    app: App,
    private readonly vaultName: string,
    private readonly preview: FirstSyncPreview | null,
    private readonly onConfirm: () => void | Promise<void>,
    private readonly onClosed: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, preview } = this;
    this.titleEl.setText(t("p.firstSync.title"));

    if (preview?.mismatch) {
      contentEl.createEl("p", { text: t("p.firstSync.mismatch", { vault: this.vaultName }), cls: "mod-warning" });
    }

    if (preview) {
      const rows: string[] = [];
      if (preview.download > 0) rows.push(tn("p.firstSync.download", preview.download));
      if (preview.upload > 0) rows.push(tn("p.firstSync.upload", preview.upload));
      if (rows.length > 0) {
        const list = contentEl.createEl("ul");
        for (const row of rows) list.createEl("li", { text: row });
      }
    } else {
      contentEl.createEl("p", { text: t("p.firstSync.failed"), cls: "setting-item-description" });
    }

    contentEl.createEl("p", { text: t("p.backup.text") });
    contentEl.createEl("p", { text: t("p.backup.laterHint"), cls: "setting-item-description" });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText(t("p.backup.later")).onClick(() => this.close()))
      .addButton((button) => {
        button.setButtonText(t(preview?.mismatch ? "p.firstSync.merge" : "p.backup.confirm")).onClick(() => {
          this.close();
          void this.onConfirm();
        });
        if (preview?.mismatch) button.setWarning();
        else button.setCta();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClosed();
  }
}

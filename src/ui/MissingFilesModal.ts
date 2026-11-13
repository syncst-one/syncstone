import { Modal, Setting, type App } from "obsidian";
import { t } from "../i18n/index.js";

/**
 * More files than usual were deleted on this device while Syncstone was not running. Asks whether to delete them on the
 * other devices as well or to bring them back here. Closing it decides nothing (asked again at the next start).
 */
export class MissingFilesModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly count: number,
    private readonly onAnswer: (choice: "delete" | "restore" | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("p.missing.title", { count: this.count }));
    this.contentEl.createEl("p", { text: t("p.missing.text") });
    this.contentEl.createEl("p", { text: t("p.missing.hint"), cls: "setting-item-description" });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t("p.missing.restore")).setCta().onClick(() => this.answer("restore")))
      .addButton((button) => button.setButtonText(t("p.missing.delete")).setWarning().onClick(() => this.answer("delete")));
  }

  private answer(choice: "delete" | "restore"): void {
    this.answered = true;
    this.onAnswer(choice);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.onAnswer(null);
  }
}

import { Modal, Setting, type App } from "obsidian";
import { t } from "../i18n/index.js";

/**
 * Asked once when settings sync finds settings on this device that differ from the server's and were never synced
 * before (it was just switched on, or a category was added): which side should count. "Don't sync", or closing it
 * without a choice, switches back off what was just switched on; nothing has been synced at that point.
 */
export class ConfigFirstContactModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly paths: string[],
    private readonly configDir: string,
    private readonly onAnswer: (choice: "local" | "remote" | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(t("p.configFirst.title"));
    contentEl.createEl("p", { text: t("p.configFirst.text") });

    new Setting(contentEl)
      .addButton((button) => {
        button.setButtonText(t("p.configFirst.skip")).onClick(() => this.close());
        button.buttonEl.addClass("syncstone-quiet-button");
      })
      .addButton((button) => button.setButtonText(t("p.configFirst.remote")).onClick(() => this.answer("remote")))
      .addButton((button) => button.setButtonText(t("p.configFirst.local")).setCta().onClick(() => this.answer("local")));
  }

  private answer(choice: "local" | "remote"): void {
    this.answered = true;
    this.close();
    this.onAnswer(choice);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.onAnswer(null);
  }
}

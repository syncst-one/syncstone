import { Modal, Setting, type App } from "obsidian";
import { t, tn } from "../i18n/index.js";

const SHOWN_PATHS = 6;

/**
 * Asked once when settings sync finds settings on this device that differ from the server's and were never synced
 * before (it was just switched on, or a category was added): which side should count. Closing it means "not now";
 * settings then stay unsynced until the next start of Obsidian, where it asks again.
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

    const list = contentEl.createEl("ul");
    const prefix = `${this.configDir}/`;
    for (const path of this.paths.slice(0, SHOWN_PATHS)) {
      list.createEl("li", { text: path.startsWith(prefix) ? path.slice(prefix.length) : path });
    }
    const more = this.paths.length - SHOWN_PATHS;
    if (more > 0) list.createEl("li", { text: tn("p.configFirst.more", more) });

    contentEl.createEl("p", { text: t("p.configFirst.hint"), cls: "setting-item-description" });

    new Setting(contentEl)
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

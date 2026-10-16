import { App, Modal, Notice, Setting, SuggestModal } from "obsidian";

export interface PromptField {
  key: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
  required?: boolean;
  initialValue?: string;
  suggestions?: readonly string[];
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

export class ChoiceModal<T extends string> extends SuggestModal<ChoiceOption<T>> {
  public constructor(
    app: App,
    private readonly options: readonly ChoiceOption<T>[],
    placeholder: string,
    private readonly onSelect: (value: T) => Promise<void>,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  public getSuggestions(query: string): ChoiceOption<T>[] {
    const normalized = query.toLocaleLowerCase();
    return this.options.filter((option) =>
      `${option.label} ${option.description}`.toLocaleLowerCase().includes(normalized),
    );
  }

  public renderSuggestion(option: ChoiceOption<T>, element: HTMLElement): void {
    element.createEl("strong", { text: option.label });
    element.createDiv({ cls: "suggestion-note", text: option.description });
  }

  public onChooseSuggestion(option: ChoiceOption<T>): void {
    void this.onSelect(option.value).catch(error => new Notice(error instanceof Error ? error.message : "操作失败", 10000));
  }
}

export class TextPromptModal extends Modal {
  private value = "";

  public constructor(
    app: App,
    private readonly title: string,
    private readonly placeholder: string,
    private readonly submitLabel: string,
    private readonly onSubmit: (value: string) => Promise<void>,
  ) {
    super(app);
  }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal");
    this.titleEl.setText(this.title);
    new Setting(this.contentEl).addTextArea((area) => {
      area.setPlaceholder(this.placeholder);
      area.inputEl.rows = 6;
      area.onChange((value) => {
        this.value = value;
      });
      area.inputEl.focus();
    });
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText(this.submitLabel)
        .setCta()
        .onClick(async () => {
          if (!this.value.trim()) return;
          button.setDisabled(true);
          try {
            await this.onSubmit(this.value.trim());
            this.close();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "操作失败", 10_000);
          } finally {
            button.setDisabled(false);
          }
        }),
    );
  }

  public onClose(): void {
    this.contentEl.empty();
  }
}

export class FieldsPromptModal extends Modal {
  private readonly values: Record<string, string> = {};

  public constructor(
    app: App,
    private readonly title: string,
    private readonly fields: readonly PromptField[],
    private readonly submitLabel: string,
    private readonly onSubmit: (values: Record<string, string>) => Promise<void>,
  ) {
    super(app);
  }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal");
    this.titleEl.setText(this.title);
    for (const field of this.fields) {
      if (field.initialValue) this.values[field.key] = field.initialValue;
      const setting = new Setting(this.contentEl).setName(field.label);
      if (field.multiline) {
        setting.addTextArea((area) => {
          area.setPlaceholder(field.placeholder);
          area.setValue(field.initialValue ?? "");
          area.inputEl.rows = 6;
          area.onChange((value) => {
            this.values[field.key] = value;
          });
        });
      } else {
        setting.addText((input) => {
          input.setPlaceholder(field.placeholder);
          input.setValue(field.initialValue ?? "");
          if (field.suggestions?.length) {
            const id = `okf-prompt-${crypto.randomUUID()}`;
            const list = this.contentEl.createEl("datalist", { attr: { id } });
            for (const value of field.suggestions) list.createEl("option", { attr: { value } });
            input.inputEl.setAttribute("list", id);
          }
          input.onChange((value) => {
            this.values[field.key] = value;
          });
        });
      }
    }
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText(this.submitLabel)
        .setCta()
        .onClick(async () => {
          const missing = this.fields.some(
            (field) => field.required !== false && !this.values[field.key]?.trim(),
          );
          if (missing) {
            new Notice("请填写所有必填项");
            return;
          }
          button.setDisabled(true);
          try {
            await this.onSubmit(
              Object.fromEntries(
                Object.entries(this.values).map(([key, value]) => [key, value.trim()]),
              ),
            );
            this.close();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "操作失败", 10_000);
          } finally {
            button.setDisabled(false);
          }
        }),
    );
  }

  public onClose(): void {
    this.contentEl.empty();
  }
}

/** A Project Log is useful both as a native note and as a zero-friction append target. */
export class ProjectLogModal extends Modal {
  private value = "";
  private submitting = false;

  public constructor(
    app: App,
    private readonly onSubmit: (value: string) => Promise<void>,
  ) {
    super(app);
  }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal", "okf-project-log-modal");
    this.titleEl.setText("项目日志");
    let submit: HTMLButtonElement | undefined;
    const updateLabel = (): void => {
      submit?.setText(this.value.trim() ? "追加到项目日志" : "打开项目日志");
    };
    new Setting(this.contentEl)
      .setName("记录（可留空）")
      .setDesc("留空会直接打开原生 log.md；填写后只追加一次，不生成中间笔记。")
      .addTextArea((area) => {
        area.setPlaceholder("进展、问题、发现、决定或下一步……");
        area.inputEl.rows = 6;
        area.onChange((value) => {
          this.value = value;
          updateLabel();
        });
        area.inputEl.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || !event.ctrlKey) return;
          event.preventDefault();
          void this.submit(submit);
        });
        area.inputEl.focus();
      });
    new Setting(this.contentEl)
      .setDesc("Ctrl + Enter 执行")
      .addButton((button) => {
        submit = button.buttonEl;
        button.setCta().onClick(() => void this.submit(submit));
        updateLabel();
      });
  }

  public onClose(): void {
    this.contentEl.empty();
  }

  private async submit(button: HTMLButtonElement | undefined): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    if (button) button.disabled = true;
    try {
      await this.onSubmit(this.value.trim());
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "操作失败", 10_000);
    } finally {
      this.submitting = false;
      if (button) button.disabled = false;
    }
  }
}

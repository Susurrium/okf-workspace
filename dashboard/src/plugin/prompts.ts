import { App, Modal, Notice, Setting, SuggestModal } from "obsidian";

export interface PromptField {
  key: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
  required?: boolean;
  initialValue?: string;
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
    void this.onSelect(option.value);
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

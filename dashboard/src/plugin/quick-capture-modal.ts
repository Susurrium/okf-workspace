import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";

import {
  normalizeCaptureRelation,
  type CaptureContextOption,
  type CaptureContextOptions,
  type CaptureRelation,
} from "../domain/capture-context.js";

const NO_CONTEXT = "none:";

export class QuickCaptureModal extends Modal {
  private value = "";
  private relation: CaptureRelation;
  private submitting = false;
  private submitButton: ButtonComponent | undefined;

  public constructor(
    app: App,
    private readonly contexts: CaptureContextOptions,
    initial: CaptureRelation,
    private readonly onSubmit: (value: string, relation: CaptureRelation) => Promise<void>,
  ) {
    super(app);
    this.relation = normalizeCaptureRelation(initial);
  }

  public onOpen(): void {
    this.modalEl.addClass("okf-quick-capture-modal");
    this.titleEl.setText("快速记录");

    let textarea: HTMLTextAreaElement | undefined;
    new Setting(this.contentEl)
      .setName("内容")
      .setDesc("先保存原始想法；之后再决定是否写入项目、课程或知识库。")
      .addTextArea((area) => {
        textarea = area.inputEl;
        area.setPlaceholder("一个想法、问题，或暂时不想打断当前工作的内容……");
        area.inputEl.rows = 7;
        area.onChange((value) => {
          this.value = value;
        });
      });

    new Setting(this.contentEl)
      .setName("关联")
      .setDesc("可选。文件仍保存到 Inbox，并在对应 Course 或 Project 中显示为待整理记录。")
      .addDropdown((dropdown) => {
        dropdown.addOption(NO_CONTEXT, "不关联 · 稍后在 Inbox 整理");
        this.addContextOptions(dropdown, "course", this.contexts.courses);
        this.addContextOptions(dropdown, "project", this.contexts.projects);
        dropdown.setValue(encodeRelation(this.relation));
        dropdown.onChange((value) => {
          this.relation = decodeRelation(value);
        });
      });

    new Setting(this.contentEl)
      .setDesc("Ctrl + Enter 保存")
      .addButton((button) => {
        this.submitButton = button;
        button
          .setButtonText("保存到 Inbox")
          .setCta()
          .onClick(() => void this.submit());
      });

    textarea?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !event.ctrlKey) return;
      event.preventDefault();
      void this.submit();
    });
    textarea?.focus();
  }

  public onClose(): void {
    this.contentEl.empty();
  }

  private addContextOptions(
    dropdown: { addOption: (value: string, display: string) => unknown },
    kind: "course" | "project",
    options: readonly CaptureContextOption[],
  ): void {
    const prefix = kind === "course" ? "Course" : "Project";
    for (const option of options) {
      const relation = normalizeCaptureRelation({ [kind]: option.path });
      dropdown.addOption(encodeRelation(relation), `${prefix} · ${option.title}`);
    }
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const value = this.value.trim();
    if (!value) {
      new Notice("请输入要记录的内容");
      return;
    }
    this.submitting = true;
    this.submitButton?.setDisabled(true);
    try {
      await this.onSubmit(value, this.relation);
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "保存失败", 10_000);
    } finally {
      this.submitting = false;
      this.submitButton?.setDisabled(false);
    }
  }
}

function encodeRelation(relation: CaptureRelation): string {
  if (relation.course) return `course:${relation.course}`;
  if (relation.project) return `project:${relation.project}`;
  return NO_CONTEXT;
}

function decodeRelation(value: string): CaptureRelation {
  if (value === NO_CONTEXT) return {};
  const separator = value.indexOf(":");
  if (separator < 0) return {};
  const kind = value.slice(0, separator);
  const path = value.slice(separator + 1);
  if (kind === "course") return normalizeCaptureRelation({ course: path });
  if (kind === "project") return normalizeCaptureRelation({ project: path });
  return {};
}

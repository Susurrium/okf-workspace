import { App, Modal, Notice, Setting } from "obsidian";

import {
  CAPTURE_ENTRY_ACTION_LABELS,
  filterCaptureContextOptions,
  normalizeCaptureRelation,
  relationVaultPath,
  type CaptureContextOption,
  type CaptureContextOptions,
  type CaptureRelation,
} from "../domain/capture-context.js";

type ContextKind = "course" | "project";

export class QuickCaptureModal extends Modal {
  private value = "";
  private readonly initial: CaptureRelation;
  private submitting = false;
  private readonly submitButtons = new Set<HTMLButtonElement>();

  public constructor(
    app: App,
    private readonly contexts: CaptureContextOptions,
    initial: CaptureRelation,
    private readonly onSubmit: (value: string, relation: CaptureRelation) => Promise<void>,
  ) {
    super(app);
    this.initial = normalizeCaptureRelation(initial);
  }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal", "okf-quick-capture-modal");
    this.titleEl.setText("快速记录");

    let textarea: HTMLTextAreaElement | undefined;
    new Setting(this.contentEl)
      .setName("内容")
      .setDesc("先记下来；没有明确归属就直接进入 Inbox。")
      .addTextArea((area) => {
        textarea = area.inputEl;
        area.setPlaceholder("一个想法、问题，或暂时不想打断当前工作的内容……");
        area.inputEl.rows = 7;
        area.onChange((value) => {
          this.value = value;
        });
      });

    const workflow = this.contentEl.createDiv({ cls: "okf-quick-capture-modal__workflow" });
    if (this.hasFixedRelation()) this.renderFixedRelation(workflow);
    else this.renderPrimaryActions(workflow);

    textarea?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !event.ctrlKey) return;
      event.preventDefault();
      void this.submit(this.initial);
    });
    textarea?.focus();
  }

  public onClose(): void {
    this.submitButtons.clear();
    this.contentEl.empty();
  }

  private hasFixedRelation(): boolean {
    return Boolean(this.initial.course || this.initial.project);
  }

  private renderFixedRelation(parent: HTMLElement): void {
    const context = parent.createDiv({ cls: "okf-quick-capture-modal__fixed-context" });
    context.createEl("strong", { text: "保存时将自动关联" });
    context.createDiv({ text: this.fixedRelationLabel() });
    const label = this.initial.course && !this.initial.project
      ? "关联 Course 后保存"
      : this.initial.project && !this.initial.course
        ? "关联 Project 后保存"
        : "按当前关联保存";
    const actions = parent.createDiv({ cls: "okf-quick-capture-modal__actions" });
    this.actionButton(actions, label, "mod-cta", () => this.submit(this.initial));
    actions.createSpan({ cls: "okf-quick-capture-modal__hint", text: "Ctrl + Enter" });
  }

  private fixedRelationLabel(): string {
    const labels: string[] = [];
    if (this.initial.course) {
      labels.push(`Course · ${this.contextTitle("course", this.initial.course)}`);
    }
    if (this.initial.project) {
      labels.push(`Project · ${this.contextTitle("project", this.initial.project)}`);
    }
    return labels.join(" · ");
  }

  private contextTitle(kind: ContextKind, path: string): string {
    const options = kind === "course" ? this.contexts.courses : this.contexts.projects;
    return options.find((option) =>
      relationVaultPath(option.path) === relationVaultPath(path)
    )?.title ?? relationVaultPath(path).split("/").at(-2) ?? path;
  }

  private renderPrimaryActions(parent: HTMLElement): void {
    parent.empty();
    parent.createDiv({
      cls: "okf-quick-capture-modal__prompt",
      text: "这条记录现在有明确归属吗？",
    });
    const actions = parent.createDiv({ cls: "okf-quick-capture-modal__actions" });
    this.actionButton(actions, CAPTURE_ENTRY_ACTION_LABELS[0], "mod-cta", () => this.submit({}));
    this.actionButton(actions, CAPTURE_ENTRY_ACTION_LABELS[1], "okf-workflow-modal__secondary", () => {
      this.renderContextPicker(parent, "course");
    });
    this.actionButton(actions, CAPTURE_ENTRY_ACTION_LABELS[2], "okf-workflow-modal__secondary", () => {
      this.renderContextPicker(parent, "project");
    });
    parent.createDiv({ cls: "okf-quick-capture-modal__hint", text: "Ctrl + Enter 直接保存到 Inbox" });
  }

  private renderContextPicker(parent: HTMLElement, kind: ContextKind): void {
    parent.empty();
    const noun = kind === "course" ? "Course" : "Project";
    const heading = parent.createDiv({ cls: "okf-quick-capture-modal__picker-heading" });
    heading.createEl("strong", { text: `选择 ${noun}` });
    const back = heading.createEl("button", {
      text: "返回",
      cls: "okf-workflow-modal__ghost",
      attr: { type: "button" },
    });
    back.addEventListener("click", () => this.renderPrimaryActions(parent));

    const search = parent.createEl("input", {
      cls: "okf-quick-capture-modal__search",
      attr: {
        type: "search",
        placeholder: `搜索 ${noun}…`,
        "aria-label": `搜索 ${noun}`,
      },
    });
    const results = parent.createDiv({ cls: "okf-quick-capture-modal__results" });
    const options = kind === "course" ? this.contexts.courses : this.contexts.projects;
    const render = (): void => {
      results.empty();
      const filtered = filterCaptureContextOptions(options, search.value);
      if (!filtered.length) {
        results.createDiv({
          cls: "okf-quick-capture-modal__empty",
          text: options.length ? `没有匹配的 ${noun}` : `还没有可关联的 ${noun}`,
        });
        return;
      }
      for (const option of filtered) this.contextButton(results, kind, option);
    };
    search.addEventListener("input", render);
    render();
    search.focus();
  }

  private contextButton(parent: HTMLElement, kind: ContextKind, option: CaptureContextOption): void {
    const button = parent.createEl("button", {
      cls: "okf-quick-capture-modal__context",
      attr: { type: "button" },
    });
    button.createEl("strong", { text: option.title });
    button.createSpan({ text: option.path });
    this.submitButtons.add(button);
    button.addEventListener("click", () => {
      const relation = kind === "course"
        ? normalizeCaptureRelation({ course: option.path })
        : normalizeCaptureRelation({ project: option.path });
      void this.submit(relation);
    });
  }

  private actionButton(
    parent: HTMLElement,
    label: string,
    className: string,
    action: () => void | Promise<void>,
  ): void {
    const button = parent.createEl("button", {
      text: label,
      cls: className,
      attr: { type: "button" },
    });
    this.submitButtons.add(button);
    button.addEventListener("click", () => void action());
  }

  private async submit(relation: CaptureRelation): Promise<void> {
    if (this.submitting) return;
    const value = this.value.trim();
    if (!value) {
      new Notice("请输入要记录的内容");
      return;
    }
    this.submitting = true;
    for (const button of this.submitButtons) button.disabled = true;
    try {
      await this.onSubmit(value, normalizeCaptureRelation(relation));
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "保存失败", 10_000);
    } finally {
      this.submitting = false;
      for (const button of this.submitButtons) button.disabled = false;
    }
  }
}

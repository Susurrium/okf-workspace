import { App, Modal, Notice, Setting } from "obsidian";
import { normalizeCaptureRelation, relationVaultPath, type CaptureContextOptions, type CaptureRelation } from "../domain/capture-context.js";

export class QuickCaptureModal extends Modal {
  private value: string;
  private readonly relation: CaptureRelation;
  private submitting = false;
  private textarea: HTMLTextAreaElement | undefined;
  private readonly controls: Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> = [];

  public constructor(app: App, private readonly contexts: CaptureContextOptions, initial: CaptureRelation,
    private readonly onSubmit: (value: string, relation: CaptureRelation) => Promise<void>,
    private readonly draft?: { text: string; save(text: string): void; relation?: CaptureRelation; saveRelation?(relation: CaptureRelation): void }) {
    super(app);
    this.value = draft?.text ?? "";
    this.relation = normalizeCaptureRelation(draft?.relation ?? initial);
  }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal", "okf-quick-capture-modal");
    this.titleEl.setText("快速记录");
    new Setting(this.contentEl).setName("内容").setDesc("保存到收集箱，随后再决定去向。")
      .addTextArea(area => {
        this.textarea = area.inputEl;
        area.setValue(this.value);
        area.setPlaceholder("想法、问题，或暂时不想打断当前工作的内容……");
        area.inputEl.rows = 7;
        area.onChange(value => { this.value = value; this.draft?.save(value); });
      });
    const context = this.contentEl.createEl("details", { cls: "okf-capture-context" });
    context.open = Boolean(this.relation.course || this.relation.project);
    context.createEl("summary", { text: "关联课程和项目（可选，可同时选择）" });
    for (const kind of ["course", "project"] as const) {
      const options = kind === "course" ? this.contexts.courses : this.contexts.projects;
      new Setting(context).setName(kind === "course" ? "课程" : "项目").addDropdown(input => {
        input.addOption("", "不关联");
        for (const option of options) input.addOption(`/${relationVaultPath(option.path)}`, option.title);
        const current = this.relation[kind] ?? "";
        if (current && !options.some(option => `/${relationVaultPath(option.path)}` === current)) input.addOption(current, `${current}（保留原关联）`);
        input.setValue(current).onChange(value => {
          if (value) this.relation[kind] = value; else delete this.relation[kind];
          this.draft?.saveRelation?.({ ...this.relation });
        });
        input.selectEl.setAttribute("aria-label", kind === "course" ? "关联课程" : "关联项目");
        this.controls.push(input.selectEl);
      });
    }
    new Setting(this.contentEl).setDesc("Ctrl + Enter 保存记录。选择关联时不会自动提交。")
      .addButton(button => {
        button.setButtonText("保存到收集箱").setCta().onClick(() => void this.submit());
        this.controls.push(button.buttonEl);
      });
    this.textarea?.addEventListener("keydown", event => {
      if (event.key === "Enter" && event.ctrlKey && !event.isComposing) { event.preventDefault(); void this.submit(); }
    });
    this.textarea?.focus();
  }

  public onClose(): void {
    this.draft?.save(this.value);
    this.draft?.saveRelation?.(this.value.trim() ? { ...this.relation } : {});
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    if (!this.value.trim()) { new Notice("请输入要记录的内容"); return; }
    this.submitting = true;
    if (this.textarea) this.textarea.disabled = true;
    this.controls.forEach(control => { control.disabled = true; });
    try {
      await this.onSubmit(this.value.trim(), normalizeCaptureRelation(this.relation));
      this.value = "";
      this.draft?.save("");
      this.close();
    } catch (error) { new Notice(error instanceof Error ? error.message : "保存失败", 10000); }
    finally {
      this.submitting = false;
      if (this.textarea) this.textarea.disabled = false;
      this.controls.forEach(control => { control.disabled = false; });
    }
  }
}

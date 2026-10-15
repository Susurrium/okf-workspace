import { Modal, type App } from "obsidian";

export class TaskTargetModal extends Modal {
  constructor(app: App, private readonly source: string, private readonly choices: Array<{ path: string; title: string }>,
    private readonly move: (path: string) => Promise<void>) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal");
    this.titleEl.setText("移动任务与子项");
    this.contentEl.createDiv({ text: `来源：${this.source}` });
    this.contentEl.createDiv({ text: "移动完整 Markdown 子树，保留身份、关联和任务链接。", cls: "okf-dashboard__muted" });
    const input = this.contentEl.createEl("input", { attr: { type: "text", list: "okf-move-targets", "aria-label": "目标笔记", placeholder: "搜索已有笔记，或输入路径…" } });
    const list = this.contentEl.createEl("datalist", { attr: { id: "okf-move-targets" } });
    for (const choice of this.choices) list.createEl("option", { text: choice.title, attr: { value: choice.path } });
    const failure = this.contentEl.createDiv({ cls: "okf-dashboard__error", attr: { role: "alert" } });
    const save = this.contentEl.createEl("button", { text: "移动", cls: "mod-cta", attr: { type: "button" } });
    save.addEventListener("click", () => {
      if (!input.value.trim()) { failure.setText("请选择目标笔记"); return; }
      save.disabled = true; input.disabled = true;
      void this.move(input.value.trim()).then(() => this.close()).catch(error => failure.setText(error instanceof Error ? error.message : "移动失败"))
        .finally(() => { save.disabled = false; input.disabled = false; });
    });
    this.contentEl.createEl("button", { text: "取消", attr: { type: "button" } }).addEventListener("click", () => { if (!save.disabled) this.close(); });
    input.focus();
  }
}

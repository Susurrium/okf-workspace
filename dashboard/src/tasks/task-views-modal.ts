import { Modal, Notice, type App } from "obsidian";
import type { SavedTaskView } from "./task-catalog.js";

export class TaskViewsModal extends Modal {
  public constructor(app: App, private readonly views: SavedTaskView[],
    private readonly update: (id: string, name: string) => Promise<void>, private readonly remove: (id: string) => Promise<void>) { super(app); }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal");
    this.titleEl.setText("管理待办视图");
    if (!this.views.length) this.contentEl.createDiv({ text: "还没有保存视图。在待办页面设置筛选和查询后保存。" });
    for (const view of this.views) {
      const row = this.contentEl.createDiv({ cls: "okf-saved-view" });
      const input = row.createEl("input", { attr: { type: "text", "aria-label": "视图名称" } });
      input.value = view.name;
      row.createDiv({ cls: "okf-dashboard__muted", text: [view.context.project ? `项目：${view.context.project}` : "",
        view.context.course ? `课程：${view.context.course}` : ""].filter(Boolean).join(" · ") || "全部内容" });
      if (view.query) row.createEl("pre", { text: view.query });
      const action = (text: string, execute: () => Promise<void>) => {
        const button = row.createEl("button", { text, attr: { type: "button" } });
        button.addEventListener("click", () => {
          button.disabled = true;
          void execute().catch(error => new Notice(error instanceof Error ? error.message : "视图操作失败"))
            .finally(() => { button.disabled = false; });
        });
      };
      action("保存名称", () => this.update(view.id, input.value));
      action("删除此视图", async () => { await this.remove(view.id); row.remove(); });
    }
  }
}

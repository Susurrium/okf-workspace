import { Modal, Notice, type App } from "obsidian";
import { VaultNoteService } from "./vault-note-service.js";

class WorkspaceContextModal extends Modal {
  private settled = false;
  private isClosed = false;
  public constructor(app: App, private readonly kind: "course" | "project",
    private readonly complete: (value: Record<string, unknown> | undefined) => void) { super(app); }

  public async onOpen(): Promise<void> {
    this.titleEl.setText(this.kind === "course" ? "选择学习工作台范围" : "选择项目工作台范围");
    const choose = (value: Record<string, unknown>): void => { this.settled = true; this.complete(value); this.close(); };
    this.contentEl.createEl("button", { text: "全部内容（总览）", attr: { type: "button" } })
      .addEventListener("click", () => choose({}));
    try {
      const contexts = await new VaultNoteService(this.app).captureContexts();
      if (this.isClosed) return;
      for (const item of this.kind === "course" ? contexts.courses : contexts.projects) {
        this.contentEl.createEl("button", { text: item.title, attr: { type: "button" } })
          .addEventListener("click", () => choose({ [this.kind]: item.path.replace(/^\//u, "") }));
      }
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); this.close(); }
  }

  public onClose(): void { this.isClosed = true; if (!this.settled) this.complete(undefined); }
}

export function chooseWorkspaceContext(app: App, presetId?: string): Promise<Record<string, unknown> | undefined> {
  if (presetId !== "learning" && presetId !== "project") return Promise.resolve({});
  return new Promise((resolve) => new WorkspaceContextModal(app, presetId === "learning" ? "course" : "project", resolve).open());
}

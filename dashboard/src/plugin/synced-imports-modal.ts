import { Modal, Notice, TFile, type App } from "obsidian";
import { openFileInWorkspace } from '../../apex/src/file-navigation.js';

import { listSyncedImports, saveSyncedDocument, type SyncedImportEntry } from "../imports/synced-intake.js";
import { DocumentImportModal } from "./document-import-modal.js";
import type { OriginalFiles } from "./original-files.js";

export async function renderSyncedImports(app: App, container: HTMLElement, originals?: OriginalFiles): Promise<void> {
  const entries = await listSyncedImports(app);
  container.empty();
  if (!entries.length) container.createDiv({ text: "还没有提交的资料。" });
  if (originals?.recoveryIssues.length) {
    for (const issue of originals.recoveryIssues) container.createDiv({ text: `${issue.filename}：${issue.message}` });
    const retry = container.createEl("button", { text: "重试恢复旧版文件" });
    retry.addEventListener("click", () => {
      retry.disabled = true;
      void originals.recover().then(() => renderSyncedImports(app, container, originals));
    });
  }
  let history: HTMLElement | undefined;
  for (const entry of entries) {
    const completed = entry.status === "imported" && (!entry.semanticStatus || entry.semanticStatus === "completed");
    if (completed && !history) {
      history = container.createEl("details");
      history.createEl("summary", { text: "已完成的导入" });
    }
    const card = (completed ? history! : container).createDiv({ cls: "okf-dashboard__card" });
    card.createEl("h3", { text: entry.filename });
    card.createDiv({ text: entry.message });
    const actions = card.createDiv({ cls: "okf-dashboard__actions" });
    if (originals && entry.digest) {
      const button = actions.createEl("button", { text: "打开原件" });
      button.addEventListener("click", () => void originals.open({ digest: entry.digest!, filename: entry.filename, path: entry.filePath || undefined }));
    }
    if (["stored", "imported", "failed"].includes(entry.status)) {
      const process = (label: string, generate = false): void => {
        const button = actions.createEl("button", { text: label });
        button.addEventListener("click", () => {
          button.disabled = true;
          void openProcessing(app, entry, generate).catch((error: unknown) => {
            new Notice(error instanceof Error ? error.message : String(error));
          }).finally(() => { button.disabled = false; });
        });
      };
      if (!entry.outputs.source_text) process(entry.status === "failed" && entry.action === "convert" ? "重试转换" : "转换正文");
      if (!["queued", "running"].includes(entry.semanticStatus ?? "")) {
        process(entry.semanticStatus === "failed" ? "重试生成笔记"
          : entry.outputs.source_text ? "生成笔记" : "转换并生成笔记", true);
      }
    }
    const paths = { ...(!originals && entry.filePath ? { "打开原文件": entry.filePath } : {}),
      ...(entry.outputs.source_text ? { "打开转换正文": entry.outputs.source_text } : {}),
      ...(entry.outputs.routed_target ? { "打开处理结果": entry.outputs.routed_target } : {}) };
    for (const [label, path] of Object.entries(paths)) {
      const button = actions.createEl("button", { text: label });
      button.addEventListener("click", () => {
        const file = app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) { new Notice("文件尚未同步到本机，请等待同步完成"); return; }
        void openFileInWorkspace(app, file).catch(error => new Notice(String(error)));
      });
    }
  }
}

async function openProcessing(app: App, entry: SyncedImportEntry, generate: boolean): Promise<void> {
  const original = app.vault.getAbstractFileByPath(entry.filePath);
  if (!(original instanceof TFile)) throw new Error("原件尚未同步到本机，请等待同步完成");
  const file = new File([await app.vault.readBinary(original)], entry.filename);
  new DocumentImportModal(app, [{ file, relativePath: entry.filename }],
    { course: entry.course, project: entry.project }, "command",
    (input, options) => saveSyncedDocument(app, input, options),
    undefined, undefined, true, "convert", generate, Boolean(entry.outputs.source_text), entry.generationKind).open();
}

export class SyncedImportsModal extends Modal {
  private timer?: number;
  private refreshing = false;
  private closed = false;
  public constructor(app: App, private readonly originals?: OriginalFiles) { super(app); }
  public onOpen(): void {
    this.titleEl.setText("已保存的资料");
    this.contentEl.createDiv({ text: "原件和笔记通过 LiveSync 同步。仅保存的原件可直接打开；明确选择转换后才由电脑处理。" });
    const list = this.contentEl.createDiv();
    const refresh = async (): Promise<void> => {
      if (this.refreshing || this.closed) return;
      this.refreshing = true;
      try { await renderSyncedImports(this.app, list, this.originals); }
      catch (error) { console.warn("[okf-workspace] could not read document submissions", error); }
      finally { this.refreshing = false; }
    };
    void refresh();
    this.timer = window.setInterval(() => void refresh(), 3_000);
  }
  public onClose(): void {
    this.closed = true;
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.contentEl.empty();
  }
}

import { Modal, Notice, type App } from "obsidian";

import type { DocumentImportOptions, DocumentImportResult, ImportIntent } from "../imports/types.js";
import {
  bindDocumentDropTarget,
  importFilesFromPicker,
  isSupportedDocument,
  MAX_DOCUMENT_BYTES,
  type ImportFile,
} from "../imports/drop.js";
import { VaultDashboardReader } from "./vault-dashboard.js";

export type ImportOrigin = "today" | "inbox" | "learning" | "context" | "command";
type Relation = Pick<DocumentImportOptions, "course" | "project">;

export class DocumentImportModal extends Modal {
  private files: ImportFile[];
  private readonly relation: Relation;
  private running = false;
  private closed = false;
  private readonly fileStates = new Map<ImportFile, string>();
  private intent: ImportIntent;
  private generate = false;
  private quality: DocumentImportOptions["quality"] = "quick";
  private parser: DocumentImportOptions["parser"] = "markitdown";
  private fileList?: HTMLElement;
  private status?: HTMLElement;
  private submitButton?: HTMLButtonElement;
  private unbindDrop?: () => void;

  public constructor(
    app: App,
    files: ImportFile[],
    initialRelation: Relation,
    origin: ImportOrigin,
    private readonly parserPolicy: "prefer-mineru" | "mineru-required" | "markitdown-only",
    private readonly importFile: (file: File, options: DocumentImportOptions) => Promise<DocumentImportResult>,
  ) {
    super(app);
    this.files = files;
    this.relation = { ...initialRelation };
    this.intent = origin === "learning" || origin === "context" && Boolean(initialRelation.course)
      ? "learn" : origin === "inbox" ? "later" : "source";
  }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal", "okf-document-import-modal");
    this.titleEl.setText("导入资料");
    const zone = this.contentEl.createDiv({ cls: "okf-document-import__drop okf-document-drop" });
    zone.createEl("strong", { text: "把文件或整个文件夹拖到这里" });
    zone.createDiv({ text: "支持 PDF、Word、PowerPoint；导入前可检查清单和归属。" });
    this.unbindDrop = bindDocumentDropTarget(zone, (files) => this.addFiles(files), this.showError);
    const pickers = zone.createDiv({ cls: "okf-document-import__pickers" });
    this.picker(pickers, "选择文件", false);
    this.picker(pickers, "选择文件夹", true);

    this.fileList = this.contentEl.createDiv({ cls: "okf-document-import__files" });
    this.renderFiles();

    const settings = this.contentEl.createDiv({ cls: "okf-document-import__settings" });
    this.select(settings, "用途", [
      ["learn", "用于学习"], ["wiki", "生成知识笔记"],
      ["source", "只保存资料"], ["later", "暂不确定，进入待归类"],
    ], this.intent, (value) => { this.intent = value as ImportIntent; this.renderGeneration(); });
    this.select(settings, "解析", this.parserPolicy === "markitdown-only"
      ? [["quick", "快速转换（MarkItDown）"]]
      : [["quick", "快速转换（MarkItDown）"], ["high", "精细转换（按设置选择工具）"]],
    this.quality, (value) => {
      this.quality = value as DocumentImportOptions["quality"];
      this.parser = value === "quick" ? "markitdown"
        : this.parserPolicy === "mineru-required" ? "mineru" : "auto";
    });
    const generation = settings.createDiv();
    this.generationContainer = generation;
    this.renderGeneration();
    this.renderRelation(settings);

    this.status = this.contentEl.createDiv({ cls: "okf-document-import__status", attr: { "aria-live": "polite" } });
    const actions = this.contentEl.createDiv({ cls: "okf-document-import__actions" });
    this.submitButton = actions.createEl("button", { cls: "mod-cta", text: "开始导入", attr: { type: "button" } });
    this.submitButton.addEventListener("click", () => void this.submit());
    this.updateSubmit();
  }

  private generationContainer?: HTMLElement;

  public onClose(): void {
    this.closed = true;
    this.unbindDrop?.();
    this.contentEl.empty();
  }

  private picker(parent: HTMLElement, label: string, directory: boolean): void {
    const button = parent.createEl("button", { text: label, attr: { type: "button" } });
    const input = parent.createEl("input", { attr: { type: "file", multiple: "" } });
    input.hidden = true;
    if (directory) input.setAttribute("webkitdirectory", "");
    else input.accept = ".pdf,.doc,.docx,.ppt,.pptx";
    button.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      if (input.files) this.addFiles(importFilesFromPicker(input.files));
      input.value = "";
    });
  }

  private select(
    parent: HTMLElement,
    label: string,
    options: readonly (readonly [string, string])[],
    value: string,
    onChange: (value: string) => void,
  ): HTMLSelectElement {
    const field = parent.createEl("label", { cls: "okf-document-import__field" });
    field.createSpan({ text: label });
    const select = field.createEl("select");
    for (const [key, title] of options) {
      const option = select.createEl("option", { text: title });
      option.value = key;
    }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  private renderGeneration(): void {
    const parent = this.generationContainer;
    if (!parent) return;
    parent.empty();
    if (this.intent !== "learn") { this.generate = false; return; }
    const label = parent.createEl("label", { cls: "okf-document-import__checkbox" });
    const input = label.createEl("input", { attr: { type: "checkbox" } });
    input.checked = this.generate;
    label.createSpan({ text: "转换后为每份资料生成辅助学习材料" });
    input.addEventListener("change", () => { this.generate = input.checked; });
  }

  private renderRelation(parent: HTMLElement): void {
    if (this.relation.course || this.relation.project) {
      parent.createDiv({
        cls: "okf-document-import__fixed-relation",
        text: `关联 ${this.relation.course ? `Course：${this.relation.course}` : `Project：${this.relation.project}`}`,
      });
      return;
    }
    const select = this.select(parent, "归属", [["", "独立资料"]], "", (value) => {
      delete this.relation.course;
      delete this.relation.project;
      if (value.startsWith("course:")) this.relation.course = value.slice(7);
      if (value.startsWith("project:")) this.relation.project = value.slice(8);
    });
    void new VaultDashboardReader(this.app).learning().then((data) => {
      for (const course of data.courses) {
        const slug = course.path.split("/")[2];
        if (!slug) continue;
        const option = select.createEl("option", { text: `Course：${course.title}` });
        option.value = `course:${slug}`;
      }
      for (const project of data.projects) {
        const slug = project.path.split("/")[1];
        if (!slug) continue;
        const option = select.createEl("option", { text: `Project：${project.title}` });
        option.value = `project:${slug}`;
      }
    }).catch(this.showError);
  }

  private readonly showError = (error: unknown): void => {
    new Notice(error instanceof Error ? error.message : String(error), 8_000);
  };

  private addFiles(incoming: ImportFile[]): void {
    if (this.running) return;
    this.files.push(...incoming);
    this.renderFiles();
    this.updateSubmit();
  }

  private renderFiles(): void {
    if (!this.fileList) return;
    this.fileList.empty();
    const accepted = this.files.filter((item) => this.isPending(item));
    this.fileList.createDiv({
      text: `待提交 ${accepted.length} 个；跳过 ${this.files.filter((item) => !isSupportedDocument(item.file) || item.file.size > MAX_DOCUMENT_BYTES).length} 个不支持或超过 64 MB 的文件`,
    });
    const list = this.fileList.createEl("ul");
    for (const item of this.files.slice(0, 200)) {
      const valid = isSupportedDocument(item.file) && item.file.size <= MAX_DOCUMENT_BYTES;
      list.createEl("li", { text: `${this.fileStates.get(item) ?? (valid ? "待提交" : "跳过")} · ${item.relativePath}` });
    }
    if (this.files.length > 200) this.fileList.createDiv({ text: `另有 ${this.files.length - 200} 个文件未展开显示` });
  }

  private updateSubmit(): void {
    if (this.submitButton) this.submitButton.disabled = this.running || !this.files.some((item) => this.isPending(item));
  }

  private isPending(item: ImportFile): boolean {
    return isSupportedDocument(item.file) && item.file.size <= MAX_DOCUMENT_BYTES
      && this.fileStates.get(item) !== "已提交";
  }

  private async submit(): Promise<void> {
    if (this.running) return;
    const files = this.files.filter((item) => this.isPending(item));
    if (!files.length) return;
    this.running = true;
    this.updateSubmit();
    const options: DocumentImportOptions = {
      intent: this.intent, quality: this.quality, parser: this.parser,
      generate: this.intent === "wiki" || this.intent === "learn" && this.generate, ...this.relation,
    };
    let completed = 0;
    let failed = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!this.closed && next < files.length) {
        const item = files[next++]!;
        this.fileStates.set(item, "上传中");
        this.renderFiles();
        if (this.status) this.status.setText(`已提交 ${completed}/${files.length}；正在上传 ${item.relativePath}`);
        try {
          const parser = /\.docx?$/iu.test(item.file.name) ? "markitdown" : options.parser;
          await this.importFile(item.file, { ...options, parser });
          this.fileStates.set(item, "已提交");
          completed++;
        } catch (error) {
          failed++;
          this.fileStates.set(item, `失败：${error instanceof Error ? error.message : String(error)}`);
        }
        this.renderFiles();
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, files.length) }, () => worker()));
    if (this.status) this.status.setText(`已提交 ${completed} 个，失败 ${failed} 个。后台转换进度可在待处理查看。`);
    this.running = false;
    if (this.submitButton && failed) this.submitButton.setText("重试失败项");
    this.updateSubmit();
  }
}

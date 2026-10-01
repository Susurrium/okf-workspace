import { Modal, Notice, type App } from "obsidian";

import type { DocumentImportOptions, DocumentImportResult, ImportIntent } from "../imports/types.js";
import { methodLabels, type ConversionMethod, type ConverterCatalogue } from "../imports/types.js";
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
  private method: ConversionMethod = "mineru-cloud";
  private catalogue?: ConverterCatalogue;
  private loadingMethods = false;
  private catalogueError?: string;
  private methodSelect?: HTMLSelectElement;
  private methodDetail?: HTMLElement;
  private skipUnsupported = false;
  private skipField?: HTMLElement;
  private fileList?: HTMLElement;
  private status?: HTMLElement;
  private submitButton?: HTMLButtonElement;
  private unbindDrop?: () => void;

  public constructor(
    app: App,
    files: ImportFile[],
    initialRelation: Relation,
    origin: ImportOrigin,
    private readonly importFile: (file: File, options: DocumentImportOptions) => Promise<DocumentImportResult>,
    private readonly loadConverters?: () => Promise<ConverterCatalogue>,
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
    zone.createDiv({ text: "支持 PDF、Word、PowerPoint 和图片；导入前可检查清单和归属。" });
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
    this.methodSelect = this.select(settings, "转换方式", Object.entries(methodLabels), this.method, (value) => {
      this.method = value as ConversionMethod;
      this.skipUnsupported = false;
      this.renderMethod();
    });
    this.methodDetail = settings.createDiv({ cls: "okf-dashboard__muted" });
    this.select(settings, "质量检查", [["quick", "标准检查"], ["high", "严格检查图片"]],
    this.quality, (value) => {
      this.quality = value as DocumentImportOptions["quality"];
    });
    this.skipField = settings.createDiv();
    const generation = settings.createDiv();
    this.generationContainer = generation;
    this.renderGeneration();
    this.renderRelation(settings);

    this.status = this.contentEl.createDiv({ cls: "okf-document-import__status", attr: { "aria-live": "polite" } });
    const actions = this.contentEl.createDiv({ cls: "okf-document-import__actions" });
    this.submitButton = actions.createEl("button", { cls: "mod-cta", text: "开始导入", attr: { type: "button" } });
    this.submitButton.addEventListener("click", () => void this.submit());
    this.updateSubmit();
    if (this.loadConverters) void this.fetchConverters();
    else this.renderMethod();
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
    else input.accept = ".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.bmp,.gif";
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

  private async fetchConverters(): Promise<void> {
    this.loadingMethods = true;
    this.catalogueError = undefined;
    this.renderMethod();
    try {
      const catalogue = await this.loadConverters!();
      if (this.closed) return;
      this.catalogue = catalogue;
      this.method = catalogue.default_method;
    } catch (error) {
      this.catalogueError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loadingMethods = false;
      if (!this.closed) this.renderMethod();
    }
  }

  private renderMethod(): void {
    const info = this.catalogue?.methods.find((item) => item.id === this.method);
    if (this.methodSelect) {
      this.methodSelect.value = this.method;
      this.methodSelect.disabled = this.running || this.loadingMethods;
      for (const option of Array.from(this.methodSelect.children) as HTMLOptionElement[]) {
        const entry = this.catalogue?.methods.find((item) => item.id === option.value);
        option.textContent = (entry?.label ?? methodLabels[option.value as ConversionMethod])
          + (option.value === this.catalogue?.default_method ? "（默认）" : "")
          + (entry && !entry.configured ? "（未配置）" : "");
      }
    }
    this.methodDetail?.empty();
    this.methodDetail?.createDiv({ text: this.loadingMethods ? "正在读取转换方式…"
      : this.catalogueError ? `无法读取转换方式：${this.catalogueError}`
        : info ? `${info.location}；${info.limitations}${info.reason ? ` ${info.reason}` : ""}`
          : "MinerU 云解析默认；可选择其他已配置的转换方式。" });
    if (this.catalogueError) {
      this.methodDetail?.createEl("button", { text: "重新读取转换方式" })
        .addEventListener("click", () => void this.fetchConverters());
    }
    this.skipField?.empty();
    if (this.files.some((item) => this.unsupportedReason(item))) {
      const label = this.skipField?.createEl("label");
      const input = label?.createEl("input", { attr: { type: "checkbox" } });
      label?.createSpan({ text: "仅提交支持的文件，跳过清单中无法转换的文件" });
      if (input) {
        input.checked = this.skipUnsupported;
        input.addEventListener("change", () => {
          this.skipUnsupported = input.checked;
          this.updateSubmit();
        });
      }
    }
    this.renderFiles();
    this.updateSubmit();
  }

  private unsupportedReason(item: ImportFile): string | undefined {
    if (!isSupportedDocument(item.file)) return "不支持的文件格式";
    const info = this.catalogue?.methods.find((entry) => entry.id === this.method);
    if (item.file.size > (info?.max_upload_bytes ?? MAX_DOCUMENT_BYTES)) return "文件超过上传大小限制";
    const extension = "." + item.file.name.split(".").pop()!.toLowerCase();
    if (info && !info.extensions.includes(extension)) return `${info.label} 不支持 ${extension}`;
    return undefined;
  }

  private addFiles(incoming: ImportFile[]): void {
    if (this.running) return;
    this.files.push(...incoming);
    this.renderMethod();
  }

  private renderFiles(): void {
    if (!this.fileList) return;
    this.fileList.empty();
    const accepted = this.files.filter((item) => this.isPending(item));
    this.fileList.createDiv({
      text: `待提交 ${accepted.length} 个；${this.files.filter((item) => this.unsupportedReason(item)).length} 个文件无法使用当前方式转换`,
    });
    const list = this.fileList.createEl("ul");
    for (const item of this.files.slice(0, 200)) {
      list.createEl("li", { text: `${this.unsupportedReason(item) ?? this.fileStates.get(item) ?? "待提交"} · ${item.relativePath}` });
    }
    if (this.files.length > 200) this.fileList.createDiv({ text: `另有 ${this.files.length - 200} 个文件未展开显示` });
  }

  private updateSubmit(): void {
    const info = this.catalogue?.methods.find((item) => item.id === this.method);
    if (this.submitButton) this.submitButton.disabled = this.running || this.loadingMethods
      || Boolean(this.catalogueError) || Boolean(this.catalogue && (!info || !info.configured))
      || !this.files.some((item) => this.isPending(item))
      || !this.skipUnsupported && this.files.some((item) => this.unsupportedReason(item));
  }

  private isPending(item: ImportFile): boolean {
    return !this.unsupportedReason(item)
      && this.fileStates.get(item) !== "已提交";
  }

  private async submit(): Promise<void> {
    if (this.running) return;
    if (this.submitButton?.disabled) return;
    const files = this.files.filter((item) => this.isPending(item));
    if (!files.length) return;
    this.running = true;
    this.renderMethod();
    const options: DocumentImportOptions = {
      intent: this.intent, quality: this.quality, parser: "auto", method: this.method,
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
          await this.importFile(item.file, options);
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
    this.renderMethod();
  }
}

export class DocumentReconversionModal extends Modal {
  public constructor(
    app: App,
    private readonly filename: string,
    private readonly loadConverters: () => Promise<ConverterCatalogue>,
    private readonly convert: (method: ConversionMethod) => Promise<void>,
  ) { super(app); }

  public onOpen(): void {
    this.titleEl.setText("重新转换资料");
    this.contentEl.createDiv({ text: this.filename });
    this.contentEl.createDiv({ text: "沿用原件和资料身份；已有正文包含人工修改时会保留正文，新结果可单独查看。" });
    const choices = this.contentEl.createDiv();
    choices.createDiv({ text: "正在读取转换方式…" });
    void this.loadConverters().then((catalogue) => {
      if (!this.contentEl.isConnected) return;
      choices.empty();
      const extension = "." + this.filename.split(".").pop()!.toLowerCase();
      for (const method of catalogue.methods) {
        const supported = method.extensions.includes(extension);
        const row = choices.createDiv();
        const button = row.createEl("button", { text: `使用 ${method.label} 重新转换` });
        button.disabled = !method.configured || !supported;
        row.createDiv({ text: `${method.location}；${!supported ? `不支持 ${extension}` : method.reason || method.limitations}` });
        button.addEventListener("click", () => {
          if (button.disabled) return;
          for (const element of Array.from(choices.querySelectorAll("button"))) element.disabled = true;
          void this.convert(method.id).then(() => this.close()).catch((error: unknown) => {
            new Notice(error instanceof Error ? error.message : String(error));
            this.close();
          });
        });
      }
    }).catch((error: unknown) => {
      choices.empty();
      choices.createDiv({ text: error instanceof Error ? error.message : String(error) });
      choices.createEl("button", { text: "重试读取" }).addEventListener("click", () => {
        this.contentEl.empty();
        this.onOpen();
      });
    });
  }

  public onClose(): void { this.contentEl.empty(); }
}

export class DocumentConversionResultModal extends Modal {
  public constructor(app: App, private readonly result: {
    markdown: string; method: ConversionMethod; asset_paths: string[];
    qc: { passed: boolean; warnings: string[]; errors: string[] };
  }) { super(app); }

  public onOpen(): void {
    this.titleEl.setText("本次转换结果（只读）");
    this.contentEl.createDiv({ text: `${methodLabels[this.result.method]} · ${this.result.qc.passed ? "质量检查通过" : "质量检查未通过"}` });
    for (const message of [...this.result.qc.errors, ...this.result.qc.warnings]) {
      this.contentEl.createDiv({ text: message });
    }
    this.contentEl.createDiv({ text: `包含 ${this.result.asset_paths.length} 个附件；下方显示本次转换的 Markdown 源文。` });
    const source = this.contentEl.createEl("textarea", { attr: { readonly: "", rows: "20", "aria-label": "本次转换的 Markdown 源文" } });
    source.value = this.result.markdown;
    source.setAttr("style", "width: 100%;");
  }
  public onClose(): void { this.contentEl.empty(); }
}

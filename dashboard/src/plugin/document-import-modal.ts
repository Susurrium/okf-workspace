import { Modal, Notice, Platform, type App } from "obsidian";
import type { SavedDocumentImport } from "../imports/synced-intake.js";

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
export type ImportRelationKind = "course" | "project";
export type CreateImportRelation = (
  kind: ImportRelationKind, title: string, slug?: string,
) => Promise<{ path: string }>;

export class DocumentImportModal extends Modal {
  private files: ImportFile[];
  private readonly relation: Relation;
  private running = false;
  private hadFailures = false;
  private closed = false;
  private readonly fileStates = new Map<ImportFile, string>();
  private intent: ImportIntent;
  private action: "store" | "convert" = "store";
  private processingContainer?: HTMLElement;
  private generationKind: "learn" | "wiki" = "learn";
  private generate = false;
  private quality: DocumentImportOptions["quality"] = "quick";
  private method: ConversionMethod | "auto" = "auto";
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
  private relationSelect?: HTMLSelectElement;
  private relationHint?: HTMLElement;
  private relationForm?: HTMLElement;
  private readonly relationCreateButtons: HTMLButtonElement[] = [];
  private readonly createdRelations = new Map<string, string>();
  private creatingRelation = false;
  private savingRelation = false;
  private relationLoadVersion = 0;

  public constructor(
    app: App,
    files: ImportFile[],
    initialRelation: Relation,
    _origin: ImportOrigin,
    private readonly importFile: (file: File, options: DocumentImportOptions) => Promise<DocumentImportResult | SavedDocumentImport>,
    private readonly loadConverters?: () => Promise<ConverterCatalogue>,
    private readonly createRelation?: CreateImportRelation,
    private readonly synced = false,
    initialAction: "store" | "convert" = "store",
    initialGeneration = false,
    private readonly reuseText = false,
    initialGenerationKind: "learn" | "wiki" = "learn",
  ) {
    super(app);
    this.files = files;
    this.relation = { ...initialRelation };
    if (synced) this.method = "auto";
    this.action = initialAction;
    this.generate = initialGeneration;
    this.generationKind = initialGenerationKind;
    this.intent = "source";
  }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal", "okf-document-import-modal");
    this.titleEl.setText(this.reuseText ? "生成笔记" : "添加资料");
    const zone = this.contentEl.createDiv({ cls: "okf-document-import__drop okf-document-drop" });
    zone.createEl("strong", { text: Platform.isMobile ? "选择要导入的资料" : "把文件或整个文件夹拖到这里" });
    zone.createDiv({ text: "支持 PDF、Word、PowerPoint 和图片；导入前可检查清单和归属。" });
    if (!this.reuseText) this.unbindDrop = bindDocumentDropTarget(zone, (files) => this.addFiles(files), this.showError);
    const pickers = zone.createDiv({ cls: "okf-document-import__pickers" });
    if (!this.reuseText) this.picker(pickers, "选择文件", false);
    if (!this.reuseText && !Platform.isMobile) this.picker(pickers, "选择文件夹", true);

    this.fileList = this.contentEl.createDiv({ cls: "okf-document-import__files" });
    this.renderFiles();

    const settings = this.contentEl.createDiv({ cls: "okf-document-import__settings" });
    if (!this.reuseText) this.select(settings, "处理方式", [["store", "仅保存原件"], ["convert", "保存并转换正文"]],
      this.action, (value) => {
        this.action = value as "store" | "convert";
        this.generate = false;
        this.skipUnsupported = false;
        this.renderProcessing();
        if (this.action === "convert" && this.loadConverters && !this.catalogue && !this.loadingMethods) void this.fetchConverters();
      });
    this.processingContainer = settings.createDiv();
    this.renderProcessing();
    this.select(settings, "整理", [["source", "保存为资料"], ["later", "暂不确定，放入待归类"]],
      this.intent, (value) => { this.intent = value as ImportIntent; });
    this.renderRelation(settings);
    if (this.synced) settings.createDiv({ text: "原件保存在笔记库，随 LiveSync 全量同步；同步后可直接离线阅读。" });

    this.status = this.contentEl.createDiv({ cls: "okf-document-import__status", attr: { "aria-live": "polite" } });
    const actions = this.contentEl.createDiv({ cls: "okf-document-import__actions" });
    this.submitButton = actions.createEl("button", { cls: "mod-cta", text: "保存原件", attr: { type: "button" } });
    this.submitButton.addEventListener("click", () => void this.submit());
    this.updateSubmit();
    if (this.action === "convert" && this.loadConverters) void this.fetchConverters();
    else this.renderMethod();
  }

  private generationContainer?: HTMLElement;

  private renderProcessing(): void {
    const parent = this.processingContainer;
    if (!parent) return;
    parent.empty();
    this.methodSelect = undefined;
    this.methodDetail = undefined;
    this.skipField = undefined;
    this.generationContainer = undefined;
    if (this.action === "store") {
      parent.createDiv({ text: "保存到笔记库，随笔记同步。电脑上线也不会自动转换，需要时可再转换。" });
    } else if (this.reuseText) {
      parent.createDiv({ text: "使用已有正文生成笔记，保留原件和正文，不重新转换。" });
      this.generationContainer = parent.createDiv();
      this.renderGeneration();
    } else {
      parent.createDiv({ text: "保留原件并提取 Markdown 正文。电脑未运行时，转换请求会等待处理。" });
      const advanced = parent.createEl("details");
      advanced.createEl("summary", { text: "转换设置" });
      this.methodSelect = this.select(advanced, "转换方式", [["auto", "使用默认方式"], ...Object.entries(methodLabels)],
        this.method, (value) => { this.method = value as ConversionMethod | "auto"; this.skipUnsupported = false; this.renderMethod(); });
      this.methodDetail = advanced.createDiv({ cls: "okf-dashboard__muted" });
      this.select(advanced, "转换结果检查", [["quick", "标准检查"], ["high", "严格检查图片"]],
        this.quality, (value) => { this.quality = value as DocumentImportOptions["quality"]; });
      advanced.createDiv({ text: "严格检查会拦截图片缺失等问题，不会提高文字识别精度。" });
      this.skipField = parent.createDiv();
      this.generationContainer = parent.createDiv();
      this.renderGeneration();
    }
    this.renderMethod();
  }

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
    select.addEventListener("change", () => { if (!this.running) onChange(select.value); });
    return select;
  }

  private renderGeneration(): void {
    const parent = this.generationContainer;
    if (!parent) return;
    parent.empty();
    if (!this.reuseText) {
      const label = parent.createEl("label", { cls: "okf-document-import__checkbox" });
      const input = label.createEl("input", { attr: { type: "checkbox" } });
      input.checked = this.generate;
      label.createSpan({ text: "转换完成后生成笔记" });
      input.addEventListener("change", () => { if (this.running) return; this.generate = input.checked; this.renderGeneration(); this.updateSubmit(); });
    }
    if (this.generate) this.select(parent, "笔记类型", [["learn", "学习指南"], ["wiki", "Wiki 知识笔记"]],
      this.generationKind, (value) => { this.generationKind = value as "learn" | "wiki"; this.updateSubmit(); });
  }

  private renderRelation(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "okf-document-import__relation" });
    const initial = this.relationValue();
    const choices: [string, string][] = [["", "独立资料"]];
    if (initial) choices.push([initial, this.relationLabel(initial)]);
    this.relationSelect = this.select(section, "归属", choices, initial, (value) => {
      if (this.running || this.creatingRelation) {
        this.relationSelect!.value = this.relationValue();
        return;
      }
      this.setRelation(value);
    });
    this.relationHint = section.createDiv({ cls: "okf-dashboard__muted", attr: { "aria-live": "polite" } });
    if (this.createRelation) {
      const actions = section.createDiv({ cls: "okf-document-import__relation-actions" });
      for (const kind of ["course", "project"] as const) {
        const button = actions.createEl("button", {
          text: kind === "course" ? "新建课程…" : "新建项目…", attr: { type: "button" },
        });
        button.addEventListener("click", () => this.beginCreateRelation(kind));
        this.relationCreateButtons.push(button);
      }
    }
    this.relationForm = section.createDiv();
    void this.refreshRelations();
  }

  private relationValue(): string {
    return this.relation.course ? `course:${this.relation.course}`
      : this.relation.project ? `project:${this.relation.project}` : "";
  }

  private relationLabel(value: string): string {
    return `${value.startsWith("course:") ? "Course" : "Project"}：${value.slice(value.indexOf(":") + 1)}`;
  }

  private setRelation(value: string): void {
    delete this.relation.course;
    delete this.relation.project;
    if (value.startsWith("course:")) this.relation.course = value.slice(7);
    if (value.startsWith("project:")) this.relation.project = value.slice(8);
  }

  private async refreshRelations(): Promise<void> {
    const version = ++this.relationLoadVersion;
    this.relationHint?.empty();
    this.relationHint?.setText("正在读取已有课程和项目…");
    try {
      const data = await new VaultDashboardReader(this.app).learning();
      if (this.closed || version !== this.relationLoadVersion) return;
      const choices = new Map<string, string>();
      for (const course of data.courses) {
        const slug = course.path.split("/")[2];
        if (slug) choices.set(`course:${slug}`, `Course：${course.title}`);
      }
      for (const project of data.projects) {
        const slug = project.path.split("/")[1];
        if (slug) choices.set(`project:${slug}`, `Project：${project.title}`);
      }
      for (const [value, title] of this.createdRelations) {
        if (!choices.has(value)) choices.set(value, title);
      }
      const selected = this.relationValue();
      if (selected && !choices.has(selected)) choices.set(selected, this.relationLabel(selected));
      const select = this.relationSelect!;
      select.empty();
      select.createEl("option", { text: "独立资料" }).value = "";
      for (const [value, title] of choices) select.createEl("option", { text: title }).value = value;
      select.value = selected;
      this.relationHint?.setText(choices.size ? "没有合适的归属时，可以新建课程或项目。"
        : "还没有课程或项目，可以新建，也可以保持独立资料。");
    } catch (error) {
      if (this.closed || version !== this.relationLoadVersion) return;
      this.relationHint?.empty();
      this.relationHint?.createDiv({ text: `无法读取已有归属：${error instanceof Error ? error.message : String(error)}` });
      this.relationHint?.createEl("button", { text: "重新读取归属", attr: { type: "button" } })
        .addEventListener("click", () => void this.refreshRelations());
    }
  }

  private beginCreateRelation(kind: ImportRelationKind): void {
    if (!this.createRelation || this.running || this.creatingRelation || this.closed) return;
    this.creatingRelation = true;
    this.updateSubmit();
    const name = kind === "course" ? "课程" : "项目";
    const form = this.relationForm!.createEl("form", { cls: "okf-document-import__create-relation" });
    form.createEl("strong", { text: `新建${name}` });
    const titleField = form.createEl("label", { cls: "okf-document-import__field" });
    titleField.createSpan({ text: `${name}名称` });
    const titleInput = titleField.createEl("input", { attr: { type: "text", required: "" } });
    const slugField = form.createEl("label", { cls: "okf-document-import__field" });
    slugField.createSpan({ text: "目录名（可留空）" });
    const slugInput = slugField.createEl("input", { attr: { type: "text" } });
    const error = form.createDiv({ cls: "okf-document-import__relation-error", attr: { role: "alert" } });
    const actions = form.createDiv({ cls: "okf-document-import__relation-actions" });
    const save = actions.createEl("button", { text: "创建并选中", cls: "mod-cta", attr: { type: "submit" } });
    const cancel = actions.createEl("button", { text: "取消新建", attr: { type: "button" } });
    cancel.addEventListener("click", () => {
      if (this.savingRelation) return;
      this.creatingRelation = false;
      this.relationForm?.empty();
      this.updateSubmit();
      this.relationSelect?.focus();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.savingRelation || this.closed) return;
      const title = titleInput.value.trim();
      if (!title) {
        error.setText(`请填写${name}名称`);
        titleInput.focus();
        return;
      }
      this.savingRelation = true;
      titleInput.disabled = slugInput.disabled = save.disabled = cancel.disabled = true;
      error.empty();
      void this.createRelation!(kind, title, slugInput.value.trim() || undefined).then((result) => {
        if (this.closed) return;
        const match = (kind === "course" ? /^learning\/courses\/([^/]+)\/course\.md$/u
          : /^projects\/([^/]+)\/project\.md$/u).exec(result.path);
        if (!match?.[1]) throw new Error(`无法识别新建${name}的路径：${result.path}`);
        const value = `${kind}:${match[1]}`;
        const label = `${kind === "course" ? "Course" : "Project"}：${title}`;
        this.createdRelations.set(value, label);
        this.setRelation(value);
        this.relationSelect!.createEl("option", { text: label }).value = value;
        this.relationSelect!.value = value;
        this.creatingRelation = false;
        this.relationForm?.empty();
        void this.refreshRelations();
        this.relationSelect?.focus();
      }).catch((failure: unknown) => {
        if (!this.closed) error.setText(failure instanceof Error ? failure.message : String(failure));
      }).finally(() => {
        this.savingRelation = false;
        if (this.closed) return;
        titleInput.disabled = slugInput.disabled = save.disabled = cancel.disabled = false;
        this.updateSubmit();
      });
    });
    titleInput.focus();
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
        option.textContent = (entry?.label ?? (option.value === "auto" ? "使用电脑默认方式" : methodLabels[option.value as ConversionMethod]))
          + (option.value === this.catalogue?.default_method ? "（默认）" : "")
          + (entry && !entry.configured ? "（未配置）" : "");
      }
    }
    this.methodDetail?.empty();
    this.methodDetail?.createDiv({ text: this.loadingMethods ? "正在读取转换方式…"
      : this.catalogueError ? `无法读取转换方式：${this.catalogueError}`
        : info ? `${info.location}；${info.limitations}${info.reason ? ` ${info.reason}` : ""}`
          : this.synced ? "资料先保存在本机，电脑上线后自动转换；选择其他方式时由电脑确认配置。"
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
    const info = this.action === "convert" ? this.catalogue?.methods.find((entry) => entry.id === this.method) : undefined;
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
      text: `待保存 ${accepted.length} 个；${this.files.filter((item) => this.unsupportedReason(item)).length} 个文件不符合${this.action === "store" ? "保存" : "转换"}要求`,
    });
    const list = this.fileList.createEl("ul");
    for (const item of this.files.slice(0, 200)) {
      list.createEl("li", { text: `${this.unsupportedReason(item) ?? this.fileStates.get(item) ?? "待提交"} · ${item.relativePath}` });
    }
    if (this.files.length > 200) this.fileList.createDiv({ text: `另有 ${this.files.length - 200} 个文件未展开显示` });
  }

  private updateSubmit(): void {
    const relationDisabled = this.running || this.creatingRelation;
    if (this.relationSelect) this.relationSelect.disabled = relationDisabled;
    for (const button of this.relationCreateButtons) button.disabled = relationDisabled;
    const info = this.catalogue?.methods.find((item) => item.id === this.method);
    if (this.submitButton) this.submitButton.setText(this.running ? "正在保存…" : this.hadFailures ? "重试失败项" : this.reuseText ? "生成笔记" : this.action === "store"
      ? "保存原件" : this.generate ? "保存、转换并生成笔记" : "保存并转换正文");
    if (this.submitButton) this.submitButton.disabled = this.running || this.creatingRelation
      || this.action === "convert" && (this.loadingMethods || Boolean(this.catalogueError)
      || Boolean(this.catalogue && this.method !== "auto" && (!info || !info.configured)))
      || !this.files.some((item) => this.isPending(item))
      || !this.skipUnsupported && this.files.some((item) => this.unsupportedReason(item));
  }

  private isPending(item: ImportFile): boolean {
    return !this.unsupportedReason(item)
      && !["已提交", "已保存到本机"].includes(this.fileStates.get(item) ?? "");
  }

  private async submit(): Promise<void> {
    if (this.running) return;
    if (this.submitButton?.disabled) return;
    const files = this.files.filter((item) => this.isPending(item));
    if (!files.length) return;
    this.running = true;
    this.hadFailures = false;
    this.renderMethod();
    const options: DocumentImportOptions = {
      action: this.action, intent: this.action === "convert" && this.generate ? this.generationKind : this.intent,
      quality: this.quality, parser: "auto", method: this.method,
      generate: this.action === "convert" && this.generate, ...this.relation,
    };
    let completed = 0;
    let failed = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!this.closed && next < files.length) {
        const item = files[next++]!;
        this.fileStates.set(item, this.synced ? "保存中" : "上传中");
        this.renderFiles();
        if (this.status) this.status.setText(`已提交 ${completed}/${files.length}；正在上传 ${item.relativePath}`);
        try {
          await this.importFile(item.file, options);
          this.fileStates.set(item, this.synced ? "已保存到本机" : "已提交");
          completed++;
        } catch (error) {
          failed++;
          this.fileStates.set(item, `失败：${error instanceof Error ? error.message : String(error)}`);
        }
        this.renderFiles();
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.synced ? 1 : 2, files.length) }, () => worker()));
    if (this.status) this.status.setText(this.action === "store"
      ? `已保存 ${completed} 个原件，失败 ${failed} 个。原件随笔记同步，不会自动转换。`
      : this.synced
      ? `已保存 ${completed} 个，失败 ${failed} 个。处理请求随笔记同步，电脑运行后执行；可在“已保存的资料”查看结果。`
      : `已提交 ${completed} 个，失败 ${failed} 个。后台转换进度可在待处理查看。`);
    this.running = false;
    this.hadFailures = failed > 0;
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

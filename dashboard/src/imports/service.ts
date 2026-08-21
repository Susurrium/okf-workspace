import type {
  DocumentImportOptions,
  DocumentImportResult,
} from "./types.js";

export interface DocumentImportApi {
  importDocument(file: File, options: DocumentImportOptions): Promise<DocumentImportResult>;
}

export class HttpDocumentImportApi implements DocumentImportApi {
  public constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 120_000,
  ) {}

  public async importDocument(
    file: File,
    options: DocumentImportOptions,
  ): Promise<DocumentImportResult> {
    const form = new FormData();
    form.set("file", file);
    form.set("intent", options.intent);
    form.set("quality", options.quality);
    form.set("parser", options.parser);
    form.set("generate", String(options.generate));
    if (options.course) form.set("course", options.course);
    if (options.project) form.set("project", options.project);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/documents/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}` },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
        throw new Error("文档上传超时，请确认工作区服务可用后重试", { cause: error });
      }
      throw error;
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `文档导入失败（HTTP ${response.status}）`);
    }
    return (await response.json()) as DocumentImportResult;
  }
}

import type {
  ConversionRecord,
  GovernanceReport,
  NoteSummary,
  SemanticOperationRecord,
  SystemStatus,
  TodayView,
  WebCaptureAction,
  WebCapturePublishResult,
} from "./types.js";
import type { FeedSyncResult } from "../feeds/types.js";
import { WorkspaceHttpClient } from "./http-client.js";

export class LocalApi {
  private readonly http: WorkspaceHttpClient;

  public constructor(
    public readonly baseUrl: string,
    token: string,
    expectedVaultFingerprint?: string,
  ) {
    this.http = new WorkspaceHttpClient({
      baseUrl,
      token,
      expectedVaultFingerprint,
      defaultTimeout: 15_000,
      setJsonContentTypeForBody: true,
      onHttpError: (status, detail) => this.httpError(status, detail),
      onTransportError: (error, timedOut) => this.transportError(error, timedOut),
    });
  }

  public today(date?: string): Promise<TodayView> {
    const query = date ? `?target_date=${encodeURIComponent(date)}` : "";
    return this.request(`/today${query}`);
  }

  public dashboard<T>(area: "inbox" | "learning" | "projects" | "knowledge" | "life"): Promise<T> {
    return this.request(`/dashboard/${area}`);
  }

  public notes(): Promise<NoteSummary[]> {
    return this.request("/notes");
  }

  public createDaily(date?: string): Promise<{ path: string }> {
    return this.request("/daily", {
      method: "POST",
      body: JSON.stringify({ date }),
    });
  }

  public createCapture(
    title: string,
    content: string,
    relation: { course?: string; project?: string } = {},
  ): Promise<{ path: string }> {
    return this.request("/captures", {
      method: "POST",
      body: JSON.stringify({ title, content, ...relation }),
    });
  }

  public createReflection(title: string, content: string): Promise<{ path: string }> {
    return this.request("/reflections", {
      method: "POST",
      body: JSON.stringify({ title, content }),
    });
  }

  public createCourse(title: string, slug?: string): Promise<{ path: string }> {
    return this.request("/courses", {
      method: "POST",
      body: JSON.stringify({ title, slug }),
    });
  }

  public createLesson(
    course: string,
    title: string,
    content: string,
  ): Promise<{ path: string }> {
    return this.request("/lessons", {
      method: "POST",
      body: JSON.stringify({ course, title, content }),
    });
  }

  public createProject(title: string, slug?: string, category?: string): Promise<{ path: string }> {
    return this.request("/projects", {
      method: "POST",
      body: JSON.stringify({ title, slug, project_category: category }),
    });
  }

  public setProjectCategory(slug: string, category: string | null, expected?: string | null): Promise<{ path: string }> {
    return this.request(`/projects/${encodeURIComponent(slug)}/category`, { method: "POST",
      body: JSON.stringify({ project_category: category, expected_category: expected, check_expected: expected !== undefined }) });
  }

  public organizeCapture(
    path: string,
    destination:
      | "reflection"
      | "wiki"
      | "study-guide"
      | "lesson"
      | "project-log",
    options: { title?: string; project?: string; course?: string } = {},
  ): Promise<{ created_or_updated: string; capture_deleted: string }> {
    return this.request("/ai/organize", {
      method: "POST",
      body: JSON.stringify({ path, destination, ...options }),
    }, 180_000);
  }

  public discardCapture(path: string): Promise<{ capture_deleted: string }> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return this.request(`/captures/${encoded}/discard`, { method: "POST" });
  }

  public publishWebCapture(
    path: string,
    options: {
      action: WebCaptureAction;
      course?: string;
      project?: string;
    },
  ): Promise<WebCapturePublishResult> {
    return this.request("/captures/publish-web", {
      method: "POST",
      body: JSON.stringify({ path, ...options }),
    });
  }

  public batchCaptures(
    action: "discard",
    paths: string[],
  ): Promise<{ action: "discard"; count: number; deleted: string[] }> {
    return this.request("/captures/batch", {
      method: "POST",
      body: JSON.stringify({ action, paths }),
    });
  }

  public recommendCapture(path: string): Promise<{ destination: string; reason: string }> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return this.request(`/captures/${encoded}/recommend`);
  }

  public ask(query: string): Promise<{ answer: string; actual_reads: { path: string }[] }> {
    return this.request("/ai/ask", {
      method: "POST",
      body: JSON.stringify({ query }),
    }, 180_000);
  }

  public setNoteFields(
    path: string,
    fields: { status?: string; studied?: boolean },
  ): Promise<{ path: string }> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return this.request(`/notes/${encoded}/fields`, {
      method: "POST",
      body: JSON.stringify(fields),
    });
  }

  public recordProjectProgress(slug: string, content: string): Promise<{ path: string }> {
    return this.request(`/projects/${encodeURIComponent(slug)}/log`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  public summarizeProject(
    slug: string,
  ): Promise<{ path: string; actual_reads: string[] }> {
    return this.request(`/ai/projects/${encodeURIComponent(slug)}/summarize`, {
      method: "POST",
      body: "{}",
    }, 180_000);
  }

  public organizeLesson(
    path: string,
  ): Promise<{ path: string; actual_reads: string[] }> {
    return this.request("/ai/lessons/organize", {
      method: "POST",
      body: JSON.stringify({ path }),
    }, 180_000);
  }

  public createLearningPlan(
    path: string,
  ): Promise<{ path: string; actual_reads: string[] }> {
    return this.request("/ai/learning/plan", {
      method: "POST",
      body: JSON.stringify({ path }),
    }, 180_000);
  }

  public selfTest(path: string): Promise<{ content: string; actual_reads: string[] }> {
    return this.request("/ai/self-test", {
      method: "POST",
      body: JSON.stringify({ path }),
    }, 180_000);
  }

  public createWikiDraft(
    title: string,
    paths: string[],
    instruction: string,
  ): Promise<{ path: string; actual_reads: string[] }> {
    return this.request("/ai/knowledge/create", {
      method: "POST",
      body: JSON.stringify({ title, paths, instruction }),
    }, 180_000);
  }

  public rewriteSection(
    path: string,
    heading: string,
    instruction: string,
  ): Promise<{ path: string; actual_reads: string[] }> {
    return this.request("/ai/section/rewrite", {
      method: "POST",
      body: JSON.stringify({ path, heading, instruction }),
    }, 180_000);
  }

  public rebuildIndex(): Promise<unknown> {
    return this.request("/index/rebuild", { method: "POST" }, 60_000);
  }

  public syncIndex(): Promise<unknown> {
    return this.request("/index/sync", { method: "POST" }, 60_000);
  }

  public undo(): Promise<{ checkpoint: string }> {
    return this.request("/undo", { method: "POST" });
  }

  public latestChange(): Promise<{
    checkpoint: string;
    message: string;
    files: string[];
  } | null> {
    return this.request("/changes/latest");
  }

  public systemStatus(refreshServices = false): Promise<SystemStatus> {
    const query = refreshServices ? "?refresh_services=true" : "";
    return this.request(`/system/status${query}`);
  }

  public syncFeeds(): Promise<FeedSyncResult[]> {
    return this.request("/feeds/sync", { method: "POST" }, 60_000);
  }

  public conversions(status?: string): Promise<ConversionRecord[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request(`/documents/conversions${query}`);
  }

  public conversion(conversionId: string): Promise<ConversionRecord> {
    return this.request(`/documents/conversions/${encodeURIComponent(conversionId)}`);
  }

  public converters(): Promise<import("../imports/types.js").ConverterCatalogue> {
    return this.request("/documents/converters");
  }

  public conversionResult(conversionId: string): Promise<{
    markdown: string; method: import("../imports/types.js").ConversionMethod;
    asset_paths: string[]; qc: { passed: boolean; warnings: string[]; errors: string[] };
  }> {
    return this.request(`/documents/conversions/${encodeURIComponent(conversionId)}/result`);
  }

  public routeImportedSource(
    path: string,
    options: {
      intent: "learn" | "wiki" | "source" | "later";
      course?: string;
      project?: string;
      generate?: boolean;
    },
  ): Promise<{
    source: string;
    source_text: string | null;
    routed_target?: string;
    semantic_operation?: SemanticOperationRecord;
  }> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return this.request(`/documents/sources/${encoded}/route`, {
      method: "POST",
      body: JSON.stringify(options),
    });
  }

  public retryConversion(
    conversionId: string,
    parser?: "mineru" | "markitdown" | import("../imports/types.js").ConversionMethod,
  ): Promise<ConversionRecord> {
    return this.request(`/documents/conversions/${encodeURIComponent(conversionId)}/retry`, {
      method: "POST",
      body: JSON.stringify(parser?.includes("-") ? { method: parser } : { parser }),
    });
  }

  public createSemanticOperation(
    kind: SemanticOperationRecord["kind"],
    target: string,
    options: {
      sources?: string[];
      instruction?: string;
    } = {},
  ): Promise<SemanticOperationRecord> {
    return this.request("/semantic/operations", {
      method: "POST",
      body: JSON.stringify({ kind, target, ...options }),
    });
  }

  public semanticOperations(status?: SemanticOperationRecord["status"]): Promise<SemanticOperationRecord[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request(`/semantic/operations${query}`);
  }

  public semanticOperation(operationId: string): Promise<SemanticOperationRecord> {
    return this.request(`/semantic/operations/${encodeURIComponent(operationId)}`);
  }

  public retrySemanticOperation(operationId: string): Promise<SemanticOperationRecord> {
    return this.request(`/semantic/operations/${encodeURIComponent(operationId)}/retry`, {
      method: "POST",
      body: "{}",
    });
  }

  public cancelSemanticOperation(operationId: string): Promise<SemanticOperationRecord> {
    return this.request(`/semantic/operations/${encodeURIComponent(operationId)}/cancel`, {
      method: "POST",
      body: "{}",
    });
  }

  public governanceReport(): Promise<GovernanceReport> {
    return this.request("/system/governance");
  }

  public async health(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}/health`);
    return response.ok;
  }

  private async request<T>(path: string, init?: RequestInit, timeout = 15_000): Promise<T> {
    return this.http.request<T>(path, init, timeout);
  }

  private httpError(status: number, detail: string): Error {
    const messages: Record<number, string> = {
      400: "操作未完成，请检查输入后重试。",
      401: "本地服务认证失败，请在连接设置中检查凭据。",
      403: "当前操作没有权限，请检查连接设置。",
      404: "内容已不存在或服务版本不匹配，请刷新后重试。",
      409: "内容或任务状态已变化，请刷新后重试。",
      422: "输入内容不符合要求，请检查后重试。",
    };
    return new Error(messages[status] ?? "本地服务处理失败，请在系统状态中检查后重试。", {
      cause: { status, detail },
    });
  }

  private transportError(error: unknown, timedOut: boolean): Error {
    if (timedOut) {
      return new Error("本地服务响应超时，请稍后重试。仍可阅读和编辑笔记，导入与生成暂不可用。", {
        cause: error,
      });
    }
    return new Error(
      "无法连接本地服务，请在系统状态中检查连接。仍可阅读和编辑笔记，导入与生成暂不可用。",
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

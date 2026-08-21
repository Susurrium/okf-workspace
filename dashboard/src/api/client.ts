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

export class LocalApi {
  public constructor(
    public readonly baseUrl: string,
    private readonly token: string,
  ) {}

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

  public createProject(title: string, slug?: string): Promise<{ path: string }> {
    return this.request("/projects", {
      method: "POST",
      body: JSON.stringify({ title, slug }),
    });
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
  ): Promise<{ created_or_updated: string; capture_archived: string }> {
    return this.request("/ai/organize", {
      method: "POST",
      body: JSON.stringify({ path, destination, ...options }),
    }, 180_000);
  }

  public discardCapture(path: string): Promise<{ capture_archived: string }> {
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
    action: "archive-processed" | "discard",
    paths: string[],
  ): Promise<{ action: string; count: number; archived: string[] }> {
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

  public syncFeeds(): Promise<unknown[]> {
    return this.request("/feeds/sync", { method: "POST" }, 60_000);
  }

  public conversions(status?: string): Promise<ConversionRecord[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request(`/documents/conversions${query}`);
  }

  public conversion(conversionId: string): Promise<ConversionRecord> {
    return this.request(`/documents/conversions/${encodeURIComponent(conversionId)}`);
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
    source_text: string;
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
    parser?: "mineru" | "markitdown",
  ): Promise<ConversionRecord> {
    return this.request(`/documents/conversions/${encodeURIComponent(conversionId)}/retry`, {
      method: "POST",
      body: JSON.stringify({ parser }),
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
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init?.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}${path}`, {
        ...init,
        headers,
        signal: init?.signal ?? AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
        throw new Error("Workspace 本地服务响应超时");
      }
      throw error;
    }
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Workspace API request failed (${response.status})`);
    }
    return (await response.json()) as T;
  }
}

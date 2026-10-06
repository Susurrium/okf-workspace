import type {
  FeedDecisionAction,
  FeedDecisionContext,
  FeedDecisionResult,
  FeedDashboardDigest,
  FeedDigest,
  FeedDigestSummary,
  FeedItem,
  FeedKind,
  FeedSubscriptionPage,
  FeedSubscriptionPageQuery,
  FeedSubscriptionConfirmRequest,
  FeedSubscriptionConfirmResult,
  FeedSubscriptionManagementPage,
  FeedSubscriptionMutationRequest,
  FeedSubscriptionMutationResult,
  FeedSubscriptionPreview,
  FeedSubscriptionPreviewRequest,
  FeedSubscriptionRemoveRequest,
  FeedSubscriptionRemoveResult,
  FeedSubscriptionSourcePage,
  FeedSubscriptionSourcePageQuery,
  FeedSubscriptionSourceItemsPage,
  FeedSubscriptionSourceItemsQuery,
} from "./types.js";
import { WorkspaceHttpClient } from "../api/http-client.js";

export interface OpenedFeedDigest {
  vault_path: string;
  markdown: string;
}

export interface PreparedFeedDigest extends OpenedFeedDigest {
  vault_fingerprint: string;
}

export interface FeedApi {
  listDigests(kind: FeedKind): Promise<FeedDigestSummary[]>;
  getDigest(kind: FeedKind, digestId: string): Promise<FeedDigest>;
  dashboardDigest(): Promise<FeedDashboardDigest>;
  listSubscriptions(query?: FeedSubscriptionPageQuery): Promise<FeedSubscriptionPage>;
  listSubscriptionSources(
    query?: FeedSubscriptionSourcePageQuery,
  ): Promise<FeedSubscriptionSourcePage>;
  listSubscriptionSourceItems(
    sourceId: string,
    query?: FeedSubscriptionSourceItemsQuery,
  ): Promise<FeedSubscriptionSourceItemsPage>;
  previewSubscription(request: FeedSubscriptionPreviewRequest): Promise<FeedSubscriptionPreview>;
  confirmSubscription(request: FeedSubscriptionConfirmRequest): Promise<FeedSubscriptionConfirmResult>;
  listManagedSubscriptions(): Promise<FeedSubscriptionManagementPage>;
  enableSubscription(
    sourceId: string,
    request: FeedSubscriptionMutationRequest,
  ): Promise<FeedSubscriptionMutationResult>;
  disableSubscription(
    sourceId: string,
    request: FeedSubscriptionMutationRequest,
  ): Promise<FeedSubscriptionMutationResult>;
  removeSubscription(
    sourceId: string,
    request: FeedSubscriptionRemoveRequest,
  ): Promise<FeedSubscriptionRemoveResult>;
  openDigest(kind: FeedKind, digestId: string): Promise<OpenedFeedDigest>;
  prepareDigest(kind: FeedKind, digestId: string): Promise<PreparedFeedDigest>;
  vaultIdentity(): Promise<{ vault_fingerprint: string }>;
  decide(
    kind: FeedKind,
    itemId: string,
    action: FeedDecisionAction,
    context?: FeedDecisionContext,
  ): Promise<FeedDecisionResult>;
  getDecision(kind: FeedKind, itemId: string): Promise<FeedDecisionResult | undefined>;
}

export class FeedTransportError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FeedTransportError";
  }
}

export class HttpFeedApi implements FeedApi {
  private readonly http: WorkspaceHttpClient;

  public constructor(
    baseUrl: string,
    token: string,
    expectedVaultFingerprint?: string,
  ) {
    this.http = new WorkspaceHttpClient({
      baseUrl,
      token,
      expectedVaultFingerprint,
      defaultTimeout: 20_000,
      onHttpError: (status, detail) => new FeedHttpError(status, detail),
      onTransportError: (error, timedOut) => new FeedTransportError(
        timedOut ? "本地服务响应超时" : "本地服务连接中断",
        { cause: error instanceof Error ? error : undefined },
      ),
    });
  }

  public listDigests(kind: FeedKind): Promise<FeedDigestSummary[]> {
    return this.request(`/feeds/${kind}/digests`);
  }

  public getDigest(kind: FeedKind, digestId: string): Promise<FeedDigest> {
    return this.request(`/feeds/${kind}/digests/${encodeURIComponent(digestId)}`);
  }

  public dashboardDigest(): Promise<FeedDashboardDigest> {
    return this.request("/dashboard/feeds/summary", undefined, 8_000);
  }

  public listSubscriptions(
    query: FeedSubscriptionPageQuery = {},
  ): Promise<FeedSubscriptionPage> {
    const parameters = new URLSearchParams();
    if (query.limit !== undefined) {
      parameters.set("limit", String(Math.max(1, Math.min(50, Math.trunc(query.limit)))));
    }
    if (query.cursor) parameters.set("cursor", query.cursor);
    if (query.source_id) parameters.set("source_id", query.source_id);
    const suffix = parameters.size ? `?${parameters.toString()}` : "";
    return this.request(`/dashboard/feeds/subscriptions${suffix}`, undefined, 8_000);
  }

  public listSubscriptionSources(
    query: FeedSubscriptionSourcePageQuery = {},
  ): Promise<FeedSubscriptionSourcePage> {
    const parameters = new URLSearchParams();
    if (query.limit !== undefined) {
      parameters.set("limit", String(Math.max(1, Math.min(8, Math.trunc(query.limit)))));
    }
    if (query.cursor) parameters.set("cursor", query.cursor);
    if (query.query?.trim()) parameters.set("query", query.query.trim());
    const suffix = parameters.size ? `?${parameters.toString()}` : "";
    return this.request(`/dashboard/feeds/subscription-sources${suffix}`, undefined, 8_000);
  }

  public listSubscriptionSourceItems(
    sourceId: string,
    query: FeedSubscriptionSourceItemsQuery = {},
  ): Promise<FeedSubscriptionSourceItemsPage> {
    const parameters = new URLSearchParams();
    if (query.limit !== undefined) {
      parameters.set("limit", String(Math.max(1, Math.min(50, Math.trunc(query.limit)))));
    }
    if (query.cursor) parameters.set("cursor", query.cursor);
    const suffix = parameters.size ? `?${parameters.toString()}` : "";
    return this.request(
      `/dashboard/feeds/subscription-sources/${encodeURIComponent(sourceId)}/latest-items${suffix}`,
      undefined,
      8_000,
    );
  }

  public previewSubscription(
    request: FeedSubscriptionPreviewRequest,
  ): Promise<FeedSubscriptionPreview> {
    return this.request("/feeds/subscriptions/preview", jsonPost(request), 30_000);
  }

  public confirmSubscription(
    request: FeedSubscriptionConfirmRequest,
  ): Promise<FeedSubscriptionConfirmResult> {
    return this.request("/feeds/subscriptions/confirm", jsonPost(request), 30_000);
  }

  public listManagedSubscriptions(): Promise<FeedSubscriptionManagementPage> {
    return this.request("/feeds/subscriptions", undefined, 15_000);
  }

  public enableSubscription(
    sourceId: string,
    request: FeedSubscriptionMutationRequest,
  ): Promise<FeedSubscriptionMutationResult> {
    return this.subscriptionMutation(sourceId, "enable", request);
  }

  public disableSubscription(
    sourceId: string,
    request: FeedSubscriptionMutationRequest,
  ): Promise<FeedSubscriptionMutationResult> {
    return this.subscriptionMutation(sourceId, "disable", request);
  }

  public removeSubscription(
    sourceId: string,
    request: FeedSubscriptionRemoveRequest,
  ): Promise<FeedSubscriptionRemoveResult> {
    return this.request(
      `/feeds/subscriptions/${encodeURIComponent(sourceId)}/remove`,
      jsonPost(request),
      30_000,
    );
  }

  public openDigest(kind: FeedKind, digestId: string): Promise<OpenedFeedDigest> {
    return this.request(`/feeds/${kind}/digests/${encodeURIComponent(digestId)}/open`, {
      method: "POST",
    });
  }

  public prepareDigest(kind: FeedKind, digestId: string): Promise<PreparedFeedDigest> {
    return this.request(`/feeds/${kind}/digests/${encodeURIComponent(digestId)}/prepare`, {
      method: "POST",
    });
  }

  public vaultIdentity(): Promise<{ vault_fingerprint: string }> {
    return this.request("/workspace/identity");
  }

  public decide(
    kind: FeedKind,
    itemId: string,
    action: FeedDecisionAction,
    context: FeedDecisionContext = {},
  ): Promise<FeedDecisionResult> {
    return this.request(
      `/feeds/${kind}/items/${encodeURIComponent(itemId)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...context }),
      },
      120_000,
    );
  }

  public async getDecision(
    kind: FeedKind,
    itemId: string,
  ): Promise<FeedDecisionResult | undefined> {
    try {
      return await this.request(
        `/feeds/${kind}/items/${encodeURIComponent(itemId)}/decision`,
      );
    } catch (error) {
      if (error instanceof FeedHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  private subscriptionMutation(
    sourceId: string,
    action: "enable" | "disable",
    request: FeedSubscriptionMutationRequest,
  ): Promise<FeedSubscriptionMutationResult> {
    return this.request(
      `/feeds/subscriptions/${encodeURIComponent(sourceId)}/${action}`,
      jsonPost(request),
      30_000,
    );
  }

  private async request<T>(path: string, init?: RequestInit, timeout = 20_000): Promise<T> {
    return this.http.request<T>(path, init, timeout);
  }
}

function jsonPost(value: object): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

export class FeedHttpError extends Error {
  public readonly code: string | undefined;
  public readonly retryable: boolean | undefined;
  public readonly publicMessage: string;

  public constructor(public readonly status: number, detail: string) {
    const structured = parseFeedApiError(detail);
    const publicMessage = structured?.message ?? detail;
    super(`Feed API ${status}: ${publicMessage}`);
    this.name = "FeedHttpError";
    this.code = structured?.code;
    this.retryable = structured?.retryable;
    this.publicMessage = publicMessage;
  }
}

interface StructuredFeedApiError {
  code?: string;
  message: string;
  retryable?: boolean;
}

function parseFeedApiError(raw: string): StructuredFeedApiError | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const detail = (value as { detail?: unknown }).detail;
  if (typeof detail === "string") return { message: detail };
  if (!detail || typeof detail !== "object") return undefined;
  const record = detail as { code?: unknown; message?: unknown; retryable?: unknown };
  if (typeof record.message !== "string" || !record.message.trim()) return undefined;
  return {
    message: record.message.trim(),
    ...(typeof record.code === "string" && record.code.trim()
      ? { code: record.code.trim() }
      : {}),
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
  };
}

export function isTreeholeItem(item: FeedItem): item is FeedItem & { pid: number } {
  return item.feed === "treehole" && item.pid !== undefined;
}

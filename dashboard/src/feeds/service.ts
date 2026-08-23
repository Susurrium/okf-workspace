import type {
  FeedDecisionAction,
  FeedDecisionResult,
  FeedDashboardDigest,
  FeedDigest,
  FeedDigestSummary,
  FeedItem,
  FeedKind,
  FeedSubscriptionPage,
  FeedSubscriptionPageQuery,
  FeedSubscriptionSourcePage,
  FeedSubscriptionSourcePageQuery,
  FeedSubscriptionSourceItemsPage,
  FeedSubscriptionSourceItemsQuery,
} from "./types.js";

export interface OpenedFeedDigest {
  vault_path: string;
  markdown: string;
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
  openDigest(kind: FeedKind, digestId: string): Promise<OpenedFeedDigest>;
  decide(
    kind: FeedKind,
    itemId: string,
    action: FeedDecisionAction,
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
  public constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

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

  public openDigest(kind: FeedKind, digestId: string): Promise<OpenedFeedDigest> {
    return this.request(`/feeds/${kind}/digests/${encodeURIComponent(digestId)}/open`, {
      method: "POST",
    });
  }

  public decide(
    kind: FeedKind,
    itemId: string,
    action: FeedDecisionAction,
  ): Promise<FeedDecisionResult> {
    return this.request(
      `/feeds/${kind}/items/${encodeURIComponent(itemId)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
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

  private async request<T>(path: string, init?: RequestInit, timeout = 20_000): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...init?.headers,
        },
        signal: init?.signal ?? AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
        throw new FeedTransportError("Workspace 本地服务响应超时", { cause: error });
      }
      throw new FeedTransportError("Workspace 本地服务连接中断", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (!response.ok) {
      throw new FeedHttpError(response.status, await response.text());
    }
    return (await response.json()) as T;
  }
}

export class FeedHttpError extends Error {
  public constructor(public readonly status: number, detail: string) {
    super(`Feed API ${status}: ${detail}`);
    this.name = "FeedHttpError";
  }
}

export function isTreeholeItem(item: FeedItem): item is FeedItem & { pid: number } {
  return item.feed === "treehole" && item.pid !== undefined;
}

import type {
  FeedSubscriptionAdapter,
  FeedSubscriptionContentMode,
  FeedSubscriptionDetectedAdapter,
  FeedSubscriptionRegistryAdapter,
  FeedSubscriptionSource,
} from "../feeds/types.js";

export const FEED_SUBSCRIPTION_FULL_CONTENT_DEFAULT = 12_000;
export const FEED_SUBSCRIPTION_CONTENT_MIN = 100;
export const FEED_SUBSCRIPTION_CONTENT_MAX = 20_000;

export type FeedSubscriptionCardState =
  | "active"
  | "waiting"
  | "disabled"
  | "error"
  | "removed";

export type FeedSubscriptionSourceWithLatest = FeedSubscriptionSource & {
  latest_digest_id: string;
  latest_issued_at: string;
};

export function feedSubscriptionCardState(
  source: Pick<
    FeedSubscriptionSource,
    "latest_digest_id" | "status" | "registry_status" | "enabled"
  >,
): FeedSubscriptionCardState {
  if (source.registry_status === "error") return "error";
  if (source.registry_status === "removed" || source.status === "removed") return "removed";
  if (
    source.registry_status === "disabled" || source.status === "disabled" ||
    source.enabled === false
  ) return "disabled";
  if (!source.latest_digest_id || source.status === "waiting") return "waiting";
  return "active";
}

export function feedSubscriptionHasLatest(
  source: FeedSubscriptionSource,
): source is FeedSubscriptionSourceWithLatest {
  return Boolean(source.latest_digest_id && source.latest_issued_at);
}

export function feedSubscriptionCardLabel(state: FeedSubscriptionCardState): string {
  return {
    active: "更新正常",
    waiting: "等待首次更新",
    disabled: "已暂停",
    error: "更新异常",
    removed: "已移除",
  }[state];
}

export function feedSubscriptionAdapterLabel(
  adapter: FeedSubscriptionAdapter | FeedSubscriptionDetectedAdapter | FeedSubscriptionRegistryAdapter,
): string {
  return {
    auto: "自动检测",
    rss: "RSS / Atom",
    github_repository: "GitHub 仓库",
    github_releases: "GitHub Releases",
    ruanyf_weekly: "阮一峰周刊（内置）",
  }[adapter];
}

export function feedSubscriptionModeLabel(mode: FeedSubscriptionContentMode): string {
  return mode === "full" ? "尽量保留全文" : "只保留摘要";
}

export function feedSubscriptionFailureLabel(errorType?: string | null): string {
  const normalized = errorType?.trim().toLocaleLowerCase("en-US") ?? "";
  if (normalized.includes("timeout")) return "读取来源超时";
  if (
    normalized.includes("network") || normalized.includes("connection") ||
    normalized.includes("http")
  ) return "暂时无法连接来源";
  if (
    normalized.includes("parse") || normalized.includes("format") ||
    normalized.includes("feed")
  ) return "未能解析来源内容";
  return "来源最近一次更新失败";
}

export function feedSubscriptionDisplayUrl(value: string, redacted: boolean): string {
  if (!redacted) return value;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "订阅地址已隐藏";
  }
}

export function normalizeFeedSubscriptionUrl(value: string): string {
  const candidate = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("请输入完整的 HTTP 或 HTTPS 订阅地址");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("订阅地址只支持 HTTP 或 HTTPS");
  }
  return candidate;
}

export function normalizeFeedSubscriptionContentMax(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (
    !Number.isInteger(parsed) || parsed < FEED_SUBSCRIPTION_CONTENT_MIN ||
    parsed > FEED_SUBSCRIPTION_CONTENT_MAX
  ) {
    throw new Error(
      `全文上限必须是 ${FEED_SUBSCRIPTION_CONTENT_MIN}–${FEED_SUBSCRIPTION_CONTENT_MAX} 之间的整数`,
    );
  }
  return parsed;
}

export function createFeedSubscriptionIdempotencyKey(
  now = Date.now(),
  random = Math.random(),
): string {
  const entropy = Math.floor(Math.max(0, Math.min(0.999999999, random)) * 0x1_0000_0000)
    .toString(36)
    .padStart(7, "0");
  return `dashboard-${now.toString(36)}-${entropy}`;
}

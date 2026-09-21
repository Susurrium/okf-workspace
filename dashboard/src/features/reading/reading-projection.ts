import type {
  AiDailyStream,
  FeedDashboardDigest,
  FeedDigestEdition,
  FeedDigestItem,
  FeedSubscriptionSource,
} from "../../feeds/types.js";

export interface ReadingStreamProjection {
  id: "hotspot" | "news" | "papers" | "treehole";
  feed: "ai-daily" | "treehole";
  title: string;
  edition?: FeedDigestEdition;
}

export function latestAiDailyEdition(
  digest: FeedDashboardDigest,
  section: AiDailyStream,
): FeedDigestEdition | undefined {
  return digest.ai_daily
    .filter((edition) => edition.section === section)
    .reduce<FeedDigestEdition | undefined>((latest, edition) =>
      !latest || edition.issued_at.localeCompare(latest.issued_at) > 0 ? edition : latest,
    undefined);
}

export function readingStreams(digest: FeedDashboardDigest): ReadingStreamProjection[] {
  return [
    { id: "hotspot", feed: "ai-daily", title: "中国热点", edition: latestAiDailyEdition(digest, "hotspot") },
    { id: "news", feed: "ai-daily", title: "AI 资讯", edition: latestAiDailyEdition(digest, "news") },
    { id: "papers", feed: "ai-daily", title: "AI Papers", edition: digest.ai_papers ?? undefined },
    { id: "treehole", feed: "treehole", title: "树洞热榜", edition: digest.treehole ?? undefined },
  ];
}

export function mergeUniqueEditions(
  current: readonly FeedDigestEdition[],
  incoming: readonly FeedDigestEdition[],
): FeedDigestEdition[] {
  const byId = new Map(current.map((edition) => [edition.digest_id, edition]));
  for (const edition of incoming) byId.set(edition.digest_id, edition);
  return [...byId.values()].sort((left, right) => right.issued_at.localeCompare(left.issued_at));
}

export function mergeUniqueSources(
  current: readonly FeedSubscriptionSource[],
  incoming: readonly FeedSubscriptionSource[],
): FeedSubscriptionSource[] {
  const byId = new Map(current.map((source) => [source.source_id, source]));
  for (const source of incoming) byId.set(source.source_id, source);
  return [...byId.values()];
}

export function feedDecisionLabel(decision: FeedDigestItem["decision"]): string {
  if (!decision) return "";
  return {
    "learn-now": "已开始学习",
    "learn-later": "待生成学习材料",
    "wiki-now": "已整理 Wiki",
    "source-only": "已保存来源",
    ignore: "已忽略",
    later: "旧版稍后处理",
  }[decision];
}

export function formatFeedDate(value: string | null | undefined): string {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (!match) return value;
  const year = Number(match[1]);
  const prefix = year === new Date().getFullYear() ? "" : `${year}年`;
  return `${prefix}${Number(match[2])}月${Number(match[3])}日`;
}

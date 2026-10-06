import type {
  AiDailyStream,
  FeedDashboardDigest,
  FeedDigestEdition,
  FeedDigestItem,
  FeedSubscriptionSource,
  FeedSyncResult,
} from "../feeds/types.js";
import { aiDailyPreviewStreamTitle } from "./ai-daily-preview.js";

export function aiDailyMetadata(item: FeedDigestItem, suppressSource = false): string {
  const parts = [
    suppressSource ? "" : item.source_name || item.source,
    item.native_section,
    item.published_at,
    item.media_count ? `${item.media_count} 个媒体` : "",
  ].filter((value): value is string => Boolean(value));
  return [...new Set(parts)].join(" · ");
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

export function mergeSubscriptionEditions(
  current: readonly FeedDigestEdition[],
  incoming: readonly FeedDigestEdition[],
): FeedDigestEdition[] {
  const merged = [...current];
  const seen = new Set(current.map((edition) => edition.digest_id));
  for (const edition of incoming) {
    if (edition.section !== "learning" || seen.has(edition.digest_id)) continue;
    seen.add(edition.digest_id);
    merged.push(edition);
  }
  return merged;
}

export function mergeSubscriptionSources(
  current: readonly FeedSubscriptionSource[],
  incoming: readonly FeedSubscriptionSource[],
): FeedSubscriptionSource[] {
  const merged = [...current];
  const seen = new Set(current.map((source) => source.source_id));
  for (const source of incoming) {
    if (!source.source_id || seen.has(source.source_id)) continue;
    seen.add(source.source_id);
    merged.push(source);
  }
  return merged;
}

export function feedDecisionLabel(
  decision: FeedDigestItem["decision"],
): string {
  if (!decision) return "";
  return {
    "learn-now": "已选择学习",
    "learn-later": "待生成学习材料",
    "wiki-now": "已选择整理为知识笔记",
    "source-only": "已保存来源",
    ignore: "已忽略",
    later: "旧版稍后处理",
  }[decision];
}

export function feedSyncFailureMessage(results: readonly FeedSyncResult[]): string {
  const failures = results.filter((result) => result.status === "error");
  if (!failures.length) return "";
  const details = failures.map((failure) => {
    const label = failure.feed === "treehole"
      ? "树洞热榜"
      : failure.section === "hotspot" || failure.section === "news" || failure.section === "learning"
        ? aiDailyPreviewStreamTitle(failure.section)
        : failure.section || "每日资讯";
    return `${label}：${failure.detail}`;
  });
  return `部分内容同步失败（其他内容已更新）：${details.join("；")}`;
}

export function formatFeedDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (!match) return value;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const prefix = year === new Date().getFullYear() ? "" : `${year}年`;
  return `${prefix}${month}月${day}日`;
}

export function treeholeMetadata(item: FeedDigestItem): string {
  const labels: Record<string, string> = {
    best_rank: "最高排名",
    peak_score: "热度",
    reply_count: "回复",
    favorite_count: "收藏",
    like_count: "点赞",
  };
  const order = ["best_rank", "peak_score", "reply_count", "favorite_count", "like_count"];
  const metrics = order
    .filter((key) => Object.prototype.hasOwnProperty.call(item.metrics, key))
    .map((key) => `${labels[key]} ${item.metrics[key]}`);
  if (item.comment_count) metrics.push(`评论 ${item.comment_count}`);
  if (item.media_count) metrics.push(`媒体 ${item.media_count}`);
  if (item.published_at) metrics.push(item.published_at);
  return metrics.join(" · ");
}

export function humanizeFeedQuality(value: string): string {
  return value
    .replace(/observation[_-]gap/giu, "本期存在观测缺口")
    .replace(/partial/giu, "部分内容缺失")
    .replace(/degraded/giu, "采集质量下降")
    .replace(/[_-]+/gu, " ")
    .trim();
}

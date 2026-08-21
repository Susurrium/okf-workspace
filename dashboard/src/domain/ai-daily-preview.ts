/**
 * Adapted from the V1 preview domain: stream order and narrow notice removal
 * remain stable, while publication seals and projection identity are gone.
 */
import type { AiDailyIssue, AiDailyStream } from "../feeds/types.js";

export const AI_DAILY_PREVIEW_STREAM_ORDER: readonly AiDailyStream[] = [
  "news",
  "hotspot",
  "learning",
];

const EDITABLE_COPY_NOTICE =
  "> 本文件是可编辑阅读副本；逐条兴趣与价值判断由 Workflow Hub 保存，不写入正文。";

export function aiDailyPreviewStreamTitle(stream: AiDailyStream): string {
  if (stream === "news") return "AI 资讯";
  if (stream === "hotspot") return "中国热点";
  return "AI 学习更新";
}

export function availableAiDailyPreviewStreams(
  issue: Pick<AiDailyIssue, "streams">,
): AiDailyStream[] {
  const available = new Set(
    issue.streams
      .filter((stream) => stream.total_count > 0)
      .map((stream) => stream.stream),
  );
  return AI_DAILY_PREVIEW_STREAM_ORDER.filter((stream) => available.has(stream));
}

export function resolveAiDailyPreviewStream(
  issue: Pick<AiDailyIssue, "streams">,
  preferred?: AiDailyStream,
): AiDailyStream | undefined {
  const available = availableAiDailyPreviewStreams(issue);
  if (preferred && available.includes(preferred)) return preferred;
  return available[0];
}

export function prepareAiDailyPreviewMarkdown(markdown: string): string {
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const noticeIndex = lines.findIndex((line) => line.trim() === EDITABLE_COPY_NOTICE);
  if (noticeIndex < 0) return markdown;
  lines.splice(noticeIndex, 1);
  if (lines[noticeIndex - 1]?.trim() === "" && lines[noticeIndex]?.trim() === "") {
    lines.splice(noticeIndex, 1);
  }
  return lines.join(newline);
}

import type { AiDailyStream } from "../feeds/types.js";

export function aiDailyPreviewStreamTitle(stream: AiDailyStream): string {
  if (stream === "news") return "AI 资讯";
  if (stream === "hotspot") return "中国热点";
  return "订阅阅读";
}

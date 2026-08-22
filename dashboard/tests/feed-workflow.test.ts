import { describe, expect, it, vi } from "vitest";

import { aiDailyPreviewStreamTitle } from "../src/domain/ai-daily-preview.js";
import { feedItemMappings } from "../src/feeds/mappings.js";
import { HttpFeedApi } from "../src/feeds/service.js";
import {
  FEED_DECISION_ACTIONS,
  feedDecisionFeedback,
} from "../src/ui/ai-daily-inline-decision.js";

describe("Dashboard Feed workflow", () => {
  it("reads canonical Digest item mappings and keeps legacy compatibility", () => {
    const canonical = [{ id: "treehole:123", block_id: "treehole-123" }];
    const legacy = [{ id: "daily:1", block_id: "feed-abcdef123456" }];

    expect(feedItemMappings({ items: canonical })).toEqual(canonical);
    expect(feedItemMappings({ feed_items: legacy })).toEqual(legacy);
    expect(feedItemMappings({ items: [{ id: "missing-block" }] })).toEqual([]);
  });

  it("uses the current AI Daily stream labels", () => {
    expect(aiDailyPreviewStreamTitle("news")).toBe("AI 资讯");
    expect(aiDailyPreviewStreamTitle("hotspot")).toBe("中国热点");
    expect(aiDailyPreviewStreamTitle("learning")).toBe("AI 学习更新");
  });

  it("offers five explicit human outcomes", () => {
    expect(FEED_DECISION_ACTIONS.map((item) => item.action)).toEqual([
      "learn-now",
      "learn-later",
      "wiki-now",
      "source-only",
      "ignore",
    ]);
  });

  it("submits one decision request and allows file-writing work enough time", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(
      () => new AbortController().signal,
    );
    const fetchMock = vi.fn(async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = new HttpFeedApi("http://127.0.0.1:8765", "token");
      await api.decide("ai-daily", "news-2", "learn-now");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([120_000]);
    } finally {
      vi.unstubAllGlobals();
      timeout.mockRestore();
    }
  });

  it("explains deferred learning and remains able to read a legacy later receipt", () => {
    expect(feedDecisionFeedback({
      item_id: "news-2",
      action: "learn-later",
      study_guide: "learning/guides/news-2.md",
    })).toEqual({
      message: "已保存来源并创建待生成的学习入口；可在 Learning 页面继续。",
      target: "learning/guides/news-2.md",
      targetLabel: "打开学习入口",
    });
    expect(feedDecisionFeedback({
      item_id: "news-2",
      action: "later",
      source: "sources/records/ai-daily/news-2.md",
    })).toEqual({
      message: "这是旧版的稍后决定记录；当时已保存 Source 并放入 Inbox，你仍可重新作出正式判断。",
      target: "sources/records/ai-daily/news-2.md",
      targetLabel: "打开旧 Source",
    });
  });
});

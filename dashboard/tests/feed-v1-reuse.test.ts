import { describe, expect, it, vi } from "vitest";

import { resolveAiDailyResumeTarget } from "../src/domain/ai-daily-navigation.js";
import {
  prepareAiDailyPreviewMarkdown,
  resolveAiDailyPreviewStream,
} from "../src/domain/ai-daily-preview.js";
import {
  expectedAiDailyReadingNotePath,
  feedBlockIdsInMarkdown,
} from "../src/domain/ai-daily-reading-note.js";
import { expectedTreeholeReadingNotePath } from "../src/domain/treehole-reading-note.js";
import { HttpFeedApi, type FeedApi, type OpenedFeedDigest } from "../src/feeds/service.js";
import type {
  AiDailyIssue,
  FeedDashboardDigest,
  FeedDecisionAction,
  FeedDecisionResult,
  FeedDigest,
  FeedDigestSummary,
  TreeholeBatchPreview,
} from "../src/feeds/types.js";
import { AiDailyDecisionController } from "../src/services/ai-daily-decision-controller.js";
import {
  FEED_DECISION_ACTIONS,
  feedDecisionFeedback,
} from "../src/ui/ai-daily-inline-decision.js";
import { AiDailyPreviewPage } from "../src/ui/ai-daily-preview-page.js";
import { scanAiDailyLivePreview } from "../src/ui/ai-daily-live-preview.js";
import { TreeholePreviewPage } from "../src/ui/treehole-preview-page.js";

const issue: AiDailyIssue = {
  issue_date: "2026-08-17",
  title: "AI Daily",
  reading_positions: {
    news: { artifact_id: "news-2", updated_at: "2026-08-17T10:00:00Z" },
    hotspot: { artifact_id: "hot-1", updated_at: "2026-08-17T09:00:00Z" },
  },
  streams: [
    {
      stream: "hotspot",
      label: "热点",
      total_count: 1,
      items: [
        {
          item_id: "hot-1",
          feed: "ai-daily",
          digest_id: "2026-08-17-hotspot",
          title: "热点",
          body: "正文",
          metrics: {},
          comments: [],
          media: [],
        },
      ],
    },
    {
      stream: "news",
      label: "资讯",
      total_count: 1,
      items: [
        {
          item_id: "news-2",
          feed: "ai-daily",
          digest_id: "2026-08-17-news",
          title: "资讯",
          body: "完整 Markdown",
          metrics: {},
          comments: [],
          media: [],
        },
      ],
    },
  ],
};

class RecordingFeedApi implements FeedApi {
  public calls: [string, string, FeedDecisionAction][] = [];

  public async listDigests(): Promise<FeedDigestSummary[]> {
    return [];
  }

  public async getDigest(): Promise<FeedDigest> {
    throw new Error("unused");
  }

  public async dashboardDigest(): Promise<FeedDashboardDigest> {
    return { ai_daily: [], treehole: null };
  }

  public async openDigest(): Promise<OpenedFeedDigest> {
    return { vault_path: "feeds/ai-daily/2026/2026-08-17-news.md", markdown: "# 完整" };
  }

  public async decide(
    kind: "ai-daily" | "treehole",
    itemId: string,
    action: FeedDecisionAction,
  ): Promise<FeedDecisionResult> {
    this.calls.push([kind, itemId, action]);
    return { item_id: itemId, action };
  }

  public async getDecision(): Promise<FeedDecisionResult | undefined> {
    return undefined;
  }
}

describe("V1 AI Daily behavior adapted to OKF feeds", () => {
  it("keeps stream fallback, resume, complete markdown, and keyboard navigation", async () => {
    expect(resolveAiDailyPreviewStream(issue, "learning")).toBe("news");
    expect(resolveAiDailyResumeTarget(issue, "hotspot")).toEqual({
      stream: "news",
      artifactId: "news-2",
    });
    const page = new AiDailyPreviewPage({
      issues: [issue],
      initialStream: "hotspot",
      loadMarkdown: async (_date, stream) => `# ${stream}\n\n完整 Markdown`,
      openInObsidian: async () => ({
        vault_path: expectedAiDailyReadingNotePath("2026-08-17", "news"),
        markdown: "# news",
      }),
    });

    await page.refresh();
    expect(page.preview.state()).toMatchObject({ status: "ready", markdown: expect.stringContaining("完整") });
    await page.moveStream("ArrowRight");
    expect(page.selection().stream).toBe("news");
    expect(expectedAiDailyReadingNotePath("2026-08-17", "news")).toBe(
      "feeds/ai-daily/2026/2026-08-17-news.md",
    );
  });

  it("removes only V1's generator notice and finds stable block IDs", () => {
    const markdown =
      "# 标题\n\n> 合法引用\n\n" +
      "> 本文件是可编辑阅读副本；逐条兴趣与价值判断由 Workflow Hub 保存，不写入正文。\n\n" +
      "正文\n^feed-012345abcdef\n";
    const prepared = prepareAiDailyPreviewMarkdown(markdown);
    expect(prepared).toContain("> 合法引用");
    expect(prepared).not.toContain("Workflow Hub");
    expect(feedBlockIdsInMarkdown(prepared)).toEqual(["feed-012345abcdef"]);
    expect(scanAiDailyLivePreview(prepared)).toEqual([
      { blockId: "feed-012345abcdef", line: 6 },
    ]);
  });

  it("uses six explicit human outcomes and exactly one decision API call", async () => {
    expect(FEED_DECISION_ACTIONS.map((item) => item.action)).toEqual([
      "learn-now",
      "learn-later",
      "wiki-now",
      "source-only",
      "ignore",
      "later",
    ]);
    const api = new RecordingFeedApi();
    const controller = new AiDailyDecisionController(api);
    await controller.decide({ item_id: "news-2" }, "learn-now");
    expect(api.calls).toEqual([["ai-daily", "news-2", "learn-now"]]);
  });

  it("allows file-writing decisions enough time without an AI recommendation round-trip", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(
      () => new AbortController().signal,
    );
    vi.stubGlobal("fetch", async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    try {
      const api = new HttpFeedApi("http://127.0.0.1:8765", "token");
      await api.decide("ai-daily", "news-2", "learn-now");
      expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([120_000]);
    } finally {
      vi.unstubAllGlobals();
      timeout.mockRestore();
    }
  });

  it("explains deferred choices and exposes the created learning entry", () => {
    expect(feedDecisionFeedback({
      item_id: "news-2",
      action: "learn-later",
      study_guide: "learning/guides/news-2.md",
    })).toEqual({
      message: "已保存来源并创建待生成的学习入口；可在 Learning 页面继续。",
      target: "learning/guides/news-2.md",
      targetLabel: "打开学习入口",
    });
    expect(feedDecisionFeedback({ item_id: "news-2", action: "later" }).message).toContain(
      "没有创建 Source",
    );
  });
});

describe("V1 TreeHole behavior adapted to OKF feeds", () => {
  it("keeps snapshot, PID, metrics, media, and folded comments", () => {
    const batch: TreeholeBatchPreview = {
      digest_id: "snapshot-1700",
      feed: "treehole",
      issued_at: "2026-08-17",
      title: "树洞热榜",
      items: [
        {
          item_id: "treehole:123",
          feed: "treehole",
          digest_id: "snapshot-1700",
          title: "TreeHole #123",
          body: "洞正文",
          pid: 123,
          metrics: { reply_count: 8, peak_score: 12.5 },
          media: ["assets/123.jpg"],
          comments: [{
            text: "评论一",
            cid: 101,
            author: "Alice",
            is_original_poster: false,
            media: [],
          }],
        },
      ],
    };
    const page = new TreeholePreviewPage({
      batches: [batch],
      openInObsidian: async () => ({
        vault_path: "feeds/treehole/2026/snapshot-1700.md",
        markdown: "# TreeHole",
      }),
    });
    expect(page.cards()[0]).toMatchObject({
      pid: 123,
      body: "洞正文",
      metrics: { reply_count: 8 },
      media: ["assets/123.jpg"],
      comments: [{
        text: "评论一",
        cid: 101,
        author: "Alice",
        is_original_poster: false,
        media: [],
      }],
      commentsFolded: true,
    });
    expect(expectedTreeholeReadingNotePath("2026-08-17", "snapshot-1700")).toBe(
      "feeds/treehole/2026/snapshot-1700.md",
    );
  });
});

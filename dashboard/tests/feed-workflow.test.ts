import { describe, expect, it, vi } from "vitest";

import { aiDailyPreviewStreamTitle } from "../src/domain/ai-daily-preview.js";
import { evictUnresolvedFeedDecisions } from "../src/feeds/decision-cache.js";
import { feedItemMappings } from "../src/feeds/mappings.js";
import { FeedHttpError, HttpFeedApi } from "../src/feeds/service.js";
import {
  FEED_DECISION_ACTIONS,
  feedDecisionFeedback,
} from "../src/ui/ai-daily-inline-decision.js";

describe("Dashboard Feed workflow", () => {
  it.each([
    ["queued", "排队"], ["running", "正在生成"], ["failed", "失败"],
    ["cancelled", "取消"], ["orphaned", "中断"], ["completed", "已生成"],
  ] as const)("reports %s generation without claiming learning completion", (status, label) => {
    for (const action of ["learn-now", "wiki-now"] as const) {
      const feedback = feedDecisionFeedback({ item_id: "a", action,
        semantic_operation: { operation_id: "op", status } });
      expect(feedback.message).toContain(label);
      expect(feedback.message).not.toContain("已开始学习");
      if (status !== "running") expect(feedback.message).not.toContain("正在生成");
    }
  });

  it("does not claim generation started without a task receipt", () => {
    expect(feedDecisionFeedback({ item_id: "a", action: "learn-now" }).message)
      .toContain("未确认");
  });

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
    expect(aiDailyPreviewStreamTitle("learning")).toBe("订阅阅读");
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = new HttpFeedApi("http://127.0.0.1:8765", "token");
      await api.decide("ai-daily", "news-2", "learn-now", { project: "demo" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        action: "learn-now",
        project: "demo",
      });
      expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([120_000]);
    } finally {
      vi.unstubAllGlobals();
      timeout.mockRestore();
    }
  });

  it("loads subscription editions with bounded opaque-cursor pagination", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        section: "learning",
        editions: [],
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = new HttpFeedApi("http://127.0.0.1:8765", "token");
      await api.listSubscriptions({
        limit: 4,
        cursor: "opaque+/=",
        source_id: "source/中文",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "http://127.0.0.1:8765/dashboard/feeds/subscriptions?limit=4&cursor=opaque%2B%2F%3D&source_id=source%2F%E4%B8%AD%E6%96%87",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clamps source cards to the Engine limit and encodes search and cursor", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        section: "learning",
        sources: [],
        total_sources: 0,
        matched_sources: 0,
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = new HttpFeedApi("http://127.0.0.1:8765", "token");
      await api.listSubscriptionSources({ limit: 50, cursor: "next+/=", query: "GitHub 周刊" });

      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "http://127.0.0.1:8765/dashboard/feeds/subscription-sources?limit=8&cursor=next%2B%2F%3D&query=GitHub+%E5%91%A8%E5%88%8A",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("encodes one source and clamps its latest-item page", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        source_id: "source/中文",
        digest_id: "learning-1",
        issued_at: "2026-08-23",
        item_count: 0,
        items: [],
        next_cursor: null,
        has_more: false,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = new HttpFeedApi("http://127.0.0.1:8765", "token");
      await api.listSubscriptionSourceItems("source/中文", {
        limit: 99,
        cursor: "opaque+/=",
      });

      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "http://127.0.0.1:8765/dashboard/feeds/subscription-sources/source%2F%E4%B8%AD%E6%96%87/latest-items?limit=50&cursor=opaque%2B%2F%3D",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the subscription-management contract and preserves CAS request bodies", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = new HttpFeedApi("http://127.0.0.1:8765/", "token");
      await api.previewSubscription({
        url: "https://example.com/feed.xml",
        name: "示例订阅",
        adapter: "auto",
      });
      await api.confirmSubscription({
        preview_id: "preview-1",
        expected_registry_revision: "revision-1",
        idempotency_key: "confirm-1",
        include_existing: true,
        content_mode: "full",
        content_max_chars: 12_000,
      });
      await api.listManagedSubscriptions();
      await api.enableSubscription("source/中文", {
        expected_registry_revision: "revision-2",
        idempotency_key: "enable-1",
      });
      await api.disableSubscription("source/中文", {
        expected_registry_revision: "revision-3",
        idempotency_key: "disable-1",
      });
      await api.removeSubscription("source/中文", {
        expected_registry_revision: "revision-4",
        idempotency_key: "remove-1",
        confirm: true,
      });

      expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
        "http://127.0.0.1:8765/feeds/subscriptions/preview",
        "http://127.0.0.1:8765/feeds/subscriptions/confirm",
        "http://127.0.0.1:8765/feeds/subscriptions",
        "http://127.0.0.1:8765/feeds/subscriptions/source%2F%E4%B8%AD%E6%96%87/enable",
        "http://127.0.0.1:8765/feeds/subscriptions/source%2F%E4%B8%AD%E6%96%87/disable",
        "http://127.0.0.1:8765/feeds/subscriptions/source%2F%E4%B8%AD%E6%96%87/remove",
      ]);
      expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
        "POST",
        "POST",
        undefined,
        "POST",
        "POST",
        "POST",
      ]);
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        preview_id: "preview-1",
        expected_registry_revision: "revision-1",
        idempotency_key: "confirm-1",
        include_existing: true,
        content_mode: "full",
        content_max_chars: 12_000,
      });
      expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toEqual({
        expected_registry_revision: "revision-4",
        idempotency_key: "remove-1",
        confirm: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("parses structured subscription failures instead of surfacing raw JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      detail: {
        code: "unsafe_url",
        message: "订阅地址不安全",
        retryable: false,
      },
    }), { status: 400, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const api = new HttpFeedApi("http://127.0.0.1:8765", "token");
      const error = await api.previewSubscription({
        url: "http://127.0.0.1/private",
        adapter: "auto",
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FeedHttpError);
      expect(error).toMatchObject({
        status: 400,
        code: "unsafe_url",
        retryable: false,
        publicMessage: "订阅地址不安全",
      });
      expect((error as Error).message).toBe("Feed API 400: 订阅地址不安全");
      expect((error as Error).message).not.toContain("{\"detail\"");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps durable Feed decisions when a synchronization refreshes edition data", () => {
    const decision = {
      item_id: "learning-old:1",
      action: "wiki-now" as const,
      source: "sources/records/ai-daily/learning-old-1.md",
    };
    const cache = new Map([
      ["ai-daily:learning-old:1", decision],
      ["ai-daily:unknown", undefined],
    ]);

    evictUnresolvedFeedDecisions(cache);

    expect(cache.get("ai-daily:learning-old:1")).toBe(decision);
    expect(cache.has("ai-daily:unknown")).toBe(false);
  });

  it("explains deferred learning and remains able to read a legacy later receipt", () => {
    expect(feedDecisionFeedback({
      item_id: "news-2",
      action: "learn-later",
      study_guide: "learning/guides/news-2.md",
    })).toEqual({
      message: "资料已保存到待学习列表；可在学习页生成辅助学习材料。",
      target: "learning/guides/news-2.md",
      targetLabel: "打开学习笔记",
    });
    expect(feedDecisionFeedback({
      item_id: "news-2",
      action: "later",
      source: "sources/records/ai-daily/news-2.md",
    })).toEqual({
      message: "此前选择了稍后处理，已保存的资料仍可打开。你可以重新选择用途。",
      target: "sources/records/ai-daily/news-2.md",
      targetLabel: "打开旧资料",
    });
  });
});

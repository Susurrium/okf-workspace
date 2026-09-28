import { describe, expect, it, vi } from "vitest";

import type {
  FeedDashboardDigest,
  FeedDigestEdition,
  FeedSubscriptionPage,
  FeedSubscriptionSourcePage,
  FeedSubscriptionSource,
} from "../src/feeds/types.js";
import {
  feedDecisionLabel,
  latestAiDailyEdition,
  mergeUniqueEditions,
  mergeUniqueSources,
  readingStreams,
} from "../src/features/reading/reading-projection.js";
import { createReadingSectionDefinition, type ReadingSectionHost } from "../src/features/reading/reading-section.js";
import { TestElement } from "./obsidian-runtime.js";

function edition(id: string, section: "hotspot" | "news" | "learning" | "papers", issuedAt: string): FeedDigestEdition {
  return {
    digest_id: id,
    issued_at: issuedAt,
    title: id,
    section,
    item_count: 0,
    items: [],
  };
}

function source(id: string, name = id): FeedSubscriptionSource {
  return {
    source_id: id,
    source_name: name,
    latest_issued_at: null,
    latest_digest_id: null,
    latest_item_count: 0,
    pending_decision_count: 0,
    edition_count: 0,
    native_section_counts: {},
    preview_items: [],
  };
}

describe("Reading section projections", () => {
  it("selects the newest edition per daily stream without folding learning subscriptions into news", () => {
    const digest: FeedDashboardDigest = {
      ai_daily: [
        edition("hot-old", "hotspot", "2026-09-19"),
        edition("learning", "learning", "2026-09-21"),
        edition("hot-new", "hotspot", "2026-09-20"),
        edition("news", "news", "2026-09-18"),
      ],
      ai_papers: edition("papers", "papers", "2026-09-17"),
      treehole: null,
    };

    expect(latestAiDailyEdition(digest, "hotspot")?.digest_id).toBe("hot-new");
    expect(readingStreams(digest).map((stream) => [stream.id, stream.edition?.digest_id])).toEqual([
      ["hotspot", "hot-new"],
      ["news", "news"],
      ["papers", "papers"],
      ["treehole", undefined],
    ]);
  });

  it("merges pagination by stable source and digest identity", () => {
    expect(
      mergeUniqueSources([source("one", "old")], [source("one", "new"), source("two")])
        .map((item) => [item.source_id, item.source_name]),
    ).toEqual([["one", "new"], ["two", "two"]]);

    expect(mergeUniqueEditions(
      [edition("older", "learning", "2026-09-18")],
      [edition("newer", "learning", "2026-09-20"), edition("older", "learning", "2026-09-19")],
    ).map((item) => [item.digest_id, item.issued_at])).toEqual([
      ["newer", "2026-09-20"],
      ["older", "2026-09-19"],
    ]);
  });

  it("shows persisted decision receipts consistently", () => {
    expect(feedDecisionLabel("learn-now")).toBe("已选择学习");
    expect(feedDecisionLabel("source-only")).toBe("已保存来源");
    expect(feedDecisionLabel(undefined)).toBe("");
  });
});

describe("Reading section subscription pagination", () => {
  it("loads source and edition cursor pages from the visible controls without duplicating sources", async () => {
    const sourcePages: FeedSubscriptionSourcePage[] = [
      {
        section: "learning",
        sources: Array.from({ length: 8 }, (_, index) => source(`source-${index + 1}`)),
        total_sources: 10,
        matched_sources: 10,
        next_cursor: "sources-page-2",
        has_more: true,
      },
      {
        section: "learning",
        sources: [source("source-8", "updated source 8"), source("source-9"), source("source-10")],
        total_sources: 10,
        matched_sources: 10,
        next_cursor: null,
        has_more: false,
      },
    ];
    const editionPages: FeedSubscriptionPage[] = [
      {
        section: "learning",
        source_id: "source-1",
        editions: Array.from({ length: 4 }, (_, index) =>
          edition(`edition-${index + 1}`, "learning", `2026-09-${String(20 - index).padStart(2, "0")}`),
        ),
        next_cursor: "editions-page-2",
        has_more: true,
      },
      {
        section: "learning",
        source_id: "source-1",
        editions: [
          edition("edition-4", "learning", "2026-09-15"),
          edition("edition-5", "learning", "2026-09-15"),
          edition("edition-6", "learning", "2026-09-14"),
        ],
        next_cursor: null,
        has_more: false,
      },
    ];
    const loadSources = vi.fn(async (query?: { cursor?: string }) =>
      sourcePages[query?.cursor ? 1 : 0]!,
    );
    const loadEditions = vi.fn(async (query?: { cursor?: string }) =>
      editionPages[query?.cursor ? 1 : 0]!,
    );
    const host: ReadingSectionHost = {
      feedDashboardDigestSnapshot: () => undefined,
      loadFeedDashboardDigest: async () => ({ ai_daily: [], ai_papers: null, treehole: null }),
      loadFeedSubscriptionSources: loadSources,
      loadFeedSubscriptions: loadEditions,
      syncFeedsNow: async () => [],
      promptAddFeedSubscription: () => undefined,
      promptFeedSubscriptionSettings: () => undefined,
      openFeedDigest: async () => undefined,
      openFeedItem: async () => undefined,
      feedReadingPosition: () => undefined,
      rememberFeedReadingPosition: async () => undefined,
      feedDecisionSnapshot: () => undefined,
    };
    const container = new TestElement();
    const definition = createReadingSectionDefinition(host);

    definition.render({ container: container as unknown as HTMLElement } as never);
    await vi.waitFor(() => expect(container.descendants("okf-reading-source-card")).toHaveLength(8));
    expect(container.descendants().some((element) => element.textContent === "加载更多来源")).toBe(true);

    container.descendants().find((element) => element.textContent === "加载更多来源")!.click();
    await vi.waitFor(() => expect(container.descendants("okf-reading-source-card")).toHaveLength(10));
    expect(loadSources.mock.calls.map(([query]) => query)).toEqual([
      { limit: 8 },
      { limit: 8, cursor: "sources-page-2" },
    ]);
    const sourceCards = container.descendants("okf-reading-source-card");
    expect(sourceCards.filter((card) =>
      card.descendants().some((item) =>
        item.textContent === "source-8" || item.textContent === "updated source 8",
      ),
    )).toHaveLength(1);
    expect(sourceCards[7]?.descendants().some((item) => item.textContent === "updated source 8")).toBe(true);

    sourceCards[0]!.descendants().find((element) => element.textContent === "查看来源与历史")!.click();
    await vi.waitFor(() => expect(container.descendants("okf-feed-digest__edition")).toHaveLength(4));
    expect(container.descendants().some((element) => element.textContent === "加载更早内容")).toBe(true);
    container.descendants().find((element) => element.textContent === "加载更早内容")!.click();
    await vi.waitFor(() => expect(container.descendants("okf-feed-digest__edition")).toHaveLength(6));
    expect(container.descendants().some((element) => element.textContent === "加载更早内容")).toBe(false);
    expect(loadEditions.mock.calls.map(([query]) => query)).toEqual([
      { limit: 4, source_id: "source-1" },
      { limit: 4, source_id: "source-1", cursor: "editions-page-2" },
    ]);
  });
});

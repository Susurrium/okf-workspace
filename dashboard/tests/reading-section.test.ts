import { describe, expect, it } from "vitest";

import type {
  FeedDashboardDigest,
  FeedDigestEdition,
  FeedSubscriptionSource,
} from "../src/feeds/types.js";
import {
  feedDecisionLabel,
  latestAiDailyEdition,
  mergeUniqueEditions,
  mergeUniqueSources,
  readingStreams,
} from "../src/features/reading/reading-projection.js";

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

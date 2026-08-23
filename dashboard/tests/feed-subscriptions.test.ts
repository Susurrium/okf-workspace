import { describe, expect, it } from "vitest";

import {
  createFeedSubscriptionIdempotencyKey,
  feedSubscriptionAdapterLabel,
  feedSubscriptionCardState,
  feedSubscriptionDisplayUrl,
  feedSubscriptionFailureLabel,
  normalizeFeedSubscriptionContentMax,
  normalizeFeedSubscriptionUrl,
} from "../src/domain/feed-subscriptions.js";

describe("Feed subscription domain", () => {
  it("derives Reading card state without confusing configuration and content state", () => {
    expect(feedSubscriptionCardState({
      latest_digest_id: "digest-1",
      registry_status: "error",
      status: "active",
      enabled: true,
    })).toBe("error");
    expect(feedSubscriptionCardState({
      latest_digest_id: "digest-1",
      registry_status: "removed",
      status: "active",
      enabled: true,
    })).toBe("removed");
    expect(feedSubscriptionCardState({
      latest_digest_id: "digest-1",
      registry_status: "disabled",
      status: "active",
      enabled: false,
    })).toBe("disabled");
    expect(feedSubscriptionCardState({
      latest_digest_id: null,
      registry_status: "enabled",
      status: "waiting",
      enabled: true,
    })).toBe("waiting");
    expect(feedSubscriptionCardState({
      latest_digest_id: "digest-1",
      registry_status: "enabled",
      status: "active",
      enabled: true,
    })).toBe("active");
  });

  it("accepts only complete HTTP(S) subscription URLs", () => {
    expect(normalizeFeedSubscriptionUrl(" https://example.com/feed.xml "))
      .toBe("https://example.com/feed.xml");
    expect(normalizeFeedSubscriptionUrl("http://example.com/rss"))
      .toBe("http://example.com/rss");
    expect(() => normalizeFeedSubscriptionUrl("example.com/feed.xml")).toThrow("完整");
    expect(() => normalizeFeedSubscriptionUrl("file:///feed.xml")).toThrow("HTTP");
  });

  it("enforces the documented full-content limits including an empty field", () => {
    expect(normalizeFeedSubscriptionContentMax("100")).toBe(100);
    expect(normalizeFeedSubscriptionContentMax(20_000)).toBe(20_000);
    expect(() => normalizeFeedSubscriptionContentMax(99)).toThrow("100–20000");
    expect(() => normalizeFeedSubscriptionContentMax(20_001)).toThrow("100–20000");
    expect(() => normalizeFeedSubscriptionContentMax("")).toThrow("100–20000");
    expect(() => normalizeFeedSubscriptionContentMax("12000 chars")).toThrow("100–20000");
  });

  it("uses human labels instead of rendering adapter identifiers as Markdown-like text", () => {
    expect(feedSubscriptionAdapterLabel("github_repository")).toBe("GitHub 仓库");
    expect(feedSubscriptionAdapterLabel("github_releases")).toBe("GitHub Releases");
    expect(feedSubscriptionAdapterLabel("ruanyf_weekly")).toBe("阮一峰周刊（内置）");
    expect(feedSubscriptionAdapterLabel("github_repository")).not.toContain("_");
  });

  it("turns safe error classes into useful labels without exposing internal details", () => {
    expect(feedSubscriptionFailureLabel("TimeoutError")).toBe("读取来源超时");
    expect(feedSubscriptionFailureLabel("HTTPStatusError")).toBe("暂时无法连接来源");
    expect(feedSubscriptionFailureLabel("ParserError")).toBe("未能解析来源内容");
    expect(feedSubscriptionFailureLabel("UnexpectedPrivateFailure"))
      .toBe("来源最近一次更新失败");
  });

  it("defensively strips private URL components from display-only projections", () => {
    expect(feedSubscriptionDisplayUrl(
      "https://reader:secret@example.com/feed.xml?token=private#fragment",
      true,
    )).toBe("https://example.com/feed.xml");
    expect(feedSubscriptionDisplayUrl("https://example.com/public?edition=1", false))
      .toBe("https://example.com/public?edition=1");
    expect(feedSubscriptionDisplayUrl("not-a-url?token=private", true))
      .toBe("订阅地址已隐藏");
  });

  it("creates stable-shape, distinct idempotency keys", () => {
    expect(createFeedSubscriptionIdempotencyKey(1_000, 0.25))
      .toBe(createFeedSubscriptionIdempotencyKey(1_000, 0.25));
    expect(createFeedSubscriptionIdempotencyKey(1_000, 0.25))
      .not.toBe(createFeedSubscriptionIdempotencyKey(1_000, 0.5));
    expect(createFeedSubscriptionIdempotencyKey(1_000, 0.25)).toMatch(/^dashboard-/u);
  });
});

import { TFile, WorkspaceLeaf, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  OkfDashboardView,
  OKF_DASHBOARD_VIEW,
  PROJECT_ACTION_PANEL_LABELS,
  feedDecisionLabel,
  feedSyncFailureMessage,
  latestAiDailyEdition,
  mergeSubscriptionEditions,
  mergeSubscriptionSources,
  projectStatusActions,
  resolveDashboardLearningSources,
  systemStatusLabel,
  treeholeMetadata,
} from "../src/plugin/dashboard-view.js";
import type { NoteSummary, ProjectSummary, SemanticOperationRecord } from "../src/api/types.js";
import type {
  AiDailyStream,
  FeedDigestEdition,
  FeedSubscriptionPage,
  FeedSubscriptionSource,
  FeedSubscriptionSourcePage,
} from "../src/feeds/types.js";
import { normalizeDashboardUiState } from "../src/plugin/dashboard-ui-state.js";
import type { AnchoredActionPanelOptions } from "../src/ui/anchored-action-panel.js";
import { Notice, TestElement } from "./obsidian-runtime.js";

function note(overrides: Partial<NoteSummary>): NoteSummary {
  return {
    path: "learning/guides/example.md",
    title: "示例学习材料",
    note_type: "Study Guide",
    status: "draft",
    stale: false,
    excerpt: "",
    ...overrides,
  };
}

function project(status: "active" | "paused" | "completed" = "active"): ProjectSummary {
  return {
    ...note({
      path: "projects/workspace/project.md",
      title: "个人知识工作区",
      note_type: "Project",
      status: "stable",
      project_status: status,
    }),
    current_state: "正在验收",
    next_action: "完成导入验收",
    recent_log: "",
    log_path: "projects/workspace/log.md",
    decisions: [],
    outputs: [],
    related_learning: [],
    related_materials: [],
    pending_captures: [],
  };
}

function operation(
  stage: NonNullable<SemanticOperationRecord["stage"]>,
  status: SemanticOperationRecord["status"] = "running",
): SemanticOperationRecord {
  return {
    operation_id: `op-${stage ?? status}`,
    kind: "generate-study-guide",
    status,
    stage,
    target: "learning/guides/example.md",
    sources: [],
    actual_reads: [],
    updated_at: "2026-08-22T00:00:00Z",
  };
}

function feedEdition(
  section: AiDailyStream,
  digestId: string,
  issuedAt: string,
): FeedDigestEdition {
  return {
    digest_id: digestId,
    issued_at: issuedAt,
    title: digestId,
    section,
    item_count: 1,
    items: [{
      item_id: `${digestId}:1`,
      block_id: `${digestId}-1`,
      title: `条目 ${digestId}`,
      summary: "摘要",
      source: "example.com",
      metrics: {},
      comment_count: 0,
      media_count: 0,
    }],
  };
}

function subscriptionSource(
  sourceId: string,
  sourceName: string,
  digestId: string,
  previewCount = 1,
): FeedSubscriptionSource {
  const preview = Array.from({ length: previewCount }, (_value, index) => ({
    item_id: `${digestId}:${index + 1}`,
    block_id: `${digestId}-${index + 1}`,
    title: `条目 ${sourceName} ${index + 1}`,
    summary: "摘要",
    source: sourceName,
    source_id: sourceId,
    source_name: sourceName,
    native_section: index % 2 ? "文章" : "工具",
    metrics: {},
    comment_count: 0,
    media_count: 0,
  }));
  return {
    source_id: sourceId,
    source_name: sourceName,
    latest_issued_at: "2026-08-23",
    latest_digest_id: digestId,
    latest_item_count: previewCount,
    pending_decision_count: previewCount,
    edition_count: 3,
    native_section_counts: { 工具: Math.ceil(previewCount / 2), 文章: Math.floor(previewCount / 2) },
    preview_items: preview,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("real Dashboard View source handoff", () => {
  it("constructs the registered runtime View rather than a legacy page model", () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
    } as never);

    expect(view.getViewType()).toBe(OKF_DASHBOARD_VIEW);
    expect(view.getDisplayText()).toBe("Dashboard");
  });

  it("renders Reading in the real navigation and reuses Feed items with cursor pagination", async () => {
    const openFeedItem = vi.fn(async () => undefined);
    const state = normalizeDashboardUiState({ activeSection: "reading" });
    let projectionVersion = 0;
    let firstPageVersion = 0;
    const decisions = new Map<string, { action: "wiki-now" }>();
    const firstPages = [
      [
        feedEdition("learning", "learning-3", "2026-08-23"),
        feedEdition("learning", "learning-2", "2026-08-22"),
      ],
      [
        feedEdition("learning", "learning-4", "2026-08-24"),
        feedEdition("learning", "learning-3", "2026-08-23"),
      ],
      [
        feedEdition("learning", "learning-5", "2026-08-25"),
        feedEdition("learning", "learning-4", "2026-08-24"),
      ],
    ];
    const loadFeedSubscriptions = vi.fn(async (
      query: { limit?: number; cursor?: string; source_id?: string } = {},
    ) => {
      if (query.cursor === "older-cursor") {
        return {
          section: "learning" as const,
          editions: [
            feedEdition("learning", "learning-2", "2026-08-22"),
            feedEdition("learning", "learning-1", "2026-08-21"),
          ],
          next_cursor: null,
          has_more: false,
        };
      }
      return {
        section: "learning" as const,
        editions: firstPages[firstPageVersion] ?? [],
        next_cursor: "older-cursor",
        has_more: true,
      };
    });
    const source = subscriptionSource("source-a", "阮一峰周刊", "learning-3", 5);
    source.quality = "partial";
    source.quality_reason = "partial";
    source.native_section_counts = { 工具: 3, 文章: 2, 资源: 2, 教程: 1, 其他: 1 };
    const loadFeedSubscriptionSources = vi.fn(async () => ({
      section: "learning" as const,
      sources: [{
        ...source,
        pending_decision_count: Math.max(0, 5 - projectionVersion),
      }],
      total_sources: 10,
      matched_sources: 10,
      next_cursor: null,
      has_more: false,
    }));
    const plugin = {
      getDashboardUiState: () => state,
      semanticOperationsSnapshot: () => [],
      conversionSnapshot: () => [],
      loadFeedSubscriptions,
      loadFeedSubscriptionSources,
      feedProjectionVersion: () => projectionVersion,
      feedDecisionSnapshot: (_feed: string, itemId: string) => decisions.get(itemId),
      feedReadingPosition: () => undefined,
      openFeedItem,
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      openFeedDigest: vi.fn(async () => undefined),
      ensureLocalServiceAvailable: vi.fn(async () => undefined),
      updateDashboardFeedUiState: () => undefined,
      updateDashboardPageUiState: () => undefined,
    };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, plugin as never);
    const runtime = view as unknown as {
      render: () => Promise<void>;
      subscriptionLoadedAt: number;
    };
    const root = view.contentEl as unknown as TestElement;
    const itemTitles = (): string[] => root.descendants("okf-feed-digest__item")
      .map((card) => card.children.find((child) => child.tagName === "h5")?.textContent ?? "");

    await runtime.render();

    const nav = root.descendants("okf-dashboard__nav")[0];
    expect(nav?.children.map((child) => child.textContent)).toEqual([
      "Today",
      "Inbox",
      "Reading",
      "Learning",
      "Projects",
      "Knowledge",
      "Life",
    ]);
    expect(loadFeedSubscriptionSources).toHaveBeenNthCalledWith(1, { limit: 8 });
    expect(root.descendants("okf-reading-source-card")).toHaveLength(1);
    expect(root.descendants("okf-feed-card")).toHaveLength(1);
    expect(root.descendants("okf-feed-card__body")).toHaveLength(1);
    expect(root.descendants("okf-feed-card__footer")).toHaveLength(1);
    expect(root.descendants("okf-reading-source-search")).toHaveLength(1);
    expect(root.descendants("okf-reading-source-card__sections")[0]?.children.map((item) => item.textContent))
      .toEqual(["工具 3", "文章 2", "资源 2", "其他 2 类"]);
    expect(root.descendants("okf-feed-digest__item")).toHaveLength(3);
    expect(root.descendants("okf-dashboard__feed-warning")[0]?.textContent)
      .toBe("采集不完整：部分内容缺失");
    expect(root.descendants("okf-feed-digest__item").every((item) => item.hasClass("is-compact"))).toBe(true);
    const firstPreviewMetadata = root.descendants("okf-feed-digest__item")[0]?.children
      .find((item) => item.hasClass("okf-dashboard__muted"))?.textContent;
    expect(firstPreviewMetadata).toBe("工具");

    root.descendants("okf-feed-digest__item")[0]?.click();
    await vi.waitFor(() => {
      expect(openFeedItem).toHaveBeenCalledWith("ai-daily", "learning-3", "learning-3-1");
    });

    root.scrollTop = 321;
    root.descendants().find((item) => item.textContent === "查看该来源")?.click();
    await vi.waitFor(() => {
      expect(loadFeedSubscriptions).toHaveBeenNthCalledWith(1, {
        limit: 4,
        source_id: "source-a",
      });
      expect(root.descendants("okf-reading-source-detail")).toHaveLength(1);
    });
    expect(root.descendants("okf-feed-digest__item")).toHaveLength(2);
    expect(root.descendants("okf-feed-digest__item").every((item) => item.hasClass("is-full"))).toBe(true);

    root.descendants().find((item) => item.textContent === "加载更早内容")?.click();
    await vi.waitFor(() => {
      expect(root.descendants("okf-feed-digest__item")).toHaveLength(3);
    });
    expect(loadFeedSubscriptions).toHaveBeenNthCalledWith(2, {
      limit: 4,
      cursor: "older-cursor",
      source_id: "source-a",
    });
    expect(itemTitles()).toEqual([
      "1. 条目 learning-3",
      "1. 条目 learning-2",
      "1. 条目 learning-1",
    ]);
    expect(root.descendants().some((item) => item.textContent === "加载更早内容")).toBe(false);
    expect(root.descendants().some((item) => item.textContent === "已显示全部 3 条")).toBe(true);

    // A normal rerender within the TTL keeps the already loaded cursor history.
    await runtime.render();
    expect(loadFeedSubscriptions).toHaveBeenCalledTimes(2);

    // A Feed decision invalidates projections, refreshes only the first page, and
    // overlays the latest local receipt onto an item retained from an older page.
    decisions.set("learning-1:1", { action: "wiki-now" });
    projectionVersion += 1;
    firstPageVersion = 1;
    await runtime.render();
    expect(loadFeedSubscriptionSources).toHaveBeenNthCalledWith(2, { limit: 8 });
    expect(loadFeedSubscriptions).toHaveBeenNthCalledWith(3, {
      limit: 4,
      source_id: "source-a",
    });
    expect(itemTitles()).toEqual([
      "1. 条目 learning-4",
      "1. 条目 learning-3",
      "1. 条目 learning-2",
      "1. 条目 learning-1",
    ]);
    expect(root.descendants("okf-feed-digest__decision").map((item) => item.textContent))
      .toContain("已整理 Wiki");
    expect(root.descendants().some((item) => item.textContent === "已显示全部 4 条")).toBe(true);

    // External refreshes eventually revalidate the first page while preserving
    // the loaded older pages and their terminal cursor state.
    firstPageVersion = 2;
    runtime.subscriptionLoadedAt = Date.now() - 120_001;
    await runtime.render();
    expect(loadFeedSubscriptions).toHaveBeenNthCalledWith(4, {
      limit: 4,
      source_id: "source-a",
    });
    expect(itemTitles()).toEqual([
      "1. 条目 learning-5",
      "1. 条目 learning-4",
      "1. 条目 learning-3",
      "1. 条目 learning-2",
      "1. 条目 learning-1",
    ]);
    expect(root.descendants().some((item) => item.textContent === "已显示全部 5 条")).toBe(true);

    root.descendants().find((item) => item.textContent === "← 返回全部来源")?.click();
    await vi.waitFor(() => expect(root.descendants("okf-reading-source-card")).toHaveLength(1));
    expect(root.scrollTop).toBe(321);
    expect(root.descendants("okf-reading-source-card__meta")[0]?.textContent).toContain("待判断 4");
  });

  it("coalesces same-version source refreshes and rejects a late stale overview", async () => {
    let projectionVersion = 0;
    let resolveStale!: (page: FeedSubscriptionSourcePage) => void;
    const staleRequest = new Promise<FeedSubscriptionSourcePage>((resolve) => {
      resolveStale = resolve;
    });
    const freshPage: FeedSubscriptionSourcePage = {
      section: "learning",
      sources: [subscriptionSource("fresh", "最新来源", "fresh")],
      total_sources: 1,
      matched_sources: 1,
      next_cursor: null,
      has_more: false,
    };
    let requestCount = 0;
    const loadFeedSubscriptionSources = vi.fn(() => {
      requestCount += 1;
      return requestCount === 1 ? staleRequest : Promise.resolve(freshPage);
    });
    const state = normalizeDashboardUiState({ activeSection: "reading" });
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => state,
      semanticOperationsSnapshot: () => [],
      conversionSnapshot: () => [],
      loadFeedSubscriptionSources,
      feedProjectionVersion: () => projectionVersion,
      feedDecisionSnapshot: () => undefined,
      feedReadingPosition: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      openFeedDigest: vi.fn(async () => undefined),
      updateDashboardFeedUiState: () => undefined,
      updateDashboardPageUiState: () => undefined,
    } as never);
    const runtime = view as unknown as { render: () => Promise<void> };
    const root = view.contentEl as unknown as TestElement;

    const staleRender = runtime.render();
    await vi.waitFor(() => expect(loadFeedSubscriptionSources).toHaveBeenCalledTimes(1));
    const coalescedRender = runtime.render();
    await Promise.resolve();
    expect(loadFeedSubscriptionSources).toHaveBeenCalledTimes(1);

    projectionVersion = 1;
    await runtime.render();
    expect(loadFeedSubscriptionSources).toHaveBeenCalledTimes(2);
    expect(root.descendants("okf-reading-source-card__header")
      .map((header) => header.children.find((child) => child.tagName === "h3")?.textContent))
      .toEqual(["最新来源"]);

    resolveStale({
      section: "learning",
      sources: [subscriptionSource("stale", "过期来源", "stale")],
      total_sources: 1,
      matched_sources: 1,
      next_cursor: "stale-cursor",
      has_more: true,
    });
    await Promise.all([staleRender, coalescedRender]);
    expect(root.descendants("okf-reading-source-card__header")
      .map((header) => header.children.find((child) => child.tagName === "h3")?.textContent))
      .toEqual(["最新来源"]);
  });

  it("accepts only the newest A-B-A source overview request", async () => {
    const firstA = deferred<FeedSubscriptionSourcePage>();
    const requestB = deferred<FeedSubscriptionSourcePage>();
    const newestA = deferred<FeedSubscriptionSourcePage>();
    let aRequests = 0;
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState({ activeSection: "reading" }),
      loadFeedSubscriptionSources: vi.fn((query: { query?: string } = {}) => {
        if (query.query === "A") {
          aRequests += 1;
          return aRequests === 1 ? firstA.promise : newestA.promise;
        }
        return requestB.promise;
      }),
      feedProjectionVersion: () => 0,
    };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, plugin as never);
    const runtime = view as unknown as {
      subscriptionSourceQuery: string;
      subscriptionSources: FeedSubscriptionSource[];
      refreshSubscriptionSourceFirstPage: () => Promise<boolean>;
    };
    const page = (id: string, name: string): FeedSubscriptionSourcePage => ({
      section: "learning",
      sources: [subscriptionSource(id, name, `${id}-latest`)],
      total_sources: 1,
      matched_sources: 1,
      next_cursor: null,
      has_more: false,
    });

    runtime.subscriptionSourceQuery = "A";
    const staleAResult = runtime.refreshSubscriptionSourceFirstPage();
    runtime.subscriptionSourceQuery = "B";
    const staleBResult = runtime.refreshSubscriptionSourceFirstPage();
    runtime.subscriptionSourceQuery = "A";
    const freshAResult = runtime.refreshSubscriptionSourceFirstPage();

    newestA.resolve(page("fresh-a", "最新 A"));
    await expect(freshAResult).resolves.toBe(true);
    firstA.resolve(page("stale-a", "过期 A"));
    requestB.resolve(page("stale-b", "过期 B"));
    await expect(staleAResult).resolves.toBe(false);
    await expect(staleBResult).resolves.toBe(false);
    expect(runtime.subscriptionSources.map((source) => source.source_id)).toEqual(["fresh-a"]);
  });

  it("accepts only the newest A-B-A source detail request", async () => {
    const firstA = deferred<FeedSubscriptionPage>();
    const requestB = deferred<FeedSubscriptionPage>();
    const newestA = deferred<FeedSubscriptionPage>();
    let aRequests = 0;
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState({ activeSection: "reading" }),
      loadFeedSubscriptions: vi.fn((query: { source_id?: string } = {}) => {
        if (query.source_id === "source-a") {
          aRequests += 1;
          return aRequests === 1 ? firstA.promise : newestA.promise;
        }
        return requestB.promise;
      }),
      feedProjectionVersion: () => 0,
    };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, plugin as never);
    const runtime = view as unknown as {
      selectedSubscriptionSource: { source_id: string; source_name: string };
      subscriptionEditions: FeedDigestEdition[];
      refreshSubscriptionFirstPage: () => Promise<boolean>;
    };
    const page = (sourceId: string, digestId: string): FeedSubscriptionPage => ({
      section: "learning",
      source_id: sourceId,
      total_editions: 1,
      editions: [feedEdition("learning", digestId, "2026-08-23")],
      next_cursor: null,
      has_more: false,
    });

    runtime.selectedSubscriptionSource = { source_id: "source-a", source_name: "来源 A" };
    const staleAResult = runtime.refreshSubscriptionFirstPage();
    runtime.selectedSubscriptionSource = { source_id: "source-b", source_name: "来源 B" };
    const staleBResult = runtime.refreshSubscriptionFirstPage();
    runtime.selectedSubscriptionSource = { source_id: "source-a", source_name: "来源 A" };
    const freshAResult = runtime.refreshSubscriptionFirstPage();

    newestA.resolve(page("source-a", "fresh-a"));
    await expect(freshAResult).resolves.toBe(true);
    firstA.resolve(page("source-a", "stale-a"));
    requestB.resolve(page("source-b", "stale-b"));
    await expect(staleAResult).resolves.toBe(false);
    await expect(staleBResult).resolves.toBe(false);
    expect(runtime.subscriptionEditions.map((edition) => edition.digest_id)).toEqual(["fresh-a"]);
  });

  it("paginates source cards and resets cursor and scroll when the DOM search changes", async () => {
    const first = subscriptionSource("source-a", "来源 A", "a-latest");
    const second = subscriptionSource("source-b", "来源 B", "b-latest");
    const filtered = subscriptionSource("source-github", "GitHub 周刊", "github-latest");
    const loadFeedSubscriptionSources = vi.fn(async (
      query: { limit?: number; cursor?: string; query?: string } = {},
    ): Promise<FeedSubscriptionSourcePage> => {
      if (query.query === "GitHub") {
        return {
          section: "learning",
          sources: [filtered],
          total_sources: 9,
          matched_sources: 1,
          next_cursor: null,
          has_more: false,
        };
      }
      if (query.cursor === "source-cursor") {
        return {
          section: "learning",
          sources: [second],
          total_sources: 9,
          matched_sources: 9,
          next_cursor: null,
          has_more: false,
        };
      }
      return {
        section: "learning",
        sources: [first],
        total_sources: 9,
        matched_sources: 9,
        next_cursor: "source-cursor",
        has_more: true,
      };
    });
    const updates: unknown[] = [];
    const state = normalizeDashboardUiState({ activeSection: "reading" });
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => state,
      semanticOperationsSnapshot: () => [],
      conversionSnapshot: () => [],
      loadFeedSubscriptionSources,
      feedProjectionVersion: () => 0,
      feedDecisionSnapshot: () => undefined,
      feedReadingPosition: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      openFeedDigest: vi.fn(async () => undefined),
      ensureLocalServiceAvailable: vi.fn(async () => undefined),
      updateDashboardFeedUiState: () => undefined,
      updateDashboardPageUiState: (_page: string, patch: unknown) => updates.push(patch),
    } as never);
    const runtime = view as unknown as { render: () => Promise<void> };
    const root = view.contentEl as unknown as TestElement;

    await runtime.render();
    root.descendants().find((item) => item.textContent === "加载更多来源")?.click();
    await vi.waitFor(() => expect(root.descendants("okf-reading-source-card")).toHaveLength(2));
    expect(loadFeedSubscriptionSources).toHaveBeenNthCalledWith(2, {
      limit: 8,
      cursor: "source-cursor",
    });

    const input = root.descendants().find((item) => item.tagName === "input");
    expect(input).toBeDefined();
    root.scrollTop = 480;
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    try {
      input!.value = "GitHub";
      input!.selectionStart = 6;
      input!.selectionEnd = 6;
      input!.dispatch("input");
      await vi.advanceTimersByTimeAsync(250);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
    await vi.waitFor(() => {
      expect(root.descendants("okf-reading-source-card__header")
        .map((header) => header.children.find((child) => child.tagName === "h3")?.textContent))
        .toEqual(["GitHub 周刊"]);
    });
    expect(loadFeedSubscriptionSources).toHaveBeenNthCalledWith(3, {
      limit: 8,
      query: "GitHub",
    });
    expect(root.scrollTop).toBe(0);
    expect(updates).toContainEqual({ scrollTop: 0, filters: { query: "GitHub" } });
    const refreshedInput = root.descendants().find((item) => item.tagName === "input");
    expect(refreshedInput?.focusCount).toBe(1);
    expect([refreshedInput?.selectionStart, refreshedInput?.selectionEnd]).toEqual([6, 6]);
  });

  it("keeps an active source query visible when the total drops to one page", async () => {
    const state = normalizeDashboardUiState({
      activeSection: "reading",
      pages: { reading: { scrollTop: 0, filters: { query: "GitHub" } } },
    });
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => state,
      semanticOperationsSnapshot: () => [],
      conversionSnapshot: () => [],
      loadFeedSubscriptionSources: vi.fn(async (): Promise<FeedSubscriptionSourcePage> => ({
        section: "learning",
        sources: [subscriptionSource("github", "GitHub 周刊", "github-latest")],
        total_sources: 2,
        matched_sources: 1,
        next_cursor: null,
        has_more: false,
      })),
      feedProjectionVersion: () => 0,
      feedDecisionSnapshot: () => undefined,
      feedReadingPosition: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      openFeedDigest: vi.fn(async () => undefined),
      updateDashboardFeedUiState: () => undefined,
      updateDashboardPageUiState: () => undefined,
    } as never);
    const runtime = view as unknown as { render: () => Promise<void> };
    const root = view.contentEl as unknown as TestElement;

    await runtime.render();

    expect(root.descendants("okf-reading-source-search")).toHaveLength(1);
    expect(root.descendants().find((item) => item.tagName === "input")?.value).toBe("GitHub");
  });

  it("keeps stale results focused and retries the same failed query with Enter", async () => {
    Notice.messages.length = 0;
    const initial = subscriptionSource("initial", "初始来源", "initial-latest");
    const filtered = subscriptionSource("github", "GitHub 周刊", "github-latest");
    let attempts = 0;
    const loadFeedSubscriptionSources = vi.fn(async (
      query: { query?: string } = {},
    ): Promise<FeedSubscriptionSourcePage> => {
      if (query.query === "GitHub") {
        attempts += 1;
        if (attempts === 1) throw new Error("搜索暂时失败");
        return {
          section: "learning",
          sources: [filtered],
          total_sources: 9,
          matched_sources: 1,
          next_cursor: null,
          has_more: false,
        };
      }
      return {
        section: "learning",
        sources: [initial],
        total_sources: 9,
        matched_sources: 9,
        next_cursor: null,
        has_more: false,
      };
    });
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState({ activeSection: "reading" }),
      semanticOperationsSnapshot: () => [],
      conversionSnapshot: () => [],
      loadFeedSubscriptionSources,
      feedProjectionVersion: () => 0,
      feedDecisionSnapshot: () => undefined,
      feedReadingPosition: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      openFeedDigest: vi.fn(async () => undefined),
      updateDashboardFeedUiState: () => undefined,
      updateDashboardPageUiState: () => undefined,
    } as never);
    const runtime = view as unknown as { render: () => Promise<void> };
    const root = view.contentEl as unknown as TestElement;

    await runtime.render();
    const input = root.descendants().find((item) => item.tagName === "input")!;
    input.focus();
    input.value = "GitHub";
    input.selectionStart = 6;
    input.selectionEnd = 6;
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    try {
      input.dispatch("input");
      await vi.advanceTimersByTimeAsync(250);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
    await vi.waitFor(() => expect(Notice.messages).toEqual([
      "搜索暂时失败；可按 Enter 重试",
    ]));
    expect(root.descendants("okf-reading-source-card__header")[0]?.children[0]?.textContent)
      .toBe("初始来源");
    expect(input.focusCount).toBe(1);

    input.dispatch("keydown", {
      key: "Enter",
      preventDefault: vi.fn(),
    } as unknown as Event);
    await vi.waitFor(() => {
      expect(root.descendants("okf-reading-source-card__header")[0]?.children[0]?.textContent)
        .toBe("GitHub 周刊");
    });
    expect(loadFeedSubscriptionSources).toHaveBeenCalledTimes(3);
    const refreshedInput = root.descendants().find((item) => item.tagName === "input");
    expect(refreshedInput?.focusCount).toBe(1);
    expect([refreshedInput?.selectionStart, refreshedInput?.selectionEnd]).toEqual([6, 6]);
  });

  it("restarts source pagination after refresh so tail additions and removals stay reachable", async () => {
    const fresh = Array.from({ length: 8 }, (_value, index) =>
      subscriptionSource(`source-${index}`, `来源 ${index}`, `digest-${index}`)
    );
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState({ activeSection: "reading" }),
      loadFeedSubscriptionSources: vi.fn(async (): Promise<FeedSubscriptionSourcePage> => ({
        section: "learning",
        sources: fresh,
        total_sources: 11,
        matched_sources: 11,
        next_cursor: "fresh-boundary",
        has_more: true,
      })),
      feedProjectionVersion: () => 0,
    };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, plugin as never);
    const runtime = view as unknown as {
      subscriptionSources: FeedSubscriptionSource[];
      subscriptionSourceCursor: string | null;
      subscriptionSourceHasMore: boolean;
      subscriptionSourcePagesLoaded: number;
      loadAndCommitSubscriptionSourceFirstPage: (
        projectionVersion: number,
        query: string,
      ) => Promise<void>;
    };
    runtime.subscriptionSources = [
      ...fresh,
      subscriptionSource("removed", "已删除来源", "removed"),
      subscriptionSource("old-tail", "旧尾部", "old-tail"),
    ];
    runtime.subscriptionSourceCursor = null;
    runtime.subscriptionSourceHasMore = false;
    runtime.subscriptionSourcePagesLoaded = 2;

    await runtime.loadAndCommitSubscriptionSourceFirstPage(0, "");

    expect(runtime.subscriptionSources.map((source) => source.source_id))
      .toEqual(fresh.map((source) => source.source_id));
    expect(runtime.subscriptionSourceCursor).toBe("fresh-boundary");
    expect(runtime.subscriptionSourceHasMore).toBe(true);
    expect(runtime.subscriptionSourcePagesLoaded).toBe(1);
  });

  it("discards a late source page after a same-version first-page refresh", async () => {
    const staleTail = deferred<FeedSubscriptionSourcePage>();
    let firstPages = 0;
    const initial = subscriptionSource("initial", "初始来源", "initial-latest");
    const refreshed = subscriptionSource("refreshed", "刷新来源", "refreshed-latest");
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState({ activeSection: "reading" }),
      semanticOperationsSnapshot: () => [],
      conversionSnapshot: () => [],
      loadFeedSubscriptionSources: vi.fn((query: { cursor?: string } = {}) => {
        if (query.cursor === "old-boundary") return staleTail.promise;
        firstPages += 1;
        return Promise.resolve({
          section: "learning" as const,
          sources: [firstPages === 1 ? initial : refreshed],
          total_sources: 2,
          matched_sources: 2,
          next_cursor: firstPages === 1 ? "old-boundary" : "new-boundary",
          has_more: true,
        });
      }),
      feedProjectionVersion: () => 0,
      feedDecisionSnapshot: () => undefined,
      feedReadingPosition: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      openFeedDigest: vi.fn(async () => undefined),
      ensureLocalServiceAvailable: vi.fn(async () => undefined),
      updateDashboardFeedUiState: () => undefined,
      updateDashboardPageUiState: () => undefined,
    };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, plugin as never);
    const runtime = view as unknown as {
      render: () => Promise<void>;
      subscriptionSources: FeedSubscriptionSource[];
      loadAndCommitSubscriptionSourceFirstPage: (
        projectionVersion: number,
        query: string,
      ) => Promise<boolean>;
    };
    const root = view.contentEl as unknown as TestElement;

    await runtime.render();
    const more = root.descendants().find((item) => item.textContent === "加载更多来源");
    more?.click();
    await vi.waitFor(() => expect(plugin.loadFeedSubscriptionSources).toHaveBeenCalledTimes(2));

    await runtime.loadAndCommitSubscriptionSourceFirstPage(0, "");
    staleTail.resolve({
      section: "learning",
      sources: [subscriptionSource("stale-tail", "过期尾页", "stale-tail-latest")],
      total_sources: 2,
      matched_sources: 2,
      next_cursor: null,
      has_more: false,
    });
    await vi.waitFor(() => expect(more?.disabled).toBe(false));

    expect(runtime.subscriptionSources.map((source) => source.source_id)).toEqual(["refreshed"]);
  });

  it("restarts Reading pagination when a refreshed first page no longer overlaps loaded history", async () => {
    const freshPage: FeedSubscriptionPage = {
      section: "learning",
      editions: [15, 14, 13, 12].map((value) =>
        feedEdition("learning", `learning-${value}`, `2026-08-${value}`)
      ),
      next_cursor: "cursor-learning-12",
      has_more: true,
    };
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState({ activeSection: "reading" }),
      loadFeedSubscriptions: vi.fn(async () => freshPage),
      feedProjectionVersion: () => 0,
    };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, plugin as never);
    const runtime = view as unknown as {
      subscriptionEditions: FeedDigestEdition[];
      subscriptionCursor: string | null;
      subscriptionHasMore: boolean;
      subscriptionPagesLoaded: number;
      loadAndCommitSubscriptionFirstPage: (projectionVersion: number) => Promise<void>;
    };
    runtime.subscriptionEditions = [10, 9, 8, 7, 6, 5, 4, 3].map((value) =>
      feedEdition("learning", `learning-${value}`, `2026-08-${value}`)
    );
    runtime.subscriptionCursor = null;
    runtime.subscriptionHasMore = false;
    runtime.subscriptionPagesLoaded = 2;

    await runtime.loadAndCommitSubscriptionFirstPage(0);

    expect(runtime.subscriptionEditions.map((edition) => edition.digest_id)).toEqual([
      "learning-15",
      "learning-14",
      "learning-13",
      "learning-12",
    ]);
    expect(runtime.subscriptionCursor).toBe("cursor-learning-12");
    expect(runtime.subscriptionHasMore).toBe(true);
    expect(runtime.subscriptionPagesLoaded).toBe(1);
  });

  it("restarts a source history cursor when its total changes beyond the loaded tail", async () => {
    const freshPage: FeedSubscriptionPage = {
      section: "learning",
      source_id: "source-a",
      total_editions: 9,
      editions: [10, 9, 8, 7].map((value) =>
        feedEdition("learning", `learning-${value}`, `2026-08-${value}`)
      ),
      next_cursor: "cursor-learning-7",
      has_more: true,
    };
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState({ activeSection: "reading" }),
      loadFeedSubscriptions: vi.fn(async () => freshPage),
      feedProjectionVersion: () => 0,
    };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, plugin as never);
    const runtime = view as unknown as {
      selectedSubscriptionSource: { source_id: string; source_name: string };
      subscriptionEditions: FeedDigestEdition[];
      subscriptionCursor: string | null;
      subscriptionHasMore: boolean;
      subscriptionTotalEditions: number | null;
      subscriptionPagesLoaded: number;
      loadAndCommitSubscriptionFirstPage: (
        projectionVersion: number,
        sourceId: string,
      ) => Promise<void>;
    };
    runtime.selectedSubscriptionSource = { source_id: "source-a", source_name: "来源 A" };
    runtime.subscriptionEditions = [10, 9, 8, 7, 6, 5, 4, 3].map((value) =>
      feedEdition("learning", `learning-${value}`, `2026-08-${value}`)
    );
    runtime.subscriptionCursor = null;
    runtime.subscriptionHasMore = false;
    runtime.subscriptionTotalEditions = 8;
    runtime.subscriptionPagesLoaded = 2;

    await runtime.loadAndCommitSubscriptionFirstPage(0, "source-a");

    expect(runtime.subscriptionEditions.map((edition) => edition.digest_id)).toEqual([
      "learning-10",
      "learning-9",
      "learning-8",
      "learning-7",
    ]);
    expect(runtime.subscriptionCursor).toBe("cursor-learning-7");
    expect(runtime.subscriptionHasMore).toBe(true);
    expect(runtime.subscriptionTotalEditions).toBe(9);
    expect(runtime.subscriptionPagesLoaded).toBe(1);
  });

  it("discards a late detail page after a same-version first-page refresh", async () => {
    const staleTail = deferred<FeedSubscriptionPage>();
    const freshPage: FeedSubscriptionPage = {
      section: "learning",
      source_id: "source-a",
      total_editions: 2,
      editions: [feedEdition("learning", "fresh", "2026-08-24")],
      next_cursor: "new-boundary",
      has_more: true,
    };
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState({ activeSection: "reading" }),
      loadFeedSubscriptions: vi.fn((query: { cursor?: string } = {}) =>
        query.cursor === "old-boundary" ? staleTail.promise : Promise.resolve(freshPage)
      ),
      feedProjectionVersion: () => 0,
      feedDecisionSnapshot: () => undefined,
      feedReadingPosition: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      openFeedDigest: vi.fn(async () => undefined),
      ensureLocalServiceAvailable: vi.fn(async () => undefined),
    };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, plugin as never);
    const source = { source_id: "source-a", source_name: "来源 A" };
    const runtime = view as unknown as {
      selectedSubscriptionSource: typeof source;
      subscriptionEditions: FeedDigestEdition[];
      subscriptionCursor: string | null;
      subscriptionHasMore: boolean;
      subscriptionTotalEditions: number | null;
      subscriptionsLoaded: boolean;
      subscriptionPagesLoaded: number;
      subscriptionLoadedAt: number;
      subscriptionProjectionVersion: number;
      subscriptionDetailSourceId: string;
      subscriptionPaginationGeneration: number;
      renderReadingSourceDetail: (container: HTMLElement, selected: typeof source) => Promise<void>;
      loadAndCommitSubscriptionFirstPage: (
        projectionVersion: number,
        sourceId: string,
      ) => Promise<boolean>;
    };
    runtime.selectedSubscriptionSource = source;
    runtime.subscriptionEditions = [feedEdition("learning", "old", "2026-08-23")];
    runtime.subscriptionCursor = "old-boundary";
    runtime.subscriptionHasMore = true;
    runtime.subscriptionTotalEditions = 2;
    runtime.subscriptionsLoaded = true;
    runtime.subscriptionPagesLoaded = 1;
    runtime.subscriptionLoadedAt = Date.now();
    runtime.subscriptionProjectionVersion = 0;
    runtime.subscriptionDetailSourceId = "source-a";
    runtime.subscriptionPaginationGeneration = 1;
    const container = new TestElement();

    await runtime.renderReadingSourceDetail(container as unknown as HTMLElement, source);
    const more = container.descendants().find((item) => item.textContent === "加载更早内容");
    more?.click();
    await vi.waitFor(() => expect(plugin.loadFeedSubscriptions).toHaveBeenCalledTimes(1));

    await runtime.loadAndCommitSubscriptionFirstPage(0, "source-a");
    staleTail.resolve({
      section: "learning",
      source_id: "source-a",
      total_editions: 2,
      editions: [feedEdition("learning", "stale-tail", "2026-08-22")],
      next_cursor: null,
      has_more: false,
    });
    await vi.waitFor(() => expect(more?.disabled).toBe(false));

    expect(runtime.subscriptionEditions.map((edition) => edition.digest_id)).toEqual(["fresh"]);
  });

  it("renders exactly the three daily Feed peers and excludes subscription learning", async () => {
    const openFeedItem = vi.fn(async () => undefined);
    const hotspotBase = feedEdition("hotspot", "hotspot", "2026-08-22");
    const hotspot = {
      ...hotspotBase,
      item_count: 7,
      items: Array.from({ length: 7 }, (_value, index) => ({
        ...hotspotBase.items[0]!,
        item_id: `hotspot:${index + 1}`,
        block_id: `hotspot-${index + 1}`,
        title: `热点 ${index + 1}`,
      })),
    };
    const news = feedEdition("news", "news", "2026-08-22");
    const learning = feedEdition("learning", "learning", "2026-08-22");
    const treehole = {
      ...feedEdition("learning", "treehole", "2026-08-22"),
      section: null,
    };
    const digest = { ai_daily: [hotspot, news, learning], treehole };
    const state = normalizeDashboardUiState({
      feeds: {
        "ai-daily-hotspot": { scrollTop: 137, editionId: hotspot.digest_id },
        "ai-daily-news": { scrollTop: 94, editionId: "older-news" },
      },
    });
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => state,
      feedDashboardDigestSnapshot: () => digest,
      loadFeedDashboardDigest: async () => digest,
      feedDecisionSnapshot: () => undefined,
      feedReadingPosition: () => undefined,
      openFeedItem,
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      openFeedDigest: vi.fn(async () => undefined),
      updateDashboardFeedUiState: () => undefined,
    } as never);
    const runtime = view as unknown as {
      renderDailyFeeds: (container: HTMLElement) => void;
    };
    const container = new TestElement();

    runtime.renderDailyFeeds(container as unknown as HTMLElement);
    await Promise.resolve();

    const headings = container.descendants("okf-feed-card__header")
      .map((heading) => heading.children[0]?.textContent);
    expect(headings).toEqual(["中国热点", "AI 资讯", "树洞热榜"]);
    expect(headings).not.toContain("订阅阅读");
    expect(container.descendants("okf-feed-card")).toHaveLength(3);
    expect(container.descendants("okf-feed-digest__item")).toHaveLength(9);
    expect(container.descendants("okf-feed-digest__item").every((item) => item.hasClass("is-compact")))
      .toBe(true);
    expect(container.descendants("okf-feed-project__preview")).toHaveLength(3);
    expect(container.descendants().some((item) => item.textContent === "7. 热点 7")).toBe(true);
    expect(container.descendants().some((item) => item.textContent === "打开本期原生笔记")).toBe(true);

    const bodies = container.descendants("okf-feed-card__body");
    expect(bodies.map((body) => body.dataset.feed)).toEqual([
      "ai-daily-hotspot",
      "ai-daily-news",
      "treehole",
    ]);
    expect(bodies[0]?.scrollTop).toBe(137);
    expect(bodies[1]?.scrollTop).toBe(0);
    expect(bodies[0]?.listeners.get("scroll")).toHaveLength(1);

    container.descendants("okf-feed-digest__item")[0]?.click();
    await vi.waitFor(() => {
      expect(openFeedItem).toHaveBeenCalledWith("ai-daily", "hotspot", "hotspot-1");
    });
  });

  it("renders Today as a full-width action grid with a fixed leading System slot", async () => {
    const activeProject = project();
    const pendingCapture = note({
      path: "inbox/captures/pending.md",
      title: "待判断",
      note_type: "Capture",
      capture_status: "pending",
    });
    const running = operation("generating", "running");
    const failed = operation("generating", "failed");
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      recentDashboardFiles: () => [],
      semanticOperationsSnapshot: () => [running, failed],
      conversionSnapshot: () => [],
      updateDashboardPageUiState: () => undefined,
    } as never);
    const runtime = view as unknown as {
      vaultReader: {
        today: () => Promise<unknown>;
        inbox: () => Promise<unknown>;
      };
      api: () => { systemStatus: () => Promise<unknown> };
      renderDailyFeeds: (parent: HTMLElement) => void;
      renderToday: (parent: HTMLElement) => Promise<void>;
    };
    runtime.vaultReader = {
      today: async () => ({
        date: "2026-08-23",
        daily: { path: "life/daily/2026/08/2026-08-23.md", exists: true },
        daily_excerpt: "",
        tasks: [{ path: activeProject.path, line: 1, text: "完成验收" }],
        active_projects: [activeProject],
        active_courses: [],
        recent_study: [],
        open_inbox_count: 1,
        pending_study_count: 2,
        pending_wiki_count: 3,
        stale_knowledge: [note({ path: "knowledge/wiki/stale.md", note_type: "Wiki", stale: true })],
      }),
      inbox: async () => ({ captures: [pendingCapture], processed_captures: [], pending_imports: [] }),
    };
    runtime.api = () => ({
      systemStatus: async () => ({
        checked_at: "2026-08-23T00:00:00Z",
        version: "1.0.0",
        items: [],
        actionable: [{ item_id: "governance", label: "治理", status: "warning", detail: "1 项待复核" }],
      }),
    });
    runtime.renderDailyFeeds = (parent) => {
      (parent as unknown as TestElement).createDiv({ cls: "daily-placeholder" });
    };
    const container = new TestElement();

    await runtime.renderToday(container as unknown as HTMLElement);
    await Promise.resolve();

    const actionSection = container.descendants("okf-today-action-section")[0]!;
    expect(actionSection.children[1]?.hasClass("okf-today-system-slot")).toBe(true);
    expect(actionSection.children[2]?.hasClass("okf-today-action-grid")).toBe(true);
    expect([...actionSection.children[2]!.classes]).toEqual(["okf-today-action-grid", "has-3-columns"]);
    expect(container.descendants("okf-today-system-slot")[0]?.hasClass("is-empty")).toBe(false);
    expect(container.descendants("okf-dashboard__inline-alert")).toHaveLength(1);
    const labels = container.descendants("okf-dashboard__attention-item")
      .map((item) => item.children[1]?.textContent);
    expect(labels).toEqual([
      "异常",
      "Inbox",
      "待生成 Study Guide",
      "待生成 Wiki",
      "知识待复核",
      "后台运行",
    ]);
    expect(container.descendants("daily-placeholder")).toHaveLength(1);
  });

  it("resolves current Source.text files while keeping legacy extracts readable", async () => {
    const paths = [
      "learning/guides/topic.md",
      "sources/records/web/topic.md",
      "sources/text/web/topic.md",
      "sources/extracts/web/legacy-topic.md",
      "sources/text/web/unrelated.md",
    ];
    const files = paths.map((path) =>
      new (TFile as unknown as new (path: string) => TFile)(path));
    const byPath = new Map(files.map((file) => [file.path, file]));
    const frontmatter = new Map<string, Record<string, unknown>>([
      ["learning/guides/topic.md", {
        sources: [{ resource: "/sources/records/web/topic.md" }],
      }],
      ["sources/records/web/topic.md", {
        text: "/sources/text/web/topic.md",
        extract: "/sources/extracts/web/legacy-topic.md",
      }],
    ]);
    const markdown = new Map<string, string>([
      [
        "sources/records/web/topic.md",
        "[正文](/sources/text/web/topic.md)\n[旧摘录](/sources/extracts/web/legacy-topic.md)",
      ],
    ]);
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => byPath.get(path) ?? null,
        cachedRead: async (file: TFile) => markdown.get(file.path) ?? "",
      },
      metadataCache: {
        getFileCache: (file: TFile) => ({ frontmatter: frontmatter.get(file.path) }),
      },
    } as unknown as App;

    expect(await resolveDashboardLearningSources(app, "learning/guides/topic.md")).toEqual([
      "sources/records/web/topic.md",
      "sources/text/web/topic.md",
      "sources/extracts/web/legacy-topic.md",
    ]);
    expect(await resolveDashboardLearningSources(app, "sources/records/web/topic.md")).toEqual([
      "sources/text/web/topic.md",
      "sources/extracts/web/legacy-topic.md",
    ]);
  });

  it("shows TreeHole favorites before likes regardless of payload key order", () => {
    const metadata = treeholeMetadata({
      item_id: "treehole:8466293",
      block_id: "treehole-8466293",
      title: "TreeHole #8466293",
      summary: "",
      source: "TreeHole",
      metrics: {
        like_count: 3,
        reply_count: 15,
        favorite_count: 43,
      },
      comment_count: 0,
      media_count: 0,
    });

    expect(metadata).toBe("回复 15 · 收藏 43 · 点赞 3");
  });

  it("selects each Today AI stream independently and never substitutes learning", () => {
    const hotspotOld = feedEdition("hotspot", "hotspot-old", "2026-08-20");
    const hotspotLatest = feedEdition("hotspot", "hotspot-latest", "2026-08-21");
    const news = feedEdition("news", "news", "2026-08-20");
    const learning = feedEdition("learning", "learning", "2026-08-22");
    const digest = {
      ai_daily: [learning, hotspotOld, news, hotspotLatest],
      treehole: null,
    };

    expect(latestAiDailyEdition(digest, "hotspot")?.digest_id).toBe("hotspot-latest");
    expect(latestAiDailyEdition(digest, "news")?.digest_id).toBe("news");
    expect(latestAiDailyEdition({ ai_daily: [learning], treehole: null }, "news"))
      .toBeUndefined();
  });

  it("merges subscription pages in cursor order while excluding non-learning editions", () => {
    const first = feedEdition("learning", "learning-2", "2026-08-22");
    const older = feedEdition("learning", "learning-1", "2026-08-21");
    const news = feedEdition("news", "news-1", "2026-08-21");

    expect(mergeSubscriptionEditions([first], [first, news, older]).map((item) => item.digest_id))
      .toEqual(["learning-2", "learning-1"]);
  });

  it("merges source pages by stable source id without duplicating refreshed cards", () => {
    const first = subscriptionSource("source-a", "来源 A", "a-2");
    const refreshed = { ...first, pending_decision_count: 0 };
    const second = subscriptionSource("source-b", "来源 B", "b-1");

    expect(mergeSubscriptionSources([refreshed], [first, second])).toEqual([refreshed, second]);
  });

  it("uses the same explicit Feed result labels on Today and Reading items", () => {
    expect(feedDecisionLabel("learn-now")).toBe("已开始学习");
    expect(feedDecisionLabel("wiki-now")).toBe("已整理 Wiki");
    expect(feedDecisionLabel("ignore")).toBe("已忽略");
    expect(feedDecisionLabel(null)).toBe("");
  });

  it("reports partial Feed synchronization without hiding successful streams", () => {
    expect(feedSyncFailureMessage([
      {
        feed: "ai-daily",
        status: "ok",
        digest_id: "hotspot-1",
        issued_at: "2026-08-22",
        item_count: 10,
      },
      {
        feed: "ai-daily",
        status: "error",
        section: "learning",
        detail: "上游暂时不可用",
      },
    ])).toBe("部分内容同步失败（其他内容已更新）：订阅阅读：上游暂时不可用");
    expect(feedSyncFailureMessage([{
      feed: "treehole",
      status: "ok",
      digest_id: "treehole-1",
      issued_at: "2026-08-22",
      item_count: 20,
    }])).toBe("");
  });

  it("translates implementation health states into human-facing System labels", () => {
    expect(systemStatusLabel("configured")).toBe("已配置");
    expect(systemStatusLabel("ok")).toBe("正常");
    expect(systemStatusLabel("deferred")).toBe("稍后配置");
    expect(systemStatusLabel("failed")).toBe("失败");
  });

  it("keeps the Project action panel flat and action-oriented", () => {
    expect(PROJECT_ACTION_PANEL_LABELS).toEqual([
      "记录待整理想法",
      "添加资料",
      "打开项目日志",
      "在 Claudian 中整理项目",
    ]);
    expect(PROJECT_ACTION_PANEL_LABELS).not.toContain("记录关键点");
  });

  it("renders a compact Project row with one current action and one explicit action panel", async () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const promptProjectProgress = vi.fn();
    const promptCapture = vi.fn();
    const promptDocumentImport = vi.fn();
    const openVaultPath = vi.fn(async () => undefined);
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      promptProject: () => undefined,
      promptDocumentImport,
      promptProjectProgress,
      promptCapture,
      setProjectStatus: vi.fn(async () => ({ path: "projects/workspace/project.md" })),
      updateDashboardPageUiState: () => undefined,
      openVaultPath,
    };
    const view = new OkfDashboardView(leaf, plugin as never);
    const panels: AnchoredActionPanelOptions[] = [];
    const runtime = view as unknown as {
      vaultReader: { projects: () => Promise<unknown> };
      renderProjects: (container: HTMLElement) => Promise<void>;
      attachActionPanel: (trigger: HTMLButtonElement, options: AnchoredActionPanelOptions) => void;
    };
    runtime.attachActionPanel = (_trigger, options) => panels.push(options);
    Object.defineProperty(runtime, "vaultReader", {
      value: {
        projects: async () => ({
          projects: [{
            path: "projects/workspace/project.md",
            title: "个人知识工作区",
            note_type: "Project",
            status: "stable",
            stale: false,
            excerpt: "",
            project_status: "active",
            current_state: "",
            next_action: "完成导入验收",
            recent_log: "",
            log_path: "projects/workspace/log.md",
            decisions: [],
            outputs: [],
            related_learning: [],
            related_materials: [],
            pending_captures: [],
          }],
        }),
      },
    });
    const container = new TestElement();

    await runtime.renderProjects(container as unknown as HTMLElement);

    const row = container.descendants("okf-project-row")[0];
    const actions = row?.descendants("okf-work-item__actions")[0];
    expect(actions?.children.map((child) => child.textContent)).toEqual(["记录进展", "其他操作 ▾"]);
    actions?.children[0]?.click();
    expect(promptProjectProgress).toHaveBeenCalledWith("projects/workspace/project.md");
    expect(panels).toHaveLength(1);
    expect(panels[0]?.label).toBe("其他操作 · 个人知识工作区");
    expect(panels[0]?.actions.map((action) => action.title)).toEqual(PROJECT_ACTION_PANEL_LABELS);
    expect(row?.descendants("okf-work-item__metric").map((item) => item.textContent)).toEqual([
      "待整理 0",
      "Study Guide 0",
      "来源 0",
    ]);

    await panels[0]?.actions[0]?.onSelect();
    await panels[0]?.actions[1]?.onSelect();
    await panels[0]?.actions[2]?.onSelect();
    expect(promptCapture).toHaveBeenCalledWith({ project: "projects/workspace/project.md" });
    expect(promptDocumentImport).toHaveBeenCalledWith({ project: "workspace" });
    expect(openVaultPath).toHaveBeenCalledWith("projects/workspace/log.md");
  });

  it.each([
    ["active", "记录进展"],
    ["paused", "恢复推进"],
    ["completed", "重新开启"],
  ] as const)("uses the state-aware Project primary action for %s", async (status, label) => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const promptProjectProgress = vi.fn();
    const openVaultPath = vi.fn(async () => undefined);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      promptProjectProgress,
      openVaultPath,
    } as never);
    const changeProjectStatus = vi.fn(async () => undefined);
    const runtime = view as unknown as {
      renderProjectWorkItem: (container: HTMLElement, value: ProjectSummary) => void;
      attachActionPanel: () => void;
      changeProjectStatus: (path: string, next: "active" | "paused" | "completed") => Promise<void>;
    };
    runtime.attachActionPanel = () => undefined;
    runtime.changeProjectStatus = changeProjectStatus;
    const container = new TestElement();

    runtime.renderProjectWorkItem(container as unknown as HTMLElement, project(status));
    const row = container.descendants("okf-project-row")[0]!;
    const title = row.descendants("okf-dashboard__row-title")[0]!;
    const primary = row.descendants("okf-work-item__primary-action")[0]!;
    expect(primary.textContent).toBe(label);
    title.click();
    expect(openVaultPath).toHaveBeenCalledWith("projects/workspace/project.md");
    primary.click();
    if (status === "active") {
      expect(promptProjectProgress).toHaveBeenCalledWith("projects/workspace/project.md");
      expect(changeProjectStatus).not.toHaveBeenCalled();
    } else {
      expect(changeProjectStatus).toHaveBeenCalledWith("projects/workspace/project.md", "active");
      expect(promptProjectProgress).not.toHaveBeenCalled();
    }
  });

  it("keeps Project status management direct and single-level", () => {
    expect(projectStatusActions("active")).toEqual([
      { status: "paused", label: "暂停项目" },
      { status: "completed", label: "标记完成" },
    ]);
    expect(projectStatusActions("paused")).toEqual([
      { status: "active", label: "恢复推进" },
      { status: "completed", label: "标记完成" },
    ]);
    expect(projectStatusActions("completed")).toEqual([
      { status: "active", label: "重新开启" },
      { status: "paused", label: "暂停项目" },
    ]);
  });

  it("uses one Learning work-item grammar across pending, ready, and completed states", () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      openVaultPath: async () => undefined,
    } as never);
    const panels: AnchoredActionPanelOptions[] = [];
    const runtime = view as unknown as {
      renderLearningNotes: (
        container: HTMLElement,
        notes: NoteSummary[],
        empty: string,
        operations?: Map<string, SemanticOperationRecord>,
        titles?: ReadonlyMap<string, string>,
      ) => void;
      attachActionPanel: (trigger: HTMLButtonElement, options: AnchoredActionPanelOptions) => void;
    };
    runtime.attachActionPanel = (_trigger, options) => panels.push(options);
    const notes = [
      note({
        path: "sources/records/documents/pending.md",
        title: "待生成来源",
        note_type: "Source",
        purpose: "study",
      }),
      note({ title: "待生成 Guide", material_ready: false }),
      note({ path: "learning/guides/ready.md", title: "可学习 Guide", material_ready: true }),
      note({
        path: "learning/guides/completed.md",
        title: "已完成 Guide",
        material_ready: true,
        studied_at: "2026-08-22T00:00:00Z",
      }),
    ];
    const container = new TestElement();

    runtime.renderLearningNotes(container as unknown as HTMLElement, notes, "");
    const rows = container.descendants("okf-learning-work-item");
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.descendants("okf-work-item__status")[0]?.textContent)).toEqual([
      "待生成",
      "待生成",
      "可学习",
      "已完成",
    ]);
    expect(rows.map((row) => row.descendants("okf-work-item__actions")[0]?.children
      .map((child) => child.textContent))).toEqual([
      ["生成学习材料", "其他操作 ▾"],
      ["生成", "其他操作 ▾"],
      ["打开", "其他操作 ▾"],
      ["打开", "其他操作 ▾"],
    ]);
    expect(container.descendants("okf-dashboard__row-details")).toHaveLength(0);
    expect(panels.map((panel) => panel.actions.map((action) => action.title))).toEqual([
      ["与 Claudian 一起生成"],
      ["与 Claudian 一起生成"],
      ["用 Claudian 完善", "用 Claudian 讨论", "标记完成"],
      ["用 Claudian 完善", "用 Claudian 讨论", "取消完成", "沉淀 Wiki"],
    ]);
  });

  it("offers cancellation only before a Learning operation starts publishing", () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
    } as never);
    const panels: AnchoredActionPanelOptions[] = [];
    const runtime = view as unknown as {
      learningQueueActions: (
        container: HTMLElement,
        value: NoteSummary,
        operation: SemanticOperationRecord,
      ) => void;
      attachActionPanel: (trigger: HTMLButtonElement, options: AnchoredActionPanelOptions) => void;
    };
    runtime.attachActionPanel = (_trigger, options) => panels.push(options);
    const generating = new TestElement();
    runtime.learningQueueActions(
      generating as unknown as HTMLElement,
      note({ material_ready: false }),
      operation("generating"),
    );
    expect(generating.descendants("okf-work-item__actions")[0]?.children.map((child) => child.textContent))
      .toEqual(["Codex 正在生成内容", "其他操作 ▾"]);
    expect(panels[0]?.actions.map((action) => action.title)).toEqual(["取消后台生成"]);

    const publishing = new TestElement();
    runtime.learningQueueActions(
      publishing as unknown as HTMLElement,
      note({ material_ready: false }),
      operation("publishing"),
    );
    expect(publishing.descendants("okf-work-item__actions")[0]?.children.map((child) => child.textContent))
      .toEqual(["正在写入目标笔记"]);
    expect(panels).toHaveLength(1);
  });
});

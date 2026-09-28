import { ItemView, TFile, WorkspaceLeaf, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  OkfDashboardItemView,
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
import type { ConversionRecord, NoteSummary, ProjectSummary, SemanticOperationRecord } from "../src/api/types.js";
import type {
  AiDailyStream,
  FeedDigestEdition,
  FeedSubscriptionPage,
  FeedSubscriptionSource,
  FeedSubscriptionSourceItemsPage,
  FeedSubscriptionSourcePage,
} from "../src/feeds/types.js";
import { FeedHttpError } from "../src/feeds/service.js";
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

it("keeps a failed generation handoff actionable in the real Inbox card", async () => {
  const record: ConversionRecord = {
    conversion_id: "conv-handoff", status: "imported", parser: "markitdown",
    source_filename: "fixture.pdf", intent: "learn", quality: "quick",
    stages: { conversion: "completed", routing: "completed", semantic: "failed" },
    error: "queue busy", outputs: { source_text: "sources/text/fixture.md", routed_target: "learning/guides/future.md" },
  };
  const watchDocumentConversion = vi.fn();
  const openVaultPath = vi.fn();
  const view = new OkfDashboardView(
    new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App),
    { getDashboardUiState: () => normalizeDashboardUiState(undefined),
      ensureLocalServiceAvailable: async () => undefined, watchDocumentConversion, openVaultPath } as never,
  );
  const retryConversion = vi.fn(async () => record);
  vi.spyOn(view as never, "api").mockReturnValue({ retryConversion });
  vi.spyOn(view as never, "render").mockResolvedValue(undefined);
  const container = new TestElement();
  (view as unknown as { renderInboxConversionCard(parent: HTMLElement, record: ConversionRecord): void })
    .renderInboxConversionCard(container as unknown as HTMLElement, record);
  expect(container.descendants().some((item) => item.textContent.includes("生成入队失败"))).toBe(true);
  container.descendants().find((item) => item.textContent === "打开结果")!.click();
  expect(openVaultPath).toHaveBeenCalledWith("sources/text/fixture.md");
  container.descendants().find((item) => item.textContent === "重试生成入队")!.click();
  await vi.waitFor(() => expect(retryConversion).toHaveBeenCalledWith("conv-handoff"));
  expect(watchDocumentConversion).toHaveBeenCalledWith("conv-handoff");
});

it("walks mixed active, publishing, failed, cancelled, and conversion fallback states in the task center", () => {
  const now = new Date().toISOString();
  const queued = { ...operation("queued", "queued"), operation_id: "op-queued", updated_at: now };
  const generating = { ...operation("generating"), operation_id: "op-generating", updated_at: now };
  const publishing = { ...operation("publishing"), operation_id: "op-publishing", updated_at: now };
  const failed = { ...operation("failed", "failed"), operation_id: "op-failed", updated_at: now };
  const cancelled = { ...operation("cancelled", "cancelled"), operation_id: "op-cancelled", updated_at: now };
  const queuedConversion: ConversionRecord = {
    conversion_id: "conv-queued", status: "queued", source_filename: "queued.pdf",
    intent: "learn", quality: "quick", parser: "mineru", outputs: {},
  };
  const failedPublish: ConversionRecord = {
    conversion_id: "conv-publish", status: "failed", source_filename: "publish.pdf",
    intent: "learn", quality: "quick", parser: "mineru",
    stages: { conversion: "completed", routing: "failed" }, error: "fixture publish failure",
    outputs: { source_text: "sources/text/publish.md" },
  };
  const failedHandoff: ConversionRecord = {
    conversion_id: "conv-handoff", status: "imported", source_filename: "handoff.pdf",
    intent: "learn", quality: "quick", parser: "mineru",
    stages: { conversion: "completed", routing: "completed", semantic: "failed" },
    error: "fixture generation handoff failure",
    outputs: { source_text: "sources/text/handoff.md", routed_target: "learning/guides/handoff.md" },
  };
  const cancelOperation = vi.fn(async () => undefined);
  const retryOperation = vi.fn(async (operationId: string) => ({
    ...failed,
    operation_id: `${operationId}-retry`,
    status: "queued" as const,
    stage: "queued" as const,
  }));
  const retryConversion = vi.fn(async (conversionId: string) => conversionId === failedPublish.conversion_id
    ? { ...failedPublish, status: "ready" as const }
    : { ...failedHandoff, stages: { ...failedHandoff.stages, semantic: "pending" } });
  const watchSemanticOperation = vi.fn();
  const watchDocumentConversion = vi.fn();
  const plugin = {
    getDashboardUiState: () => normalizeDashboardUiState(undefined),
    ensureLocalServiceAvailable: vi.fn(async () => undefined),
    semanticOperationsSnapshot: () => [queued, generating, publishing, failed, cancelled],
    conversionSnapshot: () => [queuedConversion, failedPublish, failedHandoff],
    watchSemanticOperation,
    watchDocumentConversion,
  };
  const view = new OkfDashboardView(
    new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App),
    plugin as never,
  );
  const runtime = view as unknown as {
    taskCenterOpen: boolean;
    renderBackgroundTasks(parent: HTMLElement): void;
  };
  vi.spyOn(view as never, "render").mockResolvedValue(undefined);
  vi.spyOn(view as never, "api").mockReturnValue({
    cancelSemanticOperation: cancelOperation,
    retrySemanticOperation: retryOperation,
    retryConversion,
  } as never);
  runtime.taskCenterOpen = true;
  const container = new TestElement();
  runtime.renderBackgroundTasks(container as unknown as HTMLElement);

  const text = container.descendants().map((item) => item.textContent).join("\n");
  expect(text).toContain("排队中 · learning/guides/example.md");
  expect(text).toContain("正在生成内容");
  expect(text).toContain("正在写入目标笔记");
  expect(text).toContain("失败");
  expect(text).toContain("已取消");
  expect(text).toContain("转换已完成，待继续保存");
  expect(container.descendants().some((item) => item.textContent === "继续保存")).toBe(true);
  expect(container.descendants().some((item) => item.textContent === "重试生成入队")).toBe(true);
  expect(container.descendants().filter((item) => item.textContent === "取消后台任务")).toHaveLength(2);

  const actions = (label: string) => container.descendants().filter((item) => item.textContent === label);
  const cancelButtons = actions("取消后台任务");
  const retryButtons = actions("重新生成");
  const resumeButton = actions("继续保存")[0]!;
  const retryHandoffButton = actions("重试生成入队")[0]!;
  cancelButtons[0]!.click();
  cancelButtons[1]!.click();
  retryButtons[0]!.click();
  retryButtons[1]!.click();
  resumeButton.click();
  retryHandoffButton.click();
  return vi.waitFor(() => {
    expect(cancelOperation).toHaveBeenCalledTimes(2);
    expect(cancelOperation).toHaveBeenCalledWith(queued.operation_id);
    expect(cancelOperation).toHaveBeenCalledWith(generating.operation_id);
    expect(retryOperation).toHaveBeenCalledTimes(2);
    expect(retryConversion).toHaveBeenCalledWith(failedPublish.conversion_id);
    expect(retryConversion).toHaveBeenCalledWith(failedHandoff.conversion_id);
    expect(watchSemanticOperation).toHaveBeenCalledTimes(2);
    expect(watchDocumentConversion).toHaveBeenCalledWith(failedPublish.conversion_id);
    expect(watchDocumentConversion).toHaveBeenCalledWith(failedHandoff.conversion_id);
  });
});

function project(status: "active" | "paused" | "completed" = "active"): ProjectSummary {
  return {
    ...note({
      path: "projects/workspace/project.md",
      title: "个人知识库",
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
    open_tasks: [],
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
  section: AiDailyStream | "papers",
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
    latest_revision: `${digestId}:revision`,
    latest_item_count: previewCount,
    pending_decision_count: previewCount,
    edition_count: 3,
    native_section_counts: { 工具: Math.ceil(previewCount / 2), 文章: Math.floor(previewCount / 2) },
    preview_items: preview.slice(0, 3),
  };
}

function subscriptionSourceItemsPage(
  source: FeedSubscriptionSource,
  start = 0,
  limit = 40,
): FeedSubscriptionSourceItemsPage {
  const end = Math.min(source.latest_item_count, start + limit);
  return {
    source_id: source.source_id,
    digest_id: source.latest_digest_id!,
    ...(source.latest_revision ? { latest_revision: source.latest_revision } : {}),
    issued_at: source.latest_issued_at!,
    item_count: source.latest_item_count,
    items: Array.from({ length: end - start }, (_value, offset) => {
      const index = start + offset;
      return {
        item_id: `${source.latest_digest_id}:${index + 1}`,
        block_id: `${source.latest_digest_id}-${index + 1}`,
        title: `条目 ${source.source_name} ${index + 1}`,
        summary: "摘要",
        source: source.source_name,
        source_id: source.source_id,
        source_name: source.source_name,
        native_section: index % 2 ? "文章" : "工具",
        metrics: {},
        comment_count: 0,
        media_count: 0,
      };
    }),
    next_cursor: end < source.latest_item_count ? `cursor-${end}` : null,
    has_more: end < source.latest_item_count,
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

function enableLatestItemsPagination(view: OkfDashboardView): void {
  (view as unknown as { subscriptionLatestItemsPagination: boolean })
    .subscriptionLatestItemsPagination = true;
}

describe("real Dashboard View source handoff", () => {
  it("mounts an embedded Surface without constructing a nested Obsidian ItemView", () => {
    const runtimeItemView = ItemView as unknown as { constructorCount: number };
    runtimeItemView.constructorCount = 0;
    const app = {} as App;
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(app);
    const container = new TestElement();
    const view = new OkfDashboardView(leaf, {
      app,
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
    } as never, {
      container: container as unknown as HTMLElement,
      initialSection: "learning",
      embedded: true,
    });

    expect(runtimeItemView.constructorCount).toBe(0);
    expect(view.contentEl).toBe(container);
  });

  it("keeps an Apex card on its own page without a second switcher or title", async () => {
    const navigateToOkfSection = vi.fn(async () => undefined);
    const app = {} as App;
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(app);
    const container = new TestElement();
    const view = new OkfDashboardView(leaf, {
      app,
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      updateDashboardPageUiState: vi.fn(),
      updateDashboardFeedUiState: vi.fn(),
      navigateToOkfSection,
    } as never, {
      container: container as unknown as HTMLElement,
      initialSection: "system",
      embedded: true,
    });
    vi.spyOn(view as never, "renderSystem").mockResolvedValue(undefined);

    await view.onOpen();

    expect(container.descendants("okf-dashboard__topbar")).toHaveLength(0);
    expect(container.descendants("okf-dashboard__page-header")).toHaveLength(0);
    expect(container.descendants("okf-dashboard__surface-navigation")).toHaveLength(0);
    (view as unknown as { openSection: (section: string) => void }).openSection("learning");
    expect(navigateToOkfSection).toHaveBeenCalledWith("learning", container, undefined);
    expect(container.descendants("okf-dashboard__page-header")).toHaveLength(0);
    await view.onClose();
  });

  it("offers to add a missing focused page to the originating workbench", async () => {
    const addOkfSectionToActiveWorkbench = vi.fn(async () => undefined);
    const app = {} as App;
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(app);
    const container = new TestElement();
    const view = new OkfDashboardView(leaf, {
      app,
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      updateDashboardPageUiState: vi.fn(),
      updateDashboardFeedUiState: vi.fn(),
      semanticOperationsSnapshot: () => [],
      conversionSnapshot: () => [],
      hasOkfSectionInActiveWorkbench: () => false,
      addOkfSectionToActiveWorkbench,
    } as never, {
      container: container as unknown as HTMLElement,
      initialSection: "system",
      focused: true,
      workbenchPath: "workbenches/daily",
    });
    vi.spyOn(view as never, "renderSystem").mockResolvedValue(undefined);

    await view.onOpen();
    expect(container.descendants().some((item) => item.textContent === "返回工作台")).toBe(true);
    expect(container.descendants("okf-dashboard__nav")).toHaveLength(0);
    container.descendants().find((item) => item.textContent === "添加到当前工作台")!.click();
    expect(addOkfSectionToActiveWorkbench).toHaveBeenCalledWith("system", "workbenches/daily");
    await view.onClose();
  });

  it("constructs the registered runtime View rather than a legacy page model", () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
    } as never);

    expect(view.getViewType()).toBe(OKF_DASHBOARD_VIEW);
    expect(view.getDisplayText()).toBe("工作台");
  });

  it("keeps the focused pane title and saved state aligned with its page", async () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const pane = new OkfDashboardItemView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
    } as never);

    await pane.setState({ section: "knowledge", workbenchPath: "workbenches/daily" }, {} as never);

    expect(pane.getViewType()).toBe(OKF_DASHBOARD_VIEW);
    expect(pane.getDisplayText()).toBe("工作台 · 知识库");
    expect(pane.getState()).toEqual({ section: "knowledge", workbenchPath: "workbenches/daily" });
  });

  it("renders a newly confirmed source as a waiting card without requesting missing items", () => {
    const loadItems = vi.fn();
    const openSettings = vi.fn();
    const source: FeedSubscriptionSource = {
      source_id: "new-rss-source",
      source_name: "新订阅",
      latest_issued_at: null,
      latest_digest_id: null,
      latest_revision: null,
      quality: null,
      quality_reason: null,
      latest_item_count: 0,
      pending_decision_count: 0,
      edition_count: 0,
      native_section_counts: {},
      preview_items: [],
      status: "waiting",
      registry_managed: true,
      enabled: true,
      registry_status: "enabled",
      canonical_url: "https://example.com/feed.xml",
      adapter: "rss",
      required: false,
      last_success_at: null,
      last_error_at: null,
      last_error_type: null,
      last_error: null,
    };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      loadFeedSubscriptionSourceItems: loadItems,
      promptFeedSubscriptionSettings: openSettings,
    } as never);
    enableLatestItemsPagination(view);
    const runtime = view as unknown as {
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
    };
    const parent = new TestElement();

    runtime.renderSubscriptionSourceCard(parent as unknown as HTMLElement, source);

    expect(loadItems).not.toHaveBeenCalled();
    expect(parent.descendants("okf-feed-subscription-status")[0]?.textContent)
      .toBe("等待首次更新");
    expect(parent.descendants().some((element) =>
      element.textContent.includes("后台首次更新完成后")
    )).toBe(true);
    parent.descendants().find((element) => element.textContent === "设置…")?.click();
    expect(openSettings).toHaveBeenCalledWith(source);
  });

  it("restores each Reading source by digest and resets it when a new edition arrives", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    try {
      const updateSourceState = vi.fn(() => undefined);
      const state = normalizeDashboardUiState({
        readingSources: {
          "source-a": { digestId: "older-digest", scrollTop: 240 },
        },
      });
      const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
      const view = new OkfDashboardView(leaf, {
        getDashboardUiState: () => state,
        feedReadingPosition: () => undefined,
        feedDecisionSnapshot: () => undefined,
        openFeedItem: vi.fn(async () => undefined),
        rememberFeedReadingPosition: vi.fn(async () => undefined),
        loadFeedSubscriptionSourceItems: async () => subscriptionSourceItemsPage(
          subscriptionSource("source-a", "Alpha", "new-digest", 5),
        ),
        updateDashboardReadingSourceUiState: updateSourceState,
      } as never);
      enableLatestItemsPagination(view);
      const runtime = view as unknown as {
        renderSubscriptionSourceCard: (parent: HTMLElement, source: FeedSubscriptionSource) => void;
      };
      const parent = new TestElement();

      runtime.renderSubscriptionSourceCard(
        parent as unknown as HTMLElement,
        subscriptionSource("source-a", "Alpha", "new-digest", 5),
      );
      await vi.advanceTimersByTimeAsync(0);

      const body = parent.descendants("okf-reading-source-card__preview")[0]!;
      expect(body.scrollTop).toBe(0);
      expect(parent.descendants("okf-feed-digest__item")).toHaveLength(5);
      expect(updateSourceState).toHaveBeenCalledWith("source-a", expect.objectContaining({
        digestId: "new-digest",
        scrollTop: 0,
      }));

      body.scrollTop = 175;
      body.dispatch("scroll");
      vi.advanceTimersByTime(120);
      expect(updateSourceState).toHaveBeenLastCalledWith("source-a", expect.objectContaining({
        digestId: "new-digest",
        scrollTop: 175,
      }));

      const sameDigestParent = new TestElement();
      runtime.renderSubscriptionSourceCard(
        sameDigestParent as unknown as HTMLElement,
        subscriptionSource("source-a", "Alpha", "new-digest", 5),
      );
      expect(sameDigestParent.descendants("okf-reading-source-card__preview")[0]?.scrollTop)
        .toBe(175);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("loads 50+ Reading items in bounded pages, deduplicates overlap, and single-flights scrolls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    try {
      const source = subscriptionSource("source-many", "Many Weekly", "digest-many", 55);
      const secondPage = deferred<FeedSubscriptionSourceItemsPage>();
      const loadItems = vi.fn((
        _sourceId: string,
        query: { limit?: number; cursor?: string } = {},
      ) => {
        if (!query.cursor) return Promise.resolve(subscriptionSourceItemsPage(source, 0, 40));
        const overlapping = subscriptionSourceItemsPage(source, 39, 40);
        return secondPage.promise.then(() => overlapping);
      });
      const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
      const view = new OkfDashboardView(leaf, {
        getDashboardUiState: () => normalizeDashboardUiState(undefined),
        feedReadingPosition: () => undefined,
        feedDecisionSnapshot: () => undefined,
        openFeedItem: vi.fn(async () => undefined),
        rememberFeedReadingPosition: vi.fn(async () => undefined),
        loadFeedSubscriptionSourceItems: loadItems,
        updateDashboardReadingSourceUiState: vi.fn(() => undefined),
      } as never);
      enableLatestItemsPagination(view);
      const runtime = view as unknown as {
        renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
      };
      const parent = new TestElement();

      runtime.renderSubscriptionSourceCard(parent as unknown as HTMLElement, source);
      await vi.advanceTimersByTimeAsync(0);
      expect(parent.descendants("okf-feed-digest__item")).toHaveLength(40);
      expect(loadItems).toHaveBeenCalledTimes(1);
      expect(loadItems).toHaveBeenNthCalledWith(1, "source-many", { limit: 40 });

      const body = parent.descendants("okf-reading-source-card__preview")[0]!;
      Object.assign(body, { clientHeight: 400, scrollHeight: 2_000, scrollTop: 1_500 });
      body.dispatch("scroll");
      body.dispatch("scroll");
      expect(loadItems).toHaveBeenCalledTimes(2);
      expect(loadItems).toHaveBeenNthCalledWith(2, "source-many", {
        limit: 40,
        cursor: "cursor-40",
      });

      secondPage.resolve(subscriptionSourceItemsPage(source, 39, 40));
      await vi.advanceTimersByTimeAsync(0);
      const items = parent.descendants("okf-feed-digest__item");
      expect(items).toHaveLength(55);
      expect(new Set(items.map((item) => item.children[0]?.textContent)).size).toBe(55);
      expect(loadItems).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("discards a late latest-item response after the source digest changes", async () => {
    const oldPage = deferred<FeedSubscriptionSourceItemsPage>();
    const oldSource = subscriptionSource("source-race", "Race", "digest-old", 5);
    const newSource = subscriptionSource("source-race", "Race", "digest-new", 5);
    const loadItems = vi.fn((_sourceId: string) =>
      loadItems.mock.calls.length === 1
        ? oldPage.promise
        : Promise.resolve(subscriptionSourceItemsPage(newSource)),
    );
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      loadFeedSubscriptionSourceItems: loadItems,
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
    } as never);
    enableLatestItemsPagination(view);
    const runtime = view as unknown as {
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
      readingSourceItems: Map<string, { digestId: string; items: Array<{ item_id: string }> }>;
    };
    const oldParent = new TestElement();
    const newParent = new TestElement();

    runtime.renderSubscriptionSourceCard(oldParent as unknown as HTMLElement, oldSource);
    runtime.renderSubscriptionSourceCard(newParent as unknown as HTMLElement, newSource);
    oldPage.resolve(subscriptionSourceItemsPage(oldSource));
    await oldPage.promise;
    await vi.waitFor(() => {
      expect(newParent.descendants("okf-feed-digest__item")).toHaveLength(5);
    });
    expect(runtime.readingSourceItems.get("source-race")?.digestId).toBe("digest-new");
    expect(runtime.readingSourceItems.get("source-race")?.items[0]?.item_id)
      .toContain("digest-new");

    await Promise.resolve();
    expect(newParent.descendants("okf-feed-digest__item")).toHaveLength(5);
    expect(runtime.readingSourceItems.get("source-race")?.digestId).toBe("digest-new");
    expect(runtime.readingSourceItems.get("source-race")?.items[0]?.item_id)
      .toContain("digest-new");
  });

  it("keeps the bounded preview when latest-item loading fails and retries in place", async () => {
    const source = subscriptionSource("source-retry", "Retry", "digest-retry", 5);
    const loadItems = vi.fn(() =>
      loadItems.mock.calls.length === 1
        ? Promise.reject(new Error("暂时离线"))
        : Promise.resolve(subscriptionSourceItemsPage(source)),
    );
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      loadFeedSubscriptionSourceItems: loadItems,
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
    } as never);
    enableLatestItemsPagination(view);
    const runtime = view as unknown as {
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
    };
    const parent = new TestElement();

    runtime.renderSubscriptionSourceCard(parent as unknown as HTMLElement, source);
    await vi.waitFor(() => {
      expect(parent.descendants().some((item) => item.textContent === "重试加载")).toBe(true);
    });
    expect(parent.descendants("okf-feed-digest__item")).toHaveLength(3);
    expect(parent.descendants().some((item) => item.textContent === "暂时离线")).toBe(true);

    parent.descendants().find((item) => item.textContent === "重试加载")?.click();
    await vi.waitFor(() => {
      expect(parent.descendants("okf-feed-digest__item")).toHaveLength(5);
    });
    expect(loadItems).toHaveBeenCalledTimes(2);
  });

  it("updates every rerendered card that shares an in-flight latest-items request", async () => {
    const source = subscriptionSource("source-shared", "Shared", "digest-shared", 5);
    const pending = deferred<FeedSubscriptionSourceItemsPage>();
    const loadItems = vi.fn(() => pending.promise);
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      loadFeedSubscriptionSourceItems: loadItems,
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
    } as never);
    enableLatestItemsPagination(view);
    const runtime = view as unknown as {
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
    };
    const first = new TestElement();
    const rerendered = new TestElement();

    runtime.renderSubscriptionSourceCard(first as unknown as HTMLElement, source);
    runtime.renderSubscriptionSourceCard(rerendered as unknown as HTMLElement, source);
    expect(loadItems).toHaveBeenCalledTimes(1);
    expect(rerendered.descendants().some((item) => item.textContent.includes("正在加载")))
      .toBe(true);

    pending.resolve(subscriptionSourceItemsPage(source));
    await vi.waitFor(() => {
      expect(rerendered.descendants("okf-feed-digest__item")).toHaveLength(5);
    });
    expect(first.descendants("okf-feed-digest__item")).toHaveLength(5);
  });

  it("replaces a latest-items state when its revision changes without digest or count changes", async () => {
    const oldSource = subscriptionSource("source-revision", "Old", "same-digest", 5);
    oldSource.latest_revision = "revision-1";
    const newSource = subscriptionSource("source-revision", "New", "same-digest", 5);
    newSource.latest_revision = "revision-2";
    const oldPage = deferred<FeedSubscriptionSourceItemsPage>();
    const loadItems = vi.fn(() =>
      loadItems.mock.calls.length === 1
        ? oldPage.promise
        : Promise.resolve(subscriptionSourceItemsPage(newSource))
    );
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      loadFeedSubscriptionSourceItems: loadItems,
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
    } as never);
    enableLatestItemsPagination(view);
    const runtime = view as unknown as {
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
      readingSourceItems: Map<string, {
        revision: string;
        items: Array<{ title: string }>;
      }>;
    };
    const oldParent = new TestElement();
    const newParent = new TestElement();

    runtime.renderSubscriptionSourceCard(oldParent as unknown as HTMLElement, oldSource);
    runtime.renderSubscriptionSourceCard(newParent as unknown as HTMLElement, newSource);
    oldPage.resolve(subscriptionSourceItemsPage(oldSource));
    await vi.waitFor(() => {
      expect(newParent.descendants("okf-feed-digest__item")).toHaveLength(5);
    });

    expect(loadItems).toHaveBeenCalledTimes(2);
    expect(runtime.readingSourceItems.get("source-revision")?.revision).toBe("revision-2");
    expect(runtime.readingSourceItems.get("source-revision")?.items[0]?.title).toContain("New");
  });

  it("keeps an old Engine on bounded previews without calling the unsupported endpoint", async () => {
    const source = subscriptionSource("source-legacy", "Legacy", "digest-legacy", 5);
    const loadItems = vi.fn(async () => subscriptionSourceItemsPage(source));
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      loadFeedSubscriptionSources: vi.fn(async (): Promise<FeedSubscriptionSourcePage> => ({
        section: "learning",
        sources: [source],
        total_sources: 1,
        matched_sources: 1,
        next_cursor: null,
        has_more: false,
      })),
      loadFeedSubscriptionSourceItems: loadItems,
      feedProjectionVersion: () => 0,
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
    };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, plugin as never);
    const runtime = view as unknown as {
      loadAndCommitSubscriptionSourceFirstPage: (
        projectionVersion: number,
        query: string,
      ) => Promise<boolean>;
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
      subscriptionLatestItemsPagination: boolean;
    };

    await runtime.loadAndCommitSubscriptionSourceFirstPage(0, "");
    const parent = new TestElement();
    runtime.renderSubscriptionSourceCard(parent as unknown as HTMLElement, source);
    await Promise.resolve();

    expect(runtime.subscriptionLatestItemsPagination).toBe(false);
    expect(loadItems).not.toHaveBeenCalled();
    expect(parent.descendants("okf-feed-digest__item")).toHaveLength(3);
  });

  it("degrades the whole view once after a mixed-version latest-items 404", async () => {
    const loadItems = vi.fn(async () => {
      throw new FeedHttpError(404, "not found");
    });
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      loadFeedSubscriptionSourceItems: loadItems,
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
    } as never);
    enableLatestItemsPagination(view);
    const refreshOverview = vi.fn();
    const runtime = view as unknown as {
      section: string;
      subscriptionSourcesLoadedAt: number;
      subscriptionLatestItemsPagination: boolean;
      readingSourceItemsEndpointDisabled: boolean;
      scheduleExternalRefresh: () => void;
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
    };
    runtime.section = "reading";
    runtime.subscriptionSourcesLoadedAt = 123;
    runtime.scheduleExternalRefresh = refreshOverview;
    const parent = new TestElement();

    for (let index = 0; index < 3; index += 1) {
      runtime.renderSubscriptionSourceCard(
        parent as unknown as HTMLElement,
        subscriptionSource(`source-404-${index}`, `Missing ${index}`, `digest-404-${index}`, 5),
      );
    }
    await vi.waitFor(() => expect(runtime.readingSourceItemsEndpointDisabled).toBe(true));

    expect(loadItems).toHaveBeenCalledTimes(1);
    expect(runtime.subscriptionLatestItemsPagination).toBe(false);
    expect(runtime.subscriptionSourcesLoadedAt).toBe(0);
    expect(refreshOverview).toHaveBeenCalledTimes(1);
    expect(parent.descendants("okf-feed-digest__item")).toHaveLength(9);
    expect(parent.descendants().some((item) => item.textContent === "重试加载")).toBe(false);
  });

  it("recovers one stale Reading cursor by restarting the latest edition from page one", async () => {
    const source = subscriptionSource("source-stale", "Stale", "digest-stale", 55);
    const loadItems = vi.fn((
      _sourceId: string,
      query: { limit?: number; cursor?: string } = {},
    ) => {
      if (loadItems.mock.calls.length === 1) {
        return Promise.resolve(subscriptionSourceItemsPage(source, 0, 40));
      }
      if (query.cursor) return Promise.reject(new FeedHttpError(400, "stale cursor"));
      return Promise.resolve(subscriptionSourceItemsPage(source, 0, 40));
    });
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      loadFeedSubscriptionSourceItems: loadItems,
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
    } as never);
    enableLatestItemsPagination(view);
    const runtime = view as unknown as {
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
    };
    const parent = new TestElement();

    runtime.renderSubscriptionSourceCard(parent as unknown as HTMLElement, source);
    await vi.waitFor(() => {
      expect(parent.descendants("okf-feed-digest__item")).toHaveLength(40);
    });
    const body = parent.descendants("okf-reading-source-card__preview")[0]!;
    Object.assign(body, { clientHeight: 400, scrollHeight: 2_000, scrollTop: 1_500 });
    vi.stubGlobal("window", globalThis);
    try {
      body.dispatch("scroll");
      await vi.waitFor(() => expect(loadItems).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => {
        expect(parent.descendants("okf-feed-digest__item")).toHaveLength(40);
      });

      expect(loadItems.mock.calls.map((call) => call[1])).toEqual([
        { limit: 40 },
        { limit: 40, cursor: "cursor-40" },
        { limit: 40 },
      ]);
      expect(body.scrollTop).toBe(0);
      expect(parent.descendants().some((item) => item.textContent === "重试加载")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("limits latest-item requests to four globally after the compatibility probe", async () => {
    const probeSource = subscriptionSource("source-probe", "Probe", "digest-probe", 5);
    const probe = deferred<FeedSubscriptionSourceItemsPage>();
    const pending = new Map<string, ReturnType<typeof deferred<FeedSubscriptionSourceItemsPage>>>();
    let active = 0;
    let maximumActive = 0;
    const loadItems = vi.fn((sourceId: string) => {
      if (sourceId === probeSource.source_id) return probe.promise;
      const request = pending.get(sourceId);
      if (!request) throw new Error(`missing deferred request for ${sourceId}`);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return request.promise.finally(() => {
        active -= 1;
      });
    });
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      loadFeedSubscriptionSourceItems: loadItems,
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
    } as never);
    enableLatestItemsPagination(view);
    const runtime = view as unknown as {
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
    };
    runtime.renderSubscriptionSourceCard(new TestElement() as unknown as HTMLElement, probeSource);
    probe.resolve(subscriptionSourceItemsPage(probeSource));
    await vi.waitFor(() => expect(loadItems).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    const sources = Array.from({ length: 8 }, (_value, index) =>
      subscriptionSource(`source-limit-${index}`, `Limit ${index}`, `digest-limit-${index}`, 5)
    );
    for (const source of sources) {
      pending.set(source.source_id, deferred<FeedSubscriptionSourceItemsPage>());
      runtime.renderSubscriptionSourceCard(new TestElement() as unknown as HTMLElement, source);
    }
    expect(active).toBe(4);
    expect(maximumActive).toBe(4);

    pending.get(sources[0]!.source_id)?.resolve(subscriptionSourceItemsPage(sources[0]!));
    await vi.waitFor(() => expect(loadItems).toHaveBeenCalledTimes(6));
    expect(active).toBe(4);
    for (const source of sources.slice(1)) {
      pending.get(source.source_id)?.resolve(subscriptionSourceItemsPage(source));
    }
    await vi.waitFor(() => expect(active).toBe(0));
    expect(maximumActive).toBe(4);
  });

  it("keeps latest-item and scroll caches aligned to the 32 most recent Reading sources", () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
    } as never);
    const runtime = view as unknown as {
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
      readingSourceItems: Map<string, unknown>;
      readingSourceScroll: Map<string, number>;
      readingSourceScrollDigest: Map<string, string>;
    };

    for (let index = 0; index < 33; index += 1) {
      runtime.renderSubscriptionSourceCard(
        new TestElement() as unknown as HTMLElement,
        subscriptionSource(`source-lru-${index}`, `LRU ${index}`, `digest-lru-${index}`),
      );
    }

    expect(runtime.readingSourceItems.size).toBe(32);
    expect(runtime.readingSourceScroll.size).toBe(32);
    expect(runtime.readingSourceScrollDigest.size).toBe(32);
    expect(runtime.readingSourceItems.has("source-lru-0")).toBe(false);
    expect(runtime.readingSourceScroll.has("source-lru-0")).toBe(false);
    expect(runtime.readingSourceItems.has("source-lru-32")).toBe(true);
    expect(runtime.readingSourceScroll.has("source-lru-32")).toBe(true);
  });

  it("rehydrates an evicted in-flight card and completes it when the old card is scrolled", async () => {
    const sources = Array.from({ length: 33 }, (_value, index) =>
      subscriptionSource(`source-rehydrate-${index}`, `Rehydrate ${index}`, `digest-rehydrate-${index}`, 5)
    );
    const firstRequest = deferred<FeedSubscriptionSourceItemsPage>();
    const loadItems = vi.fn((sourceId: string) => {
      if (sourceId === sources[0]!.source_id && loadItems.mock.calls.length === 1) {
        return firstRequest.promise;
      }
      const source = sources.find((candidate) => candidate.source_id === sourceId);
      if (!source) throw new Error(`unknown source ${sourceId}`);
      return Promise.resolve(subscriptionSourceItemsPage(source));
    });
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      loadFeedSubscriptionSourceItems: loadItems,
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
    } as never);
    enableLatestItemsPagination(view);
    const runtime = view as unknown as {
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
      readingSourceItems: Map<string, unknown>;
      readingSourceScroll: Map<string, number>;
    };
    const parents = sources.map(() => new TestElement());
    for (const [index, source] of sources.entries()) {
      runtime.renderSubscriptionSourceCard(parents[index]! as unknown as HTMLElement, source);
    }
    expect(runtime.readingSourceItems.has(sources[0]!.source_id)).toBe(false);
    expect(loadItems).toHaveBeenCalledTimes(1);

    const firstBody = parents[0]!.descendants("okf-reading-source-card__preview")[0]!;
    Object.assign(firstBody, { clientHeight: 400, scrollHeight: 2_000, scrollTop: 1_500 });
    vi.stubGlobal("window", globalThis);
    try {
      firstBody.dispatch("scroll");
      expect(runtime.readingSourceItems.has(sources[0]!.source_id)).toBe(true);
      expect(runtime.readingSourceScroll.has(sources[0]!.source_id)).toBe(true);
      firstRequest.resolve(subscriptionSourceItemsPage(sources[0]!));
      await vi.waitFor(() => {
        expect(parents[0]!.descendants("okf-feed-digest__item")).toHaveLength(5);
      });

      expect(loadItems.mock.calls.filter((call) => call[0] === sources[0]!.source_id))
        .toHaveLength(2);
      expect(parents[0]!.descendants().some((item) => item.textContent.includes("正在加载")))
        .toBe(false);
      expect(runtime.readingSourceItems.size).toBe(32);
      expect(runtime.readingSourceScroll.size).toBe(32);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels queued latest-item requests and discards the active response on close", async () => {
    const sources = Array.from({ length: 3 }, (_value, index) =>
      subscriptionSource(`source-close-${index}`, `Close ${index}`, `digest-close-${index}`, 5)
    );
    const active = deferred<FeedSubscriptionSourceItemsPage>();
    const loadItems = vi.fn(() => active.promise);
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedReadingPosition: () => undefined,
      feedDecisionSnapshot: () => undefined,
      openFeedItem: vi.fn(async () => undefined),
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      loadFeedSubscriptionSourceItems: loadItems,
      updateDashboardReadingSourceUiState: vi.fn(() => undefined),
      updateDashboardFeedUiState: vi.fn(() => undefined),
      updateDashboardPageUiState: vi.fn(() => undefined),
    } as never);
    enableLatestItemsPagination(view);
    const runtime = view as unknown as {
      renderSubscriptionSourceCard: (parent: HTMLElement, value: FeedSubscriptionSource) => void;
      readingSourceItems: Map<string, unknown>;
      readingSourceItemsRequestQueue: unknown[];
      readingSourceItemsActiveRequests: number;
      readingSourceItemsRequestsCancelled: boolean;
    };
    const parents = sources.map(() => new TestElement());
    for (const [index, source] of sources.entries()) {
      runtime.renderSubscriptionSourceCard(parents[index]! as unknown as HTMLElement, source);
    }
    expect(loadItems).toHaveBeenCalledTimes(1);
    expect(runtime.readingSourceItemsRequestQueue).toHaveLength(2);

    vi.stubGlobal("window", globalThis);
    try {
      await view.onClose();
      expect(runtime.readingSourceItemsRequestsCancelled).toBe(true);
      expect(runtime.readingSourceItemsRequestQueue).toHaveLength(0);
      expect(runtime.readingSourceItems.size).toBe(0);

      active.resolve(subscriptionSourceItemsPage(sources[0]!));
      await vi.waitFor(() => expect(runtime.readingSourceItemsActiveRequests).toBe(0));
      expect(loadItems).toHaveBeenCalledTimes(1);
      expect(parents[0]!.descendants("okf-feed-digest__item")).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
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
      latest_items_pagination: true,
      sources: [{
        ...source,
        pending_decision_count: Math.max(0, 5 - projectionVersion),
      }],
      total_sources: 10,
      matched_sources: 10,
      next_cursor: null,
      has_more: false,
    }));
    const promptAddFeedSubscription = vi.fn();
    const papersBase = feedEdition("papers", "papers-2026-08-24", "2026-08-24");
    const papers = {
      ...papersBase,
      title: "AI 论文周刊",
      item_count: 2,
      items: [
        papersBase.items[0]!,
        {
          ...papersBase.items[0]!,
          item_id: "papers-2026-08-24:2",
          block_id: "papers-2026-08-24-2",
          title: "第二篇论文",
        },
      ],
    };
    const feedDigest = { ai_daily: [], ai_papers: papers, treehole: null };
    const plugin = {
      getDashboardUiState: () => state,
      semanticOperationsSnapshot: () => [],
      conversionSnapshot: () => [],
      loadFeedSubscriptions,
      loadFeedSubscriptionSources,
      loadFeedSubscriptionSourceItems: vi.fn(async () => subscriptionSourceItemsPage(source)),
      feedProjectionVersion: () => projectionVersion,
      feedDecisionSnapshot: (_feed: string, itemId: string) => decisions.get(itemId),
      feedReadingPosition: () => undefined,
      openFeedItem,
      rememberFeedReadingPosition: vi.fn(async () => undefined),
      openFeedDigest: vi.fn(async () => undefined),
      ensureLocalServiceAvailable: vi.fn(async () => undefined),
      promptAddFeedSubscription,
      feedDashboardDigestSnapshot: () => feedDigest,
      loadFeedDashboardDigest: vi.fn(async () => feedDigest),
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
      "今天",
      "待处理",
      "订阅阅读",
      "学习",
      "项目",
      "知识库",
      "生活",
    ]);
    expect(loadFeedSubscriptionSources).toHaveBeenNthCalledWith(1, { limit: 8 });
    expect(root.descendants("okf-reading-source-card")).toHaveLength(1);
    expect(root.descendants("okf-feed-card")).toHaveLength(2);
    expect(root.descendants("okf-feed-card__body")).toHaveLength(2);
    expect(root.descendants("okf-feed-card__footer")).toHaveLength(2);
    const papersShelf = root.descendants("okf-reading-papers")[0]!;
    const sourceGrid = root.descendants("okf-reading-source-grid")[0]!;
    expect(papersShelf.parentElement?.children.indexOf(papersShelf)).toBeLessThan(
      sourceGrid.parentElement!.children.indexOf(sourceGrid),
    );
    expect(root.descendants("okf-feed-project--papers")).toHaveLength(1);
    expect(papersShelf.descendants("okf-feed-digest__item")).toHaveLength(2);
    expect(papersShelf.descendants().some((item) => item.textContent === "停用")).toBe(false);
    expect(papersShelf.descendants().some((item) => item.textContent === "移除")).toBe(false);
    expect(root.descendants("okf-reading-source-search")).toHaveLength(1);
    root.descendants().find((item) => item.textContent === "添加订阅")?.click();
    expect(promptAddFeedSubscription).toHaveBeenCalledOnce();
    expect(root.descendants("okf-reading-source-card__sections")[0]?.children.map((item) => item.textContent))
      .toEqual(["工具 3", "文章 2", "资源 2", "其他 2 类"]);
    const sourceItems = (): TestElement[] => sourceGrid.descendants("okf-feed-digest__item");
    await vi.waitFor(() => expect(sourceItems()).toHaveLength(5));
    expect(root.descendants("okf-reading-source-card")[0]?.hasClass("okf-feed-card--scrollable"))
      .toBe(true);
    expect(root.descendants("okf-reading-source-card__preview")[0]?.dataset.sourceId)
      .toBe("source-a");
    expect(root.descendants("okf-dashboard__feed-warning")[0]?.textContent)
      .toBe("采集不完整：部分内容缺失");
    expect(sourceItems().every((item) => item.hasClass("is-compact"))).toBe(true);
    const firstPreviewMetadata = sourceItems()[0]?.children
      .find((item) => item.hasClass("okf-dashboard__muted"))?.textContent;
    expect(firstPreviewMetadata).toBe("工具");

    sourceItems()[0]?.click();
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
      .toContain("已选择整理为知识笔记");
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
    const papers = feedEdition("papers", "papers", "2026-08-22");
    const treehole = {
      ...feedEdition("learning", "treehole", "2026-08-22"),
      section: null,
    };
    const digest = { ai_daily: [hotspot, news, learning], ai_papers: papers, treehole };
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
    expect(container.descendants().some((item) => item.textContent === "打开本期汇总")).toBe(true);

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
      "待处理",
      "待生成学习笔记",
      "待生成知识笔记",
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
    expect(feedDecisionLabel("learn-now")).toBe("已选择学习");
    expect(feedDecisionLabel("wiki-now")).toBe("已选择整理为知识笔记");
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
      "记录项目决策",
      "用 AI 整理项目",
    ]);
    expect(PROJECT_ACTION_PANEL_LABELS).not.toContain("记录关键点");
  });

  it("renders a compact Project row with one current action and one explicit action panel", async () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const promptProjectProgress = vi.fn();
    const promptCapture = vi.fn();
    const openDocumentImport = vi.fn();
    const openVaultPath = vi.fn(async () => undefined);
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      promptProject: () => undefined,
      openDocumentImport,
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
            title: "个人知识库",
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
            open_tasks: [],
          }],
        }),
      },
    });
    const container = new TestElement();

    await runtime.renderProjects(container as unknown as HTMLElement);

    const row = container.descendants("okf-project-row")[0];
    const actions = row?.descendants("okf-work-item__actions")[0];
    expect(actions?.children.map((child) => child.textContent)).toEqual(["记录进展", "添加资料 · 可拖入文件夹", "其他操作 ▾"]);
    actions?.children[0]?.click();
    expect(promptProjectProgress).toHaveBeenCalledWith("projects/workspace/project.md");
    expect(panels).toHaveLength(1);
    expect(panels[0]?.label).toBe("其他操作 · 个人知识库");
    expect(panels[0]?.actions.map((action) => action.title)).toEqual(PROJECT_ACTION_PANEL_LABELS);
    expect(row?.descendants("okf-work-item__metric").map((item) => item.textContent)).toEqual([
      "待整理 0",
      "学习笔记 0",
      "资料 0",
    ]);

    await panels[0]?.actions[0]?.onSelect();
    await panels[0]?.actions[1]?.onSelect();
    await panels[0]?.actions[2]?.onSelect();
    expect(promptCapture).toHaveBeenCalledWith({ project: "projects/workspace/project.md" });
    expect(openDocumentImport).toHaveBeenCalledWith([], { project: "workspace" }, "context");
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

  it("opens the exact related note from Project statistics without moving primary actions", async () => {
    const openVaultPath = vi.fn(async () => undefined);
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, { getDashboardUiState: () => normalizeDashboardUiState(undefined), openVaultPath } as never);
    const runtime = view as unknown as { renderProjectWorkItem: (container: HTMLElement, value: ProjectSummary) => void; attachActionPanel: () => void };
    runtime.attachActionPanel = () => undefined;
    const value = project();
    value.pending_captures = [note({ path: "inbox/captures/exact.md", title: "待整理想法" })];
    value.related_materials = [note({ path: "sources/a.md", title: "资料 A" }), note({ path: "sources/b.md", title: "资料 B" })];
    const root = new TestElement(); runtime.renderProjectWorkItem(root as unknown as HTMLElement, value);
    root.descendants("okf-work-item__metric")[0]!.click();
    expect(openVaultPath).toHaveBeenCalledWith("inbox/captures/exact.md");
    root.descendants("okf-work-item__metric")[2]!.click();
    const list = root.descendants("okf-work-item__related")[0]!;
    expect(list.children.map((entry) => entry.textContent)).toEqual(["资料 A", "资料 B"]);
    list.children[1]!.click(); expect(openVaultPath).toHaveBeenCalledWith("sources/b.md");
    expect(root.descendants("okf-work-item__actions")[0]!.children.map((entry) => entry.textContent)).toEqual(["记录进展", "添加资料 · 可拖入文件夹", "其他操作 ▾"]);
  });

  it("inherits the selected Course when importing and creating a Lesson from Learning", async () => {
    const coursePath = "learning/courses/algebra/course.md";
    const selectedCourse = { ...note({ path: coursePath, title: "Algebra", note_type: "Course" }),
      course_status: "active", current_progress: "", guide_count: 0, lesson_count: 0, related_sources: [], pending_captures: [] };
    const openDocumentImport = vi.fn(); const promptLessonForCourse = vi.fn();
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, { getDashboardUiState: () => normalizeDashboardUiState({
      pages: { learning: { filters: { context: "course", relation: coursePath } } } }),
      semanticOperationsSnapshot: () => [], openDocumentImport, promptLessonForCourse } as never);
    const runtime = view as unknown as { renderLearning: (el: HTMLElement) => Promise<void>; attachActionPanel: () => void; vaultReader: unknown };
    runtime.attachActionPanel = () => undefined;
    runtime.vaultReader = { learning: async () => ({ pending_guides: [], ready_guides: [], completed_guides: [], courses: [selectedCourse], projects: [] }) };
    const root = new TestElement(); await runtime.renderLearning(root as unknown as HTMLElement);
    root.descendants().find((entry) => entry.textContent === "导入学习资料")!.click();
    root.descendants().find((entry) => entry.textContent === "新建课堂笔记")!.click();
    expect(openDocumentImport).toHaveBeenCalledWith([], { course: "algebra" }, "learning");
    expect(promptLessonForCourse).toHaveBeenCalledWith(coursePath);
    expect(root.descendants("okf-course-work-item")[0]?.descendants("okf-work-item__actions")[0]?.children.map((entry) => entry.textContent)).toEqual(["新建课堂笔记", "添加资料 · 可拖入文件夹", "其他操作 ▾"]);
  });

  it("keeps cached Daily and Papers items visible while making a refresh failure actionable", async () => {
    const digest = { ai_daily: [feedEdition("news", "news", "2026-09-08")], ai_papers: feedEdition("papers", "papers", "2026-09-08"), treehole: null };
    const load = vi.fn(async () => { throw new Error("工作区本地服务缺少 Python 或部署配置路径"); });
    const openPluginSettings = vi.fn();
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, { getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedDashboardDigestSnapshot: () => digest, loadFeedDashboardDigest: load,
      feedDecisionSnapshot: () => undefined, feedReadingPosition: () => undefined,
      updateDashboardFeedUiState: () => undefined, openPluginSettings } as never);
    const runtime = view as unknown as { renderDailyFeeds: (el: HTMLElement) => void; renderReadingPapers: (el: HTMLElement) => void };
    const root = new TestElement(); runtime.renderDailyFeeds(root as unknown as HTMLElement); runtime.renderReadingPapers(root as unknown as HTMLElement);
    await vi.waitFor(() => expect(root.descendants("okf-dashboard__error")).toHaveLength(2));
    expect(root.descendants("okf-feed-digest__item")).toHaveLength(2);
    expect(root.descendants("okf-dashboard__error").every((entry) => entry.textContent.includes("保留上次内容"))).toBe(true);
    expect(root.descendants().filter((entry) => entry.textContent === "配置本地服务")).toHaveLength(2);
    root.descendants().find((entry) => entry.textContent === "配置本地服务")!.click();
    expect(openPluginSettings).toHaveBeenCalledTimes(1);
    root.descendants().find((entry) => entry.textContent === "重新读取")!.click();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  });

  it("updates Papers health even when the digest identity has not changed", async () => {
    const edition = feedEdition("papers", "same-id", "2026-09-08");
    const digest = { ai_daily: [], ai_papers: edition, treehole: null };
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, { getDashboardUiState: () => normalizeDashboardUiState(undefined),
      feedDashboardDigestSnapshot: () => digest, loadFeedDashboardDigest: async () => ({ ...digest,
        stream_health: { papers: { status: "error", message: "producer unavailable", last_success_at: null, last_error_at: "2026-09-08" } } }),
      feedDecisionSnapshot: () => undefined, feedReadingPosition: () => undefined, updateDashboardFeedUiState: () => undefined } as never);
    const runtime = view as unknown as { renderReadingPapers: (el: HTMLElement) => void };
    const root = new TestElement(); runtime.renderReadingPapers(root as unknown as HTMLElement);
    await vi.waitFor(() => expect(root.descendants("okf-dashboard__error")[0]?.textContent).toContain("producer unavailable"));
    expect(root.descendants("okf-feed-digest__item")).toHaveLength(1);
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
      ["补充要求后生成"],
      ["补充要求后生成"],
      ["用 AI 完善", "与 AI 讨论", "标记完成"],
      ["用 AI 完善", "与 AI 讨论", "取消完成", "整理为知识笔记"],
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
      .toEqual(["正在生成内容", "其他操作 ▾"]);
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

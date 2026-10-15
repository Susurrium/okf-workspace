import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DashboardUiStateStore,
  createDefaultDashboardUiState,
  isContinuationMarkdownPath,
  normalizeDashboardUiState,
  patchDashboardUiState,
  recordRecentDashboardFile,
} from "../src/plugin/dashboard-ui-state.js";

describe("Dashboard UI state", () => {
  it("creates a complete default for every page and independent feed surface", () => {
    const state = createDefaultDashboardUiState();

    expect(state.activeSection).toBe("today");
    expect(Object.keys(state.pages)).toEqual([
      "today",
      "tasks",
      "inbox",
      "reading",
      "sources",
      "learning",
      "projects",
      "knowledge",
      "life",
      "system",
    ]);
    expect(state.pages.learning).toEqual({ scrollTop: 0, filters: {} });
    expect(state.feeds).toEqual({
      "ai-daily": { scrollTop: 0 },
      "ai-daily-hotspot": { scrollTop: 0 },
      "ai-daily-news": { scrollTop: 0 },
      "ai-daily-learning": { scrollTop: 0 },
      "ai-daily-papers": { scrollTop: 0 },
      treehole: { scrollTop: 0 },
    });
    expect(state.readingSources).toEqual({});
  });

  it("keeps legacy task search when adding an independent Tasks page without coupling later Today edits", () => {
    const migrated = normalizeDashboardUiState({ pages: { today: { filters: { taskQuery: "报告" }, scrollTop: 40 } } });
    expect(migrated.pages.tasks.filters.taskQuery).toBe("报告");
    const changed = patchDashboardUiState(migrated, { pages: { today: { filters: { taskQuery: "新查询" } } } });
    expect(changed.pages.tasks.filters.taskQuery).toBe("报告");
  });

  it("migrates old feed reading positions and tolerates malformed settings", () => {
    const state = normalizeDashboardUiState(
      {
        activeSection: "learning",
        pages: {
          learning: {
            scrollTop: 82.5,
            tab: "active",
            filters: { course: "cs61a", complete: false, ignored: null },
          },
          inbox: { scrollTop: -20, filters: "invalid" },
        },
        feeds: { "ai-daily": { scrollTop: 310 } },
        recentFiles: [
          { path: "learning/guides/valid.md", openedAt: "2026-08-21T01:00:00Z" },
          { path: "system/contracts/wiki.yaml", openedAt: "2026-08-21T01:00:00Z" },
        ],
      },
      {
        "ai-daily": {
          editionId: "ai-2026-08-21",
          itemId: "item-4",
          updatedAt: "2026-08-21T02:00:00Z",
        },
        treehole: {
          editionId: "tree-2026-08-21",
          itemId: "8459000",
          updatedAt: "2026-08-21T02:10:00Z",
        },
      },
    );

    expect(state.activeSection).toBe("learning");
    expect(state.pages.learning).toEqual({
      scrollTop: 82.5,
      tab: "active",
      filters: { course: "cs61a", complete: false },
    });
    expect(state.pages.inbox.scrollTop).toBe(0);
    expect(state.feeds["ai-daily"]).toEqual({
      scrollTop: 310,
      editionId: "ai-2026-08-21",
      itemId: "item-4",
      updatedAt: "2026-08-21T02:00:00Z",
    });
    expect(state.feeds["ai-daily-hotspot"].scrollTop).toBe(310);
    expect(state.feeds["ai-daily-news"].scrollTop).toBe(310);
    expect(state.feeds["ai-daily-learning"].scrollTop).toBe(310);
    expect(state.feeds.treehole.itemId).toBe("8459000");
    expect(state.recentFiles).toEqual([
      { path: "learning/guides/valid.md", openedAt: "2026-08-21T01:00:00Z" },
    ]);
  });

  it("merges page filters, clears optional values, and keeps unrelated state", () => {
    const first = patchDashboardUiState(createDefaultDashboardUiState(), {
      activeSection: "knowledge",
      pages: {
        knowledge: {
          scrollTop: 450,
          tab: "wiki",
          filters: { query: "LiveSync", stale: true },
        },
      },
      feeds: {
        treehole: {
          scrollTop: 240,
          editionId: "tree-1",
          itemId: "42",
          updatedAt: "2026-08-21T02:00:00Z",
        },
      },
    });
    const second = patchDashboardUiState(first, {
      pages: {
        knowledge: { tab: null, filters: { query: null, topic: "backup" } },
      },
      feeds: { treehole: { scrollTop: 480 } },
    });

    expect(second.activeSection).toBe("knowledge");
    expect(second.pages.knowledge).toEqual({
      scrollTop: 450,
      filters: { stale: true, topic: "backup" },
    });
    expect(second.feeds.treehole).toEqual({
      scrollTop: 480,
      editionId: "tree-1",
      itemId: "42",
      updatedAt: "2026-08-21T02:00:00Z",
    });
  });

  it("keeps daily stream and subscription scroll positions independent", () => {
    const state = patchDashboardUiState(createDefaultDashboardUiState(), {
      feeds: {
        "ai-daily-hotspot": { scrollTop: 120 },
        "ai-daily-news": { scrollTop: 240 },
        "ai-daily-learning": { scrollTop: 480 },
      },
    });

    expect(state.feeds["ai-daily-hotspot"].scrollTop).toBe(120);
    expect(state.feeds["ai-daily-news"].scrollTop).toBe(240);
    expect(state.feeds["ai-daily-learning"].scrollTop).toBe(480);
    expect(state.feeds["ai-daily"].scrollTop).toBe(0);
  });

  it("persists bounded per-source Reading scroll positions by digest", () => {
    let state = normalizeDashboardUiState({
      readingSources: {
        "source:kept": {
          digestId: "2026-08-23-learning",
          scrollTop: 180,
          updatedAt: "2026-08-23T02:00:00Z",
        },
        "source:invalid": { digestId: "", scrollTop: 999 },
      },
    });
    expect(state.readingSources).toEqual({
      "source:kept": {
        digestId: "2026-08-23-learning",
        scrollTop: 180,
        updatedAt: "2026-08-23T02:00:00Z",
      },
    });

    for (let index = 0; index < 35; index += 1) {
      state = patchDashboardUiState(state, {
        readingSources: {
          [`source:${index}`]: {
            digestId: `digest:${index}`,
            scrollTop: index,
            updatedAt: `2026-08-23T03:${String(index).padStart(2, "0")}:00Z`,
          },
        },
      });
    }
    expect(Object.keys(state.readingSources)).toHaveLength(32);
    expect(state.readingSources["source:34"]).toEqual({
      digestId: "digest:34",
      scrollTop: 34,
      updatedAt: "2026-08-23T03:34:00Z",
    });
    expect(state.readingSources["source:0"]).toBeUndefined();
  });

  it("persists the narrow Today pane and the Learning context independently", () => {
    const state = patchDashboardUiState(createDefaultDashboardUiState(), {
      pages: {
        today: { tab: "reading" },
        learning: { tab: "active", filters: { context: "project" } },
      },
    });
    const restored = normalizeDashboardUiState(state);

    expect(restored.pages.today.tab).toBe("reading");
    expect(restored.pages.learning.tab).toBe("active");
    expect(restored.pages.learning.filters.context).toBe("project");
  });

  it("restores Reading as a first-class page without disturbing older page state", () => {
    const state = normalizeDashboardUiState({
      activeSection: "reading",
      pages: { reading: { scrollTop: 640 } },
    });

    expect(state.activeSection).toBe("reading");
    expect(state.pages.reading).toEqual({ scrollTop: 640, filters: {} });
    expect(state.pages.inbox).toEqual({ scrollTop: 0, filters: {} });
  });

  it("records only real continuation Markdown paths", () => {
    for (const path of [
      "learning/guides/topic.md",
      "projects/workspace/log.md",
      "knowledge/wiki/livesync.md",
      "life/daily/2026/08/2026-08-21.md",
      "feeds/ai-daily/2026/today.md",
      "inbox/captures/2026/08/idea.md",
      "self/now.md",
    ]) {
      expect(isContinuationMarkdownPath(path), path).toBe(true);
    }
    for (const path of [
      "system/views/Learning.md",
      "archive/captures/old.md",
      "sources/text/web/raw.md",
      "sources/records/web/source.md",
      "AGENTS.md",
      "index.md",
      "learning/guides/index.md",
      "learning/guides/topic.pdf",
      ".agents/skills/private.md",
    ]) {
      expect(isContinuationMarkdownPath(path), path).toBe(false);
    }
  });

  it("deduplicates recent paths, updates their time, and caps the list at 50", () => {
    let state = createDefaultDashboardUiState();
    for (let index = 0; index < 55; index += 1) {
      state = recordRecentDashboardFile(
        state,
        `learning/guides/${index}.md`,
        `2026-08-21T01:${String(index).padStart(2, "0")}:00Z`,
      );
    }
    state = recordRecentDashboardFile(
      state,
      "learning\\guides\\20.md",
      "2026-08-21T03:00:00Z",
    );

    expect(state.recentFiles).toHaveLength(50);
    expect(state.recentFiles[0]).toEqual({
      path: "learning/guides/20.md",
      openedAt: "2026-08-21T03:00:00Z",
    });
    expect(state.recentFiles.filter((entry) => entry.path === "learning/guides/20.md")).toHaveLength(1);
    expect(state.recentFiles.some((entry) => entry.path === "learning/guides/0.md")).toBe(false);
  });
});

describe("DashboardUiStateStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces persistence and flushes the latest snapshot", async () => {
    const persisted: ReturnType<typeof createDefaultDashboardUiState>[] = [];
    const store = new DashboardUiStateStore(
      createDefaultDashboardUiState(),
      async (state) => {
        persisted.push(state);
      },
      300,
    );

    store.update({ activeSection: "inbox" });
    store.update({ pages: { inbox: { scrollTop: 125 } } });
    store.recordFile("learning/guides/example.md", "2026-08-21T02:00:00Z");

    expect(persisted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(299);
    expect(persisted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.activeSection).toBe("inbox");
    expect(persisted[0]?.pages.inbox.scrollTop).toBe(125);
    expect(persisted[0]?.recentFiles[0]?.path).toBe("learning/guides/example.md");
  });

  it("does not schedule writes for excluded file-open events", async () => {
    const persist = vi.fn(async () => undefined);
    const store = new DashboardUiStateStore(createDefaultDashboardUiState(), persist, 100);

    store.recordFile("sources/text/web/raw.md", "2026-08-21T02:00:00Z");
    await vi.advanceTimersByTimeAsync(500);

    expect(persist).not.toHaveBeenCalled();
  });
});

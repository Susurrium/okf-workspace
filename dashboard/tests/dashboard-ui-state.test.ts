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
  it("creates a complete default for every page and both feeds", () => {
    const state = createDefaultDashboardUiState();

    expect(state.activeSection).toBe("today");
    expect(Object.keys(state.pages)).toEqual([
      "today",
      "inbox",
      "learning",
      "projects",
      "knowledge",
      "life",
      "system",
    ]);
    expect(state.pages.learning).toEqual({ scrollTop: 0, filters: {} });
    expect(state.feeds).toEqual({
      "ai-daily": { scrollTop: 0 },
      treehole: { scrollTop: 0 },
    });
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

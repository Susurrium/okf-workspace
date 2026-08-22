import { TFile, WorkspaceLeaf, type App } from "obsidian";
import { describe, expect, it } from "vitest";

import {
  OkfDashboardView,
  OKF_DASHBOARD_VIEW,
  PROJECT_MENU_LABELS,
  resolveDashboardLearningSources,
  systemStatusLabel,
  treeholeMetadata,
} from "../src/plugin/dashboard-view.js";
import { normalizeDashboardUiState } from "../src/plugin/dashboard-ui-state.js";
import { Menu, TestElement } from "./obsidian-runtime.js";

describe("real Dashboard View source handoff", () => {
  it("constructs the registered runtime View rather than a legacy page model", () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const view = new OkfDashboardView(leaf, {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
    } as never);

    expect(view.getViewType()).toBe(OKF_DASHBOARD_VIEW);
    expect(view.getDisplayText()).toBe("Dashboard");
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

  it("translates implementation health states into human-facing System labels", () => {
    expect(systemStatusLabel("configured")).toBe("已配置");
    expect(systemStatusLabel("ok")).toBe("正常");
    expect(systemStatusLabel("deferred")).toBe("稍后配置");
    expect(systemStatusLabel("failed")).toBe("失败");
  });

  it("keeps the Project overflow menu short and action-oriented", () => {
    expect(PROJECT_MENU_LABELS).toEqual([
      "项目日志…",
      "记录待整理想法",
      "添加资料",
      "在 Claudian 中整理项目",
      "更改 Project 状态…",
    ]);
    expect(PROJECT_MENU_LABELS).not.toContain("记录关键点");
  });

  it("renders each Project row with only Open and overflow actions", async () => {
    const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({} as App);
    const plugin = {
      getDashboardUiState: () => normalizeDashboardUiState(undefined),
      promptProject: () => undefined,
      promptDocumentImport: () => undefined,
      promptProjectProgress: () => undefined,
      promptCapture: () => undefined,
      promptProjectStatus: () => undefined,
      updateDashboardPageUiState: () => undefined,
      openVaultPath: async () => undefined,
    };
    const view = new OkfDashboardView(leaf, plugin as never);
    const runtime = view as unknown as {
      vaultReader: { projects: () => Promise<unknown> };
      renderProjects: (container: HTMLElement) => Promise<void>;
    };
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
    const actions = row?.descendants("okf-dashboard__row-actions")[0];
    expect(actions?.children.map((child) => child.textContent)).toEqual(["打开", "…"]);
    actions?.children[1]?.click();
    expect(Menu.lastShownTitles).toEqual(PROJECT_MENU_LABELS);
  });
});

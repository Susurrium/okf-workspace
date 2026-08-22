import { TFile, WorkspaceLeaf, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  OkfDashboardView,
  OKF_DASHBOARD_VIEW,
  PROJECT_ACTION_PANEL_LABELS,
  projectStatusActions,
  resolveDashboardLearningSources,
  systemStatusLabel,
  treeholeMetadata,
} from "../src/plugin/dashboard-view.js";
import type { NoteSummary, ProjectSummary, SemanticOperationRecord } from "../src/api/types.js";
import { normalizeDashboardUiState } from "../src/plugin/dashboard-ui-state.js";
import type { AnchoredActionPanelOptions } from "../src/ui/anchored-action-panel.js";
import { TestElement } from "./obsidian-runtime.js";

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

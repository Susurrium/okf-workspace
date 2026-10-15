import { TFile, WorkspaceLeaf, type App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OkfDashboardView } from "../src/plugin/dashboard-view.js";
import { VaultDashboardReader } from "../src/plugin/vault-dashboard.js";
import { createDefaultDashboardUiState, normalizeDashboardUiState, patchDashboardUiState } from "../src/plugin/dashboard-ui-state.js";
import { readWorkbenchSectionConfig, noteMatchesSectionContext, workbenchInstanceKey } from "../src/features/workbench/section-config.js";
import { createOkfSurfaceSectionDefinitions } from "../src/features/workbench/okf-surface-sections.js";
import { buildInboxWorkQueue } from "../src/domain/inbox-work-queue.js";
import { conversionRecovery } from "../src/domain/operation-presentation.js";
import { generateWorkbenchPresetMarkdown } from "../src/features/workbench-presets.js";
import { parse } from "../apex/src/parser.js";
import { registerSectionDefinition } from "../apex/src/section-registry.js";
import { TestElement } from "./obsidian-runtime.js";
import type { NoteSummary } from "../src/api/types.js";
import { SectionConfigModal } from "../src/plugin/section-config-modal.js";
import { Notice } from "./obsidian-runtime.js";
import { getRecentDocs } from "../apex/src/recent.js";

const course = "learning/courses/a/course.md";
const project = "projects/b/project.md";
function vault(markdown: Record<string, string>): App {
  const files = Object.keys(markdown).map(path => new (TFile as unknown as new (path: string) => TFile)(path));
  for (const file of files) file.stat.size = markdown[file.path]!.length;
  return { vault: { getMarkdownFiles: () => files, getFiles: () => files,
    getAbstractFileByPath: (path: string) => files.find(file => file.path === path) ?? null,
    cachedRead: async (file: TFile) => markdown[file.path], read: async (file: TFile) => markdown[file.path],
    adapter: { stat: async (path: string) => markdown[path] ? { type: "file" } : null },
  }, metadataCache: { getFileCache: () => null } } as unknown as App;
}
const source = "sources/records/pdf/shared.md";
const sourceMarkdown = `---\ntype: Source\ntitle: 共享资料\ncreated_at: 2026-10-01\nresource: /sources/originals/${"0".repeat(64)}/shared.pdf\nkind: pdf\ntext: /sources/text/shared.md\nuses:\n  - purpose: undecided\n    project: /projects/a/project.md\n  - purpose: undecided\n    project: /${project}\n  - purpose: study\n    course: /${course}\n  - purpose: reference\n---\n`;

afterEach(() => vi.useRealTimers());

describe("workbench interaction contracts", () => {
  it("fills recent editing with visible notes while retaining standalone Apex behavior", () => {
    const app = vault({ "system/imports/a/request.md": "request", "system/imports/a/receipt.md": "receipt",
      "inbox/uploads/a.md": "upload", "knowledge/wiki/visible.md": "visible" });
    expect(getRecentDocs(app, 1, ["system/", "inbox/uploads/"]).map(item => item.path)).toEqual(["knowledge/wiki/visible.md"]);
    expect(getRecentDocs(app, 1).map(item => item.path)).toEqual(["system/imports/a/request.md"]);
  });
  it("retains configuration drafts and unknown fields after a failed asynchronous save", async () => {
    const save = vi.fn(async (_config: Record<string, unknown>): Promise<void> => { throw new Error("配置未写入"); });
    const modal = new SectionConfigModal(vault({}), { mode: "summary", limit: 3, future: { retained: true } }, save);
    modal.open();
    const root = modal.contentEl as unknown as TestElement;
    await vi.waitFor(() => expect(root.descendants().some(item => item.textContent === "保存")).toBe(true));
    const button = root.descendants().find(item => item.textContent === "保存")!;
    button.click();
    await vi.waitFor(() => expect(Notice.messages).toContain("配置未写入"));
    expect(button.disabled).toBe(false);
    expect(root.children.length).toBeGreaterThan(0);
    expect(save).toHaveBeenCalledWith({ pageSize: 3, future: { retained: true } });
    save.mockImplementationOnce(async () => undefined);
    button.click();
    await vi.waitFor(() => expect(root.children).toHaveLength(0));
  });
  it("retains distinct undecided uses and unique decision identities", async () => {
    const reader = new VaultDashboardReader(vault({ [source]: sourceMarkdown }));
    const queue = buildInboxWorkQueue(await reader.inbox(), []);
    expect(queue.decision).toHaveLength(2);
    expect(new Set(queue.decision.map(item => item.key)).size).toBe(2);
    expect(queue.decision.map(item => item.note.project)).toEqual(["/projects/a/project.md", `/${project}`]);
    expect((await reader.sources()).sources).toHaveLength(1);
  });

  it("keeps workbench instances independent while retaining global and legacy state", () => {
    const a = workbenchInstanceKey("工作台一", "learning");
    const b = workbenchInstanceKey("工作台二", "learning");
    const state = patchDashboardUiState(createDefaultDashboardUiState(), {
      pages: { learning: { tab: "completed" } },
      instances: { [a]: { tab: "pending", filters: { relation: course }, scrollTop: 42 },
        [b]: { tab: "active", filters: { relation: project }, scrollTop: 84 } },
    });
    const restored = normalizeDashboardUiState(state);
    expect(restored.pages.learning.tab).toBe("completed");
    expect(restored.instances?.[a]).toEqual({ tab: "pending", filters: { relation: course }, scrollTop: 42 });
    expect(restored.instances?.[b]).toEqual({ tab: "active", filters: { relation: project }, scrollTop: 84 });
  });

  it("requires both relations to match the same Source use and rejects invalid configuration", () => {
    const note: NoteSummary = { path: source, title: "资料", note_type: "Source", status: "stable", stale: false, excerpt: "",
      uses: [{ purpose: "study", course: `/${course}` }, { purpose: "reference", project: `/${project}` }] };
    expect(noteMatchesSectionContext(note, { course, project })).toBe(false);
    note.uses!.push({ purpose: "study", course: `/${course}`, project: `/${project}` });
    expect(noteMatchesSectionContext(note, { course, project })).toBe(true);
    expect(() => readWorkbenchSectionConfig({ course: "learning/courses/../course.md" })).toThrow("路径无效");
    expect(() => readWorkbenchSectionConfig({ mode: "unknown" })).toThrow("展示方式无效");
  });

  it("uses ordinary-note tasks for Today while excluding workbench checklists and separating overdue tasks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 12, 12));
    const reader = new VaultDashboardReader(vault({
      "dashboard.md": "---\ndashboard: true\n---\n- [ ] #task 工作台任务 [scheduled:: 2026-10-12] ^board-task",
      "projects/b/log.md": "- [ ] #task 日志任务 [due:: 2026-10-12] ^log-task",
      "self/tasks.md": "- [ ] #task 未来 [due:: 2026-10-13]\n- [ ] #task 无日期\n- [ ] #task 逾期 [due:: 2026-10-11]",
      ".dashboard-backup/board.md": "- [ ] #task 备份任务 [due:: 2026-10-12]",
    }));
    const today = await reader.today();
    expect(today.tasks.map(task => task.text)).toEqual(["日志任务"]);
    expect(today.overdue_tasks?.map(task => task.text)).toEqual(["逾期"]);
  });

  it("mounts actual column scope and keeps a daily-updates component distinct from subscription history", async () => {
    const mount = vi.fn(async () => () => undefined);
    const definitions = createOkfSurfaceSectionDefinitions({ mountOkfDashboardSurface: mount });
    const updates = definitions.find(item => item.type === "workspace-updates")!;
    await updates.render({ container: { addClass: vi.fn() }, column: { id: "updates", name: "更新", extensionConfig: { feedStreams: ["news"] } } } as never);
    expect(mount).toHaveBeenCalledWith(expect.anything(), "reading", {
      columnId: "updates", config: { readingView: "daily-updates", feedStreams: ["news"], scene: "daily-updates" },
    });
  });

  it("keeps tasks in a dual-linked Guide available in Project and Today scopes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 12, 12));
    const app = vault({
      [project]: "---\ntype: Project\ntitle: 项目 B\ncreated_at: 2026-10-01\nproject_status: active\n---\n<!-- ai:auto:start name=\"project-current-state\" -->\n<!-- ai:auto:end name=\"project-current-state\" -->",
      "learning/guides/shared.md": `---\ntype: Study Guide\ntitle: 练习\ncreated_at: 2026-10-01\ncourse: /${course}\nproject: /${project}\n---\n<!-- human:notes:start name=\"notes\" -->\n<!-- human:notes:end name=\"notes\" -->\n<!-- ai:auto:start name=\"study-material\" -->\n内容\n<!-- ai:auto:end name=\"study-material\" -->\n- [ ] #task 做练习 [scheduled:: 2026-10-12] ^practice`,
    });
    const reader = new VaultDashboardReader(app);
    expect((await reader.today()).tasks[0]).toMatchObject({ course: `/${course}`, project: `/${project}`, text: "做练习" });
    expect((await reader.projects()).projects[0]?.open_tasks[0]?.path).toBe("learning/guides/shared.md");
  });

  it("round trips a bound preset without copying object state or discarding configuration", () => {
    const unregister = createOkfSurfaceSectionDefinitions({ mountOkfDashboardSurface: vi.fn() })
      .map(registerSectionDefinition);
    try {
      const data = parse(generateWorkbenchPresetMarkdown("project", { project }));
      for (const column of data.columns.filter(item => item.sectionType?.startsWith("workspace-"))) {
        expect(column.extensionConfig?.project).toBe(project);
      }
      expect(data.quickActions.map(item => item.name)).toEqual(["快速记录", "新建待办", "全局搜索", "快捷操作"]);
      expect(data.hiddenPresets).toEqual(["p:daily-notes", "p:file-explorer:new-file"]);
    } finally { unregister.forEach(remove => remove()); }
  });

  it("distinguishes generation handoff, publication and converter recovery", () => {
    const record = { conversion_id: "one", source_filename: "one.pdf", intent: "learn", quality: "quick", parser: "mineru", outputs: {} };
    expect(conversionRecovery({ ...record, status: "imported", stages: { semantic: "failed" } })).toBe("generation");
    expect(conversionRecovery({ ...record, status: "failed", stages: { conversion: "completed", quality: "passed" } })).toBe("publish");
    expect(conversionRecovery({ ...record, status: "waiting-for-parser" })).toBe("convert");
  });

  it("renders the real Sources surface with all uses, original and text actions", async () => {
    const app = vault({ [source]: sourceMarkdown, "sources/text/shared.md": `---\ntype: Source Text\ntitle: 正文\ncreated_at: 2026-10-01\nsources:\n  - resource: /${source}\n---\n内容` });
    const openOriginal = vi.fn(async () => undefined);
    const openVaultPath = vi.fn(async () => undefined);
    const view = new OkfDashboardView(new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(app), {
      getDashboardUiState: () => normalizeDashboardUiState(undefined), originalFiles: { openNote: openOriginal, recoveryIssues: [] },
      semanticOperationsSnapshot: () => [], openVaultPath, isMobile: true,
    } as never);
    const root = new TestElement();
    const detail = new TestElement();
    vi.spyOn(view as never, "showObjectDetails").mockImplementation((...args: unknown[]) => { void (args[1] as (container: HTMLElement) => Promise<void>)(detail as unknown as HTMLElement); });
    await (view as unknown as { renderSources(parent: HTMLElement): Promise<void> }).renderSources(root as unknown as HTMLElement);
    expect(root.descendants("okf-source-card")).toHaveLength(1);
    expect(root.descendants("okf-source-use")).toHaveLength(0);
    root.descendants().find(item => item.textContent === "查看资料")!.click();
    await vi.waitFor(() => expect(detail.descendants("okf-source-use")).toHaveLength(4));
    root.descendants().find(item => item.textContent === "打开原件")!.click();
    root.descendants().find(item => item.textContent === "打开资料正文")!.click();
    await vi.waitFor(() => expect(openOriginal).toHaveBeenCalledWith(source));
    expect(openVaultPath).toHaveBeenCalledWith("sources/text/shared.md");
  });

  it("keeps scoped generation status from leaking to another use of the same Source", () => {
    const operation = { operation_id: "a", kind: "generate-study-guide", status: "running", stage: "generating",
      target: "learning/guides/a.md", sources: [source], project: "/projects/a/project.md", actual_reads: [], updated_at: "2026-10-12" };
    const view = new OkfDashboardView(new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(vault({})), {
      getDashboardUiState: () => normalizeDashboardUiState(undefined), semanticOperationsSnapshot: () => [operation],
    } as never);
    const runtime = view as unknown as { semanticOperationsByTarget(): Map<string, typeof operation>;
      semanticOperationForNote(note: NoteSummary, operations: Map<string, typeof operation>): typeof operation | undefined };
    const note: NoteSummary = { path: source, title: "资料", note_type: "Source", status: "stable", stale: false, excerpt: "", purpose: "study" };
    expect(runtime.semanticOperationForNote({ ...note, project: "/projects/a/project.md" }, runtime.semanticOperationsByTarget())).toBe(operation);
    expect(runtime.semanticOperationForNote({ ...note, project: `/${project}` }, runtime.semanticOperationsByTarget())).toBeUndefined();
  });

  it("renders a bounded component and expands with the exact scope, preserving the originating board", async () => {
    const app = vault({ [project]: "---\ntype: Project\ntitle: 项目 B\ncreated_at: 2026-10-01\nproject_status: active\n---\n<!-- ai:auto:start name=\"project-current-state\" -->\n<!-- ai:auto:end name=\"project-current-state\" -->\n## 下一步\n继续实现", "projects/b/log.md": "# 日志" });
    const root = new TestElement();
    const navigate = vi.fn(async () => undefined);
    let state = createDefaultDashboardUiState();
    const header = new TestElement();
    const view = new OkfDashboardView(new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(app), {
      getDashboardUiState: () => state,
      updateDashboardFeedUiState: vi.fn(),
      updateDashboardPageUiState: (section: "projects", patch: Record<string, unknown>, key?: string) => {
        state = patchDashboardUiState(state, key ? { instances: { [key]: patch } } : { pages: { [section]: patch } });
      }, semanticOperationsSnapshot: () => [], navigateToOkfSection: navigate,
    } as never, { container: root as unknown as HTMLElement, headerActions: header as unknown as HTMLElement,
      embedded: true, initialSection: "projects",
      workbenchPath: "我的项目", instanceKey: "project-instance", config: { project, mode: "summary", limit: 1 } });
    vi.spyOn(view as never, "attachActionPanel").mockImplementation(() => undefined);
    await view.onOpen();
    expect(root.descendants("okf-project-row")).toHaveLength(1);
    expect(root.descendants("okf-surface-controls")).toHaveLength(0);
    expect(header.descendants("okf-section-controls")).toHaveLength(1);
    expect(root.descendants().some(item => item.attributes.get("aria-label") === "搜索项目")).toBe(true);
    header.descendants().find(item => item.textContent === "独立打开")!.click();
    expect(navigate).toHaveBeenCalledWith("projects", root, "我的项目", expect.objectContaining({ project, mode: "summary", limit: 1,
      viewState: { filters: { query: "", sort: "modified" }, tab: "active", scrollTop: 0 } }), "project-instance:expanded");
    expect(root.descendants().some(item => item.textContent === "完整项目目录")).toBe(false);
    await (view as unknown as { render(preserveScroll: boolean): Promise<void> }).render(true);
    expect(header.descendants("okf-section-controls")).toHaveLength(1);
    await view.onClose();
    expect(header.children).toHaveLength(0);
  });

  it("keeps source headings while the workbench owns the daily-update title", async () => {
    const digest = { ai_daily: [], treehole: null };
    const root = new TestElement();
    const view = new OkfDashboardView(new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(vault({})), {
      getDashboardUiState: () => createDefaultDashboardUiState(),
      feedDashboardDigestSnapshot: () => digest, loadFeedDashboardDigest: async () => digest,
      updateDashboardPageUiState: vi.fn(), updateDashboardFeedUiState: vi.fn(),
    } as never, { container: root as unknown as HTMLElement, embedded: true, initialSection: "reading",
      config: { readingView: "daily-updates", mode: "summary" } });
    await view.onOpen();
    expect(root.descendants().filter(item => item.tagName === "h3").map(item => item.textContent))
      .toEqual(["中国热点", "AI 资讯", "树洞热榜"]);
    expect(root.descendants("okf-dashboard__reading")[0]?.hasClass("okf-dashboard__section")).toBe(false);
    await view.onClose();
  });

  it("loads legacy summary lists inline while keeping the originating instance and stage", () => {
    const root = new TestElement();
    let state = patchDashboardUiState(createDefaultDashboardUiState(), {
      instances: { "learning-instance": { tab: "pending", filters: { relation: project }, scrollTop: 70 } },
    });
    const navigate = vi.fn();
    const view = new OkfDashboardView(new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(vault({})), {
      getDashboardUiState: () => state,
      updateDashboardPageUiState: (section: "learning", patch: Record<string, unknown>, key: string) => {
        state = patchDashboardUiState(state, { instances: { [key]: patch } });
      }, navigateToOkfSection: navigate,
    } as never, { container: root as unknown as HTMLElement, embedded: true, initialSection: "learning",
      workbenchPath: "我的学习", instanceKey: "learning-instance", config: { project, mode: "summary", limit: 1 } });
    (view as unknown as { pageItems(parent: HTMLElement, items: number[], renderItem: (parent: HTMLElement, item: number) => void): void })
      .pageItems(root as unknown as HTMLElement, [1, 2], (parent, item) => parent.createDiv({ text: String(item) }));
    root.descendants().find(item => item.textContent === "加载更多")!.click();
    expect(navigate).not.toHaveBeenCalled();
    expect(root.descendants().filter(item => ["1", "2"].includes(item.textContent)).map(item => item.textContent)).toEqual(["1", "2"]);
    expect(state.instances?.["learning-instance"]?.filters["loaded:learning:0"]).toBe(2);
    expect(state.instances?.["learning-instance"]?.scrollTop).toBe(70);
  });

  it("provides all project tasks beyond the preview, including a related guide outside its folder", async () => {
    const app = vault({
      [project]: "---\ntype: Project\ntitle: 项目 B\ncreated_at: 2026-10-01\nproject_status: active\n---\n- [ ] #task 第一项\n- [ ] #task 第二项\n- [ ] #task 第三项",
      "learning/guides/shared.md": `---\ntype: Study Guide\ntitle: 双关联练习\ncreated_at: 2026-10-01\nproject: /${project}\n---\n- [ ] #task 第四项`,
    });
    const root = new TestElement();
    const navigate = vi.fn();
    const view = new OkfDashboardView(new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(app), {
      getDashboardUiState: () => createDefaultDashboardUiState(), navigateToOkfSection: navigate,
    } as never, { container: root as unknown as HTMLElement, embedded: true, initialSection: "projects", workbenchPath: "我的项目" });
    vi.spyOn(view as never, "attachActionPanel").mockImplementation(() => undefined);
    await (view as unknown as { renderProjects(parent: HTMLElement): Promise<void> }).renderProjects(root as unknown as HTMLElement);
    expect(root.descendants("okf-formal-task-row")).toHaveLength(3);
    expect(root.descendants().some(item => item.textContent === "待办 · 4")).toBe(true);
    root.descendants().find(item => item.textContent === "查看全部项目待办")!.click();
    expect(navigate).toHaveBeenCalledWith("tasks", root, "我的项目", { course: undefined, project, taskView: "all" });
  });
});

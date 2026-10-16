import { TFile, WorkspaceLeaf, type App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureTasks } from "../tasks-generated/core.js";
import { readWorkbenchSectionConfig } from "../src/features/workbench/section-config.js";
import { OkfDashboardItemView, OkfDashboardView, type DashboardSection } from "../src/plugin/dashboard-view.js";
import { createDefaultDashboardUiState, patchDashboardUiState, type DashboardPageUiStatePatch } from "../src/plugin/dashboard-ui-state.js";
import { TestElement } from "./obsidian-runtime.js";

const opened: OkfDashboardView[] = [];
beforeEach(async () => { await configureTasks({ globalFilter: "#task", removeGlobalFilter: true }); });
afterEach(async () => { for (const view of opened.splice(0)) await view.onClose(); });

function testApp(markdown: Record<string, string> = {}, mtimes: Record<string, number> = {}): App {
  const files = Object.keys(markdown).map(path => Object.assign(new (TFile as unknown as new (path: string) => TFile)(path),
    { stat: { mtime: mtimes[path] ?? 1, ctime: 1, size: markdown[path]!.length } }));
  return { vault: { getMarkdownFiles: () => files, getFiles: () => files,
    getAbstractFileByPath: (path: string) => files.find(file => file.path === path) ?? null,
    cachedRead: async (file: TFile) => markdown[file.path], read: async (file: TFile) => markdown[file.path],
    adapter: { stat: async (path: string) => markdown[path] ? { type: "file" } : null },
  }, metadataCache: { getFileCache: () => null } } as unknown as App;
}

async function mount(section: DashboardSection, config: Record<string, unknown> = {}, markdown: Record<string, string> = {}, embedded = true, mtimes: Record<string, number> = {}) {
  let state = createDefaultDashboardUiState();
  const navigate = vi.fn(async () => undefined);
  const app = testApp(markdown, mtimes);
  const plugin = { isMobile: true, getDashboardUiState: () => state,
    updateDashboardPageUiState: (page: DashboardSection, patch: DashboardPageUiStatePatch, key?: string) => {
      state = patchDashboardUiState(state, key ? { instances: { [key]: patch } } : { pages: { [page]: patch } });
    },
    updateDashboardFeedUiState: vi.fn(), conversionSnapshot: () => [], semanticOperationsSnapshot: () => [],
    recentDashboardFiles: () => [], originalFiles: { recoveryIssues: [] }, navigateToOkfSection: navigate,
    taskQueryViews: () => [], promptNewTask: vi.fn(), manageTaskQueryViews: vi.fn(),
    feedReadingPosition: () => undefined,
    feedDecisionSnapshot: () => undefined,
    promptActionMenu: vi.fn(), canReturnToPreviousDashboardPage: () => false,
  };
  const root = new TestElement();
  const header = new TestElement();
  const view = new OkfDashboardView(new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(app), plugin as never,
    { container: root as unknown as HTMLElement, headerActions: header as unknown as HTMLElement,
      embedded, focused: !embedded, initialSection: section, instanceKey: "instance", workbenchPath: "board", config });
  opened.push(view);
  await view.onOpen();
  return { view, root, header, navigate, plugin, state: () => state };
}

describe("complete business surfaces", () => {
  it("reads legacy sizes without mutating layouts and gives new hosts separate defaults", () => {
    const raw = { mode: "summary", future: { untouched: true } };
    expect(readWorkbenchSectionConfig(raw).limit).toBe(5);
    expect(readWorkbenchSectionConfig({ mode: "embedded" }).limit).toBe(50);
    expect(readWorkbenchSectionConfig({ mode: "full", limit: 2 }).limit).toBe(2);
    expect(readWorkbenchSectionConfig({}).limit).toBe(10);
    expect(readWorkbenchSectionConfig({}, "page").limit).toBe(30);
    expect(raw).toEqual({ mode: "summary", future: { untouched: true } });
    expect(readWorkbenchSectionConfig(raw)).not.toHaveProperty("mode");
    expect(() => readWorkbenchSectionConfig({ sourcePageSize: 9 })).toThrow("1–8");
  });

  const controls: Array<[DashboardSection, string]> = [
    ["tasks", "管理视图"], ["inbox", "快速记录到待处理"], ["sources", "资料用途"],
    ["learning", "新建课程"], ["projects", "搜索项目"], ["knowledge", "新建知识导航"],
    ["life", "起始日期"], ["system", "系统诊断"], ["reading", "来源与历史"], ["today", "新建今日任务"],
  ];
  for (const mode of ["summary", "embedded", "full"]) it.each(controls)(`${mode}: %s retains its business tools`, async (section, control) => {
    const { root, header } = await mount(section, { mode, showDailyUpdates: false });
    expect(root.descendants("okf-dashboard__error").map(item => item.textContent)).toEqual([]);
    expect(root.descendants().some(item => item.textContent === control || item.attributes.get("aria-label") === control)).toBe(true);
    expect(root.descendants().some(item => item.textContent === "在新标签页打开")).toBe(true);
    expect(header.descendants()).toHaveLength(0);
  });

  it("changes task views in place, retains the scope, and exposes advanced queries on old boards", async () => {
    const { root, navigate, view, state } = await mount("tasks", { mode: "summary", limit: 1 }, {
      "self/tasks.md": "- [ ] #task Open ^open\n- [x] #task Done ^done",
    });
    expect(root.descendants("okf-formal-task-row")).toHaveLength(1);
    const select = root.descendants().find(item => item.attributes.get("aria-label") === "视图")!;
    select.value = "done";
    select.dispatch("change");
    await vi.waitFor(() => expect(state().instances?.instance?.filters.taskView).toBe("done"));
    await vi.waitFor(() => expect(root.descendants().some(item => item.textContent === "Done")).toBe(true));
    expect(navigate).not.toHaveBeenCalled();
    expect(view.navigationConfig().taskView).toBe("done");
    expect(root.descendants().some(item => item.textContent === "应用查询")).toBe(true);
  });

  it("does not apply or save an invalid task query draft", async () => {
    const { root, state } = await mount("tasks", {}, { "self/tasks.md": "- [ ] #task Open ^open" });
    const input = root.descendants().find(item => item.attributes.get("aria-label") === "Tasks 查询")!;
    input.value = "this query cannot be parsed";
    input.dispatch("input");
    root.descendants().find(item => item.textContent === "应用查询")!.click();
    expect(state().instances?.instance?.filters.taskAdvancedQuery).toBeUndefined();
    expect(root.descendants("okf-task-query__error")[0]?.textContent).toContain("查询未应用");
    expect(root.descendants("okf-formal-task-row")).toHaveLength(1);
  });

  it("transfers the applied search and tab while leaving the board independent", async () => {
    const board = await mount("knowledge");
    const search = board.root.descendants().find(item => item.attributes.get("aria-label") === "搜索知识库")!;
    search.value = "检索内容";
    search.dispatch("input");
    const snapshot = board.view.navigationConfig();
    const page = await mount("knowledge", snapshot, {}, false);
    expect(page.root.descendants().find(item => item.attributes.get("aria-label") === "搜索知识库")?.value).toBe("检索内容");
    const pageSearch = page.root.descendants().find(item => item.attributes.get("aria-label") === "搜索知识库")!;
    pageSearch.value = "另一个检索";
    pageSearch.dispatch("input");
    expect((board.view.navigationConfig().viewState as { filters: { query: string } }).filters.query).toBe("检索内容");
  });

  it("paginates daily editions without leaving the component", async () => {
    const { view, navigate } = await mount("reading", { scene: "daily-updates", readingView: "daily-updates", itemsPerEdition: 1 });
    const root = new TestElement();
    (view as unknown as { renderFeedDigestEdition(parent: HTMLElement, kind: string, edition: unknown, options: unknown): void }).renderFeedDigestEdition(root as unknown as HTMLElement,
      "ai-daily", { digest_id: "edition", item_count: 3, items: [1, 2, 3].map(id => ({ item_id: String(id), title: `条目 ${id}` })) }, { mode: "compact" });
    expect(root.descendants("okf-feed-digest__item")).toHaveLength(1);
    root.descendants().find(item => item.textContent === "加载更多条目 · 共 3 条")!.click();
    expect(root.descendants("okf-feed-digest__item")).toHaveLength(2);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps each independent pane's history separate and serializable", async () => {
    const plugin = { getDashboardUiState: () => createDefaultDashboardUiState() };
    const leaf = () => new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(testApp());
    const a = new OkfDashboardItemView(leaf(), plugin as never);
    const b = new OkfDashboardItemView(leaf(), plugin as never);
    Object.defineProperty(a, "containerEl", { value: new TestElement() });
    Object.defineProperty(b, "containerEl", { value: new TestElement() });
    await a.setState({ section: "sources" }, {} as never);
    a.rememberNavigation();
    await b.setState({ section: "knowledge" }, {} as never);
    expect(a.navigationHistory[0]?.section).toBe("sources");
    expect(b.navigationHistory).toEqual([]);
    expect(a.navigationHistory[0]).not.toHaveProperty("navigationHistory");
    const restored = new OkfDashboardItemView(leaf(), plugin as never);
    Object.defineProperty(restored, "containerEl", { value: new TestElement() });
    await restored.setState(a.getState(), {} as never);
    expect(restored.navigationHistory).toEqual(a.navigationHistory);
  });

  it("counts project relationships in the same Course and Project intersection as their destination", async () => {
    const course = 'learning/courses/a/course.md';
    const project = 'projects/p/project.md';
    const note = (type: string, title: string, fields = '') => `---\ntype: ${type}\ntitle: ${title}\ncreated_at: 2026-10-01\n${fields}---\n`;
    const { root } = await mount('projects', { course, project }, {
      [course]: note('Course', '课程 A'),
      [project]: note('Project', '项目 P', 'project_status: active\n'),
      'learning/guides/a.md': note('Study Guide', '范围内', `course: /${course}\nproject: /${project}\n`),
      'learning/guides/b.md': note('Study Guide', '其他课程', `course: /learning/courses/b/course.md\nproject: /${project}\n`),
    });
    expect(root.descendants('okf-dashboard__error')).toHaveLength(0);
    expect(root.descendants('okf-work-item__metric').find(item => item.dataset.metric === 'study-guides')?.textContent).toBe('学习笔记 1');
  });

  it("sorts the entire scoped catalogue in place and transfers its current ordering", async () => {
    const source = (title: string) => `---\ntype: Source\ntitle: ${title}\ncreated_at: 2026-10-01\nuses:\n  - purpose: reference\n    project: /projects/p/project.md\n---\n`;
    const board = await mount('sources', { pageSize: 1 }, {
      'sources/z.md': source('Z'), 'sources/a.md': source('A'),
    }, true, { 'sources/z.md': 2, 'sources/a.md': 1 });
    expect(board.root.descendants('okf-dashboard__row-title')[0]?.textContent).toBe('Z');
    const sort = board.root.descendants().find(item => item.attributes.get('aria-label') === '目录排序')!;
    sort.value = 'title'; sort.dispatch('change');
    await vi.waitFor(() => expect(board.root.descendants('okf-dashboard__row-title')[0]?.textContent).toBe('A'));
    expect(board.navigate).not.toHaveBeenCalled();
    expect(board.state().instances?.instance?.filters.sort).toBe('title');
    expect(board.view.navigationConfig().sort).toBe('title');
    const page = await mount('sources', { ...board.view.navigationConfig(), project: 'projects/p/project.md' }, {
      'sources/z.md': source('Z'), 'sources/a.md': source('A'),
      'projects/p/project.md': '---\ntype: Project\ntitle: P\ncreated_at: 2026-10-01\n---\n',
    }, false);
    expect(page.root.descendants('okf-dashboard__row-title')[0]?.textContent).toBe('A');
    const pageSort = page.root.descendants().find(item => item.attributes.get('aria-label') === '目录排序')!;
    pageSort.value = 'modified'; pageSort.dispatch('change');
    await vi.waitFor(() => expect(page.root.descendants().some(item => item.textContent === '取消项目范围')).toBe(true));
    page.root.descendants().find(item => item.textContent === '取消项目范围')!.click();
    await vi.waitFor(() => expect(page.root.descendants().find(item => item.attributes.get('aria-label') === '目录排序')?.value).toBe('modified'));
    expect(board.view.navigationConfig().sort).toBe('title');
  });
});

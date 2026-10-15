import type { VaultTask } from "../../apex/src/alltasks-scan.js";
import { dateBucketOf, DATE_BUCKET_I18N } from "../../apex/src/alltasks-scan.js";
import { executeTaskQuery } from "../../tasks-generated/core.js";
import { TASK_VIEW_LABELS, TASK_PRIORITY_LABELS, taskIdentity, taskMatchesView, sortTasks, type TaskView } from "./task-presentation.js";

export interface SavedTaskView {
  id: string;
  name: string;
  query: string;
  context: Record<string, unknown>;
}

export interface TaskCatalogOptions {
  tasks: VaultTask[];
  config: Record<string, unknown>;
  limit: number;
  path?: string;
  search: string;
  saved: SavedTaskView[];
  renderRow(parent: HTMLElement, task: VaultTask): void;
  create(): void;
  navigate(config: Record<string, unknown>): void;
  remember(search: string): void;
  rememberSettings(values: Record<string, string>): void;
  save(query: string, context: Record<string, unknown>, id?: string): Promise<void>;
  manage(): void;
  notify(message: string): void;
  workbenches?: Array<{ path: string; open(): void }>;
}

export function renderTaskCatalog(container: HTMLElement, options: TaskCatalogOptions): void {
  const view = (options.config.taskView === "overview" ? "all" : options.config.taskView ?? "all") as TaskView;
  const toolbar = container.createDiv({ cls: "okf-task-toolbar" });
  toolbar.createEl("button", { text: "新建任务", cls: "mod-cta", attr: { type: "button" } }).addEventListener("click", options.create);
  let query = String(options.config.taskQuery ?? "");
  let search = String(options.config.taskSearch ?? options.search);
  let status = String(options.config.taskStatus ?? "all");
  let priority = String(options.config.taskPriority ?? "all");
  let sort = String(options.config.taskSort ?? "");
  let grouping = String(options.config.taskGroupBy ?? "none");
  let shown = Math.max(options.limit, Number(options.config.taskShown) || 0);
  const navigate = (taskView: TaskView) => options.navigate({ ...options.config, taskView, taskQuery: "", taskQueryDraft: "", resetTaskQuery: true,
    savedViewId: undefined, savedViewName: undefined });
  const select = (parent: HTMLElement, label: string, values: Record<string, string>, value: string, change: (value: string) => void): HTMLSelectElement => {
    const field = parent.createEl("label", { cls: "okf-task-filter" });
    field.createSpan({ text: label });
    const input = field.createEl("select", { attr: { "aria-label": label } });
    for (const [key, text] of Object.entries(values)) input.createEl("option", { text, attr: { value: key } });
    input.value = value;
    input.addEventListener("change", () => change(input.value));
    return input;
  };
  {
    select(toolbar, "视图", Object.fromEntries(Object.entries(TASK_VIEW_LABELS).filter(([key]) => key !== 'checklists')), view, value => navigate(value as TaskView));
    const saved = Object.fromEntries([["", "选择保存视图…"], ...options.saved.map(item => [item.id, item.name])]);
    select(toolbar, "保存视图", saved, String(options.config.savedViewId ?? ""), id => {
      const item = options.saved.find(item => item.id === id);
      if (item) options.navigate({ ...item.context, savedViewId: item.id, savedViewName: item.name });
    });
    toolbar.createEl("button", { text: "管理视图", attr: { type: "button" } }).addEventListener("click", options.manage);
    const searchInput = toolbar.createEl("input", { cls: "okf-task-search", attr: { type: "search", "aria-label": "搜索任务", placeholder: "搜索内容、来源和关联…" } });
    searchInput.value = search;
    searchInput.addEventListener("input", () => { search = searchInput.value; shown = options.limit; options.rememberSettings({ taskShown: String(shown) }); options.remember(search); render(); });
  }
  if (view === 'checklists') {
    container.createDiv({ text: '清单保存在各工作台的清单卡片中。请返回所属工作台查看和编辑。', cls: 'okf-dashboard__muted' });
    for (const board of options.workbenches ?? []) container.createEl('button', { text: board.path, attr: { type: 'button' } }).addEventListener('click', board.open);
    return;
  }
  if (view === "unscheduled") container.createDiv({ cls: "okf-dashboard__muted", text: "尚未设置计划、开始、结束、截止或提醒日期的任务。" });
  if (view === "today") container.createDiv({ cls: "okf-dashboard__muted", text: "日期与今天有关的未完成任务；各项显示计划、截止、提醒或跨日安排等原因。" });
  if (view === "upcoming") container.createDiv({ cls: "okf-dashboard__muted", text: "包含未来日期的未完成任务；同一任务也可能与今天有关。" });
  if (view === "overdue") container.createDiv({ cls: "okf-dashboard__muted", text: "已过截止日期或截止时间的未完成任务。" });
  let queryInput: HTMLTextAreaElement | undefined;
  let error: HTMLElement;
  {
    const advanced = container.createEl("details", { cls: "okf-task-query" });
    advanced.open = Boolean(query.trim());
    advanced.createEl("summary", { text: query.trim() ? "高级筛选 · 查询已应用" : "筛选、排序与高级查询" });
    const fields = advanced.createDiv({ cls: "okf-task-filters" });
    const states = { all: "全部适用状态", TODO: "待完成", IN_PROGRESS: "进行中", ON_HOLD: "等待", DONE: "已完成", CANCELLED: "已取消",
      ...Object.fromEntries(options.tasks.filter(task => task.upstream).map(task => [`symbol:${task.status}`, `${task.upstream!.status.name} [${task.status}]`])) };
    select(fields, "状态", states, status, value => { status = value; options.rememberSettings({ taskStatus: value }); render(); });
    select(fields, "优先级", { all: "全部", ...TASK_PRIORITY_LABELS }, priority, value => { priority = value; options.rememberSettings({ taskPriority: value }); render(); });
    select(fields, "排序", { "": "当前视图默认", due: "截止日期", scheduled: "计划日期", priority: "优先级", title: "内容", completion: "完成日期" }, sort, value => { sort = value; options.rememberSettings({ taskSort: value }); render(); });
    select(fields, "分组", { none: "不分组", date: "截止日期", priority: "优先级", path: "来源笔记", status: "状态" }, grouping, value => { grouping = value; options.rememberSettings({ taskGroupBy: value }); render(); });
    advanced.createDiv({ cls: "okf-dashboard__muted", text: "附加查询与当前视图取交集；独立查询请选择“自定义查询”。高级查询遵循 Tasks 全局查询配置。" });
    queryInput = advanced.createEl("textarea", { attr: { "aria-label": "Tasks 查询", placeholder: "is not blocked\nsort by priority\ngroup by path" } });
    queryInput.value = String(options.config.taskQueryDraft ?? query);
    queryInput.addEventListener("input", () => options.rememberSettings({ taskQueryDraft: queryInput!.value }));
    error = advanced.createDiv({ cls: "okf-task-query__error", attr: { role: "alert" } });
    advanced.createEl("button", { text: "应用查询", attr: { type: "button" } }).addEventListener("click", () => {
      const draft = queryInput!.value;
      try {
        if (draft.trim()) executeTaskQuery(draft, options.tasks.filter(task => task.upstream).map(task => task.upstream!), options.path);
      } catch (failure) {
        error.setText(`查询未应用：${failure instanceof Error ? failure.message : String(failure)}`);
        return;
      }
      query = draft;
      options.rememberSettings({ taskAdvancedQuery: query });
      shown = options.limit;
      render();
    });
    advanced.createEl("button", { text: "清除查询", attr: { type: "button" } }).addEventListener("click", () => { query = ""; queryInput!.value = ""; options.rememberSettings({ taskAdvancedQuery: "", taskQueryDraft: "" }); render(); });
    advanced.createEl("button", { text: "保存此视图", attr: { type: "button" } }).addEventListener("click", () => {
      void options.save(query, { ...options.config, taskQuery: query, taskQueryDraft: undefined, viewState: undefined, taskView: view, taskSort: sort, taskGroupBy: grouping,
        taskStatus: status, taskPriority: priority, taskSearch: search }).catch(error => options.notify(error instanceof Error ? error.message : "保存失败"));
    });
    if (options.config.savedViewId) advanced.createEl("button", { text: "更新当前保存视图", attr: { type: "button" } }).addEventListener("click", () => {
      void options.save(query, { ...options.config, taskQuery: query, taskQueryDraft: undefined, viewState: undefined, taskView: view, taskSort: sort, taskGroupBy: grouping,
        taskStatus: status, taskPriority: priority, taskSearch: search }, String(options.config.savedViewId)).catch(error => options.notify(String(error)));
    });
  }
  const list = container.createDiv({ cls: "okf-formal-task-list" });
  function render(): void {
    list.empty();
    error.empty();
    const term = search.trim().toLocaleLowerCase();
    let tasks = sortTasks(options.tasks.filter(task => taskMatchesView(task, view)
      && (status === "all" || (status.startsWith("symbol:") ? task.status === status.slice(7) : task.statusType === status)) && (priority === "all" || task.upstream?.priority === priority)
      && (!term || `${task.text} ${task.path} ${task.course ?? ""} ${task.project ?? ""}`.toLocaleLowerCase().includes(term))), sort, view);
    let groups: Array<{ heading: string; tasks: VaultTask[] }> = [];
    {
      try {
        const result = executeTaskQuery(query, options.tasks.filter(task => task.upstream).map(task => task.upstream!), options.path, {}, tasks.map(taskIdentity));
        const byKey = new Map(tasks.map(task => [taskIdentity(task), task]));
        groups = result.groups.map(group => ({ heading: group.groups.join(" / "), tasks: group.tasks.map(task => byKey.get(`${task.path}:${task.lineNumber}`)!).filter(Boolean) }));
        tasks = [...new Map(groups.flatMap(group => group.tasks).map(task => [taskIdentity(task), task])).values()];
      } catch (failure) {
        error.setText(failure instanceof Error ? failure.message : "查询无效");
        list.createDiv({ cls: "okf-dashboard__empty", text: "查询未执行，请修正查询。" });
        return;
      }
    }
    list.createDiv({ cls: "okf-task-count", text: `当前筛选共 ${tasks.length} 项 · 已显示 ${Math.min(tasks.length, shown)} 项` });
    if (!tasks.length) { list.createDiv({ cls: "okf-dashboard__empty", text: "当前范围没有符合条件的任务。可以新建任务，或调整筛选。" }); return; }
    const visible = new Set(tasks.slice(0, shown).map(taskIdentity));
    if (!groups.some(group => group.heading)) {
      const labels: Record<string, string> = { Overdue: "逾期", Today: "今日截止", ThisWeek: "本周截止", Later: "后续截止", NoDue: "没有截止日期" };
      const map = new Map<string, VaultTask[]>();
      for (const task of tasks) {
        const heading = grouping === "date" ? labels[DATE_BUCKET_I18N[dateBucketOf(task.due)]]!
          : grouping === "priority" ? TASK_PRIORITY_LABELS[task.upstream?.priority ?? "3"]!
            : grouping === "path" ? task.file.basename : grouping === "status" ? task.upstream?.status.name ?? task.statusType ?? "待完成" : "";
        map.set(heading, [...(map.get(heading) ?? []), task]);
      }
      groups = [...map].map(([heading, tasks]) => ({ heading, tasks }));
    }
    for (const group of groups) {
      const entries = group.tasks.filter(task => visible.has(taskIdentity(task)));
      if (!entries.length) continue;
      if (group.heading) list.createEl("h4", { text: group.heading });
      entries.forEach(task => options.renderRow(list, task));
    }
    if (tasks.length > shown) list.createEl("button", { text: "加载更多", attr: { type: "button" } })
      .addEventListener("click", () => { shown += options.limit; options.rememberSettings({ taskShown: String(shown) }); render(); });
  }
  render();
}

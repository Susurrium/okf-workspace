import { Notice } from "obsidian";
import type { ProjectSummary } from "../../api/types.js";
import { orderedProjects, projectCategory, projectGroups, type ProjectOrganization } from "../../domain/project-organization.js";
import { projectLifecycleStatus, type ProjectLifecycleStatus } from "../../domain/workspace-status.js";

type Tab = "all" | ProjectLifecycleStatus;
export interface ProjectCatalogOptions {
  projects: readonly ProjectSummary[];
  tab: Tab;
  query: string;
  organization: ProjectOrganization;
  remember(tab: Tab, query: string, organization: ProjectOrganization): void;
  renderItems(parent: HTMLElement, items: readonly ProjectSummary[], render: (parent: HTMLElement, project: ProjectSummary) => void, group: string): void;
  renderProject(parent: HTMLElement, project: ProjectSummary): void;
  editCategory(project: ProjectSummary): void;
  moveCategory(project: ProjectSummary, category: string | null): Promise<void>;
  moveStatus(project: ProjectSummary, status: ProjectLifecycleStatus): Promise<void>;
}

export function renderProjectCatalog(container: HTMLElement, options: ProjectCatalogOptions): void {
  let { tab, query } = options;
  const prefs = { ...options.organization, pinned: [...options.organization.pinned], order: [...options.organization.order] };
  const remember = (): void => options.remember(tab, query, prefs);
  const controls = container.createDiv({ cls: "okf-project-controls" });
  const search = controls.createEl("input", { attr: { type: "search", "aria-label": "搜索项目", placeholder: "搜索项目、类别与下一步…" } });
  search.value = query;
  const tabs = container.createDiv({ cls: "okf-dashboard__segments okf-dashboard__stage-tabs", attr: { role: "tablist", "aria-label": "项目状态" } });
  const body = container.createDiv({ cls: "okf-project-catalog" });
  const select = (label: string, values: [string, string][], value: string, changed: (value: string) => void): HTMLSelectElement => {
    const field = controls.createEl("label", { text: label });
    const input = field.createEl("select", { attr: { "aria-label": label } });
    for (const [key, text] of values) input.createEl("option", { text, attr: { value: key } });
    input.value = value;
    input.addEventListener("change", () => { changed(input.value); remember(); render(); });
    return input;
  };
  const categories = [...new Set(options.projects.map(project => projectCategory(project.project_category)))].filter((name): name is string => name !== null).sort((a, b) => a.localeCompare(b, "zh-CN"));
  const categoryValues: [string, string][] = [["*", "全部类别"], ["null", "未分类"], ...categories.map((name): [string, string] => [JSON.stringify(name), name])];
  if (!categoryValues.some(([key]) => key === prefs.category)) categoryValues.push([prefs.category, `${JSON.parse(prefs.category)}（当前无项目）`]);
  select("项目类别", categoryValues, prefs.category, value => { prefs.category = value; });
  const grouping = select("分组依据", [["none", "不分组"], ["status", "项目状态"], ["category", "项目类别"]], prefs.group, value => {
    prefs.group = value as ProjectOrganization["group"];
    if (prefs.view === "kanban" && prefs.group === "none") { prefs.group = "status"; grouping.value = "status"; }
  });
  select("展示方式", [["list", "列表"], ["kanban", "看板"]], prefs.view, value => {
    prefs.view = value as ProjectOrganization["view"];
    if (prefs.view === "kanban" && prefs.group === "none") { prefs.group = "status"; grouping.value = "status"; }
  });
  const ordering = select("项目排序", [["modified", "最近更新"], ["title", "名称"], ["manual", "手动顺序"]], prefs.sort, value => { prefs.sort = value as ProjectOrganization["sort"]; });
  const token = crypto.randomUUID();
  const mime = "application/x-okf-project";
  let busy = false;
  const groupKey = (project: ProjectSummary): string => prefs.group === "category" ? JSON.stringify(projectCategory(project.project_category))
    : prefs.group === "status" || prefs.view === "kanban" ? projectLifecycleStatus(project) : "all";
  function drop(event: DragEvent, key: string, before?: string): void {
    const payload = event.dataTransfer?.getData(mime);
    if (!payload) return;
    event.preventDefault(); event.stopPropagation();
    try {
      const data: unknown = JSON.parse(payload);
      if (!data || typeof data !== "object" || !("token" in data) || data.token !== token || !("path" in data)) return;
      const project = options.projects.find(project => project.path === data.path);
      if (!project) return;
      if (groupKey(project) !== key) { void move(project, key); return; }
      if (before === project.path) return;
      const target = before ? options.projects.find(project => project.path === before) : undefined;
      if (target && prefs.pinned.includes(target.path) !== prefs.pinned.includes(project.path)) throw new Error("请在相同置顶状态的项目之间调整顺序");
      const all = orderedProjects(options.projects, prefs).map(project => project.path).filter(path => path !== project.path);
      const index = before ? all.indexOf(before) : all.length;
      all.splice(index < 0 ? all.length : index, 0, project.path);
      prefs.order = all; prefs.sort = "manual";
      if (prefs.pinned.includes(project.path)) prefs.pinned = all.filter(path => prefs.pinned.includes(path));
      remember(); render();
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }
  async function move(project: ProjectSummary, key: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (prefs.group === "category") await options.moveCategory(project, projectCategory(JSON.parse(key)));
      else if (key === "active" || key === "paused" || key === "completed") await options.moveStatus(project, key);
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error), 10000); }
    finally { busy = false; }
  }
  function render(): void {
    ordering.value = prefs.sort;
    tabs.empty(); body.empty();
    body.toggleClass("okf-project-catalog--kanban", prefs.view === "kanban");
    const term = query.trim().toLocaleLowerCase();
    const filtered = options.projects.filter(project => (prefs.category === "*" || JSON.stringify(projectCategory(project.project_category)) === prefs.category)
      && (!term || `${project.title} ${project.project_category ?? ""} ${project.next_action}`.toLocaleLowerCase().includes(term)));
    for (const [value, label] of [["all", "全部"], ["active", "进行中"], ["paused", "已暂停"], ["completed", "已完成"]] as const) {
      const count = filtered.filter(project => value === "all" || projectLifecycleStatus(project) === value).length;
      const button = tabs.createEl("button", { text: `${label} ${count}`, cls: tab === value ? "is-active" : "",
        attr: { type: "button", role: "tab", "aria-selected": String(tab === value) } });
      button.addEventListener("click", () => { tab = value; remember(); render(); });
    }
    const visible = orderedProjects(filtered.filter(project => tab === "all" || projectLifecycleStatus(project) === tab), prefs);
    const grouped = projectGroups(prefs.category === "*" ? options.projects : filtered, prefs)
      .map(group => ({ ...group, projects: visible.filter(project => groupKey(project) === group.key) }));
    for (const group of grouped) {
      const column = body.createEl("section", { cls: "okf-project-group", attr: { "aria-label": group.label } });
      if (prefs.group !== "none" || prefs.view === "kanban") column.createEl("h4", { text: `${group.label} · ${group.projects.length}` });
      column.addEventListener("dragover", event => { if (event.dataTransfer?.types.includes(mime)) event.preventDefault(); });
      column.addEventListener("drop", event => drop(event, group.key));
      if (!group.projects.length) { column.createDiv({ text: "暂无项目", cls: "okf-dashboard__empty" }); continue; }
      options.renderItems(column, group.projects, (parent, project) => {
        const card = parent.createDiv({ cls: "okf-project-card", attr: { "data-project": project.path } });
        card.addEventListener("drop", event => drop(event, group.key, project.path));
        options.renderProject(card, project);
        const actions = card.createDiv({ cls: "okf-project-card-controls" });
        const button = (text: string, action: () => void): HTMLButtonElement => {
          const element = actions.createEl("button", { text, attr: { type: "button", "aria-label": `${project.title}：${text}` } });
          element.addEventListener("click", action); return element;
        };
        const pinned = prefs.pinned.includes(project.path);
        const pin = button(pinned ? "取消置顶" : "置顶", () => {
          prefs.pinned = pinned ? prefs.pinned.filter(path => path !== project.path) : [...prefs.pinned, project.path];
          remember(); render();
        });
        pin.setAttribute("aria-pressed", String(pinned));
        button("类别", () => options.editCategory(project));
        const handle = button("拖到其他分组", () => undefined);
        handle.draggable = true;
        handle.addEventListener("dragstart", event => {
          event.dataTransfer?.setData(mime, JSON.stringify({ token, path: project.path }));
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        });
        for (const [delta, text] of [[-1, "上移"], [1, "下移"]] as const) {
          const index = group.projects.indexOf(project), neighbour = group.projects[index + delta];
          const control = button(text, () => {
            if (!neighbour) return;
            const all = orderedProjects(options.projects, prefs).map(project => project.path);
            const from = all.indexOf(project.path), to = all.indexOf(neighbour.path);
            [all[from], all[to]] = [all[to]!, all[from]!];
            prefs.order = all; prefs.sort = "manual";
            // 置顶项目只在置顶集合内调整顺序。
            if (pinned && prefs.pinned.includes(neighbour.path)) prefs.pinned = all.filter(path => prefs.pinned.includes(path));
            remember(); render();
          });
          control.disabled = !neighbour || pinned !== prefs.pinned.includes(neighbour.path);
        }
      }, group.key);
    }
    if (!visible.length && prefs.group === "none" && prefs.view === "list") body.createDiv({ text: "当前范围没有项目。", cls: "okf-dashboard__empty" });
  }
  search.addEventListener("input", () => { query = search.value; remember(); render(); });
  render();
}

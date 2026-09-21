import { Notice, type App } from "obsidian";

import type { CustomSectionDefinition } from "../../../apex/src/section-registry.js";
import {
  collectVaultTasks,
  invalidatePath,
  toggleTaskInFile,
  type VaultTask,
} from "../../../apex/src/alltasks-scan.js";
import type { ProjectSummary } from "../../api/types.js";
import { VaultDashboardReader } from "../../plugin/vault-dashboard.js";

export const OKF_PROJECT_SECTION_TYPE = "workspace-projects";

export type ProjectLifecycleStatus = "active" | "paused" | "completed";

export interface ProjectSectionConfig {
  statuses: ProjectLifecycleStatus[];
}

export interface ProjectSectionHost {
  promptProject(onCreated?: (slug: string) => void): void;
  promptProjectProgress(projectPath: string): void;
  promptProjectDecision(projectPath: string): void;
  promptProjectStatus(projectPath: string, current: ProjectLifecycleStatus): void;
  openVaultPath(path: string): Promise<void>;
}

const STATUS_OPTIONS: ReadonlyArray<{ value: ProjectLifecycleStatus; label: string }> = [
  { value: "active", label: "推进中" },
  { value: "paused", label: "已暂停" },
  { value: "completed", label: "已完成" },
];

const STATUS_SET = new Set<ProjectLifecycleStatus>(STATUS_OPTIONS.map(({ value }) => value));

export function projectLifecycleStatus(project: Pick<ProjectSummary, "project_status">): ProjectLifecycleStatus {
  return project.project_status === "paused" || project.project_status === "completed"
    ? project.project_status
    : "active";
}

export function normalizeProjectSectionConfig(value: unknown): ProjectSectionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { statuses: ["active"] };
  const statuses = (value as { statuses?: unknown }).statuses;
  if (!Array.isArray(statuses)) return { statuses: ["active"] };
  const normalized = [...new Set(statuses.filter(
    (status): status is ProjectLifecycleStatus => typeof status === "string" && STATUS_SET.has(status as ProjectLifecycleStatus),
  ))];
  return { statuses: normalized.length > 0 ? normalized : ["active"] };
}

export function filterProjects(
  projects: readonly ProjectSummary[],
  config: ProjectSectionConfig,
): ProjectSummary[] {
  const accepted = new Set(config.statuses);
  return projects.filter((project) => accepted.has(projectLifecycleStatus(project)));
}

function labeledValue(container: HTMLElement, label: string, value: string): void {
  const row = container.createDiv({ cls: "okf-project-card__field" });
  row.createSpan({ cls: "okf-project-card__field-label", text: label });
  row.createSpan({ cls: "okf-project-card__field-value", text: value || "—" });
}

function countLabel(project: ProjectSummary): string {
  return [
    `决定 ${project.decisions.length}`,
    `产出 ${project.outputs.length}`,
    `学习 ${project.related_learning.length}`,
    `资料 ${project.related_materials.length}`,
    `待处理 ${project.pending_captures.length}`,
    `任务 ${project.open_tasks.length}`,
  ].join(" · ");
}

export function projectFormalTasks(project: ProjectSummary, tasks: readonly VaultTask[]): VaultTask[] {
  const root = project.path.split("/").slice(0, -1).join("/") + "/";
  return tasks.filter((task) => task.formal && !task.checked && task.path.startsWith(root));
}

function renderProjectTasks(
  container: HTMLElement,
  tasks: readonly VaultTask[],
  host: ProjectSectionHost,
  app: App,
): void {
  const field = container.createDiv({ cls: "okf-project-card__field" });
  field.createSpan({ cls: "okf-project-card__field-label", text: "待办" });
  const list = field.createDiv({ cls: "okf-project-card__task-list" });
  if (tasks.length === 0) {
    list.createSpan({ cls: "okf-project-card__field-value", text: "—" });
    return;
  }
  for (const task of tasks.slice(0, 3)) {
    const row = list.createDiv({ cls: "okf-project-card__task" });
    const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": `完成 ${task.text}` } });
    checkbox.addEventListener("change", () => {
      checkbox.disabled = true;
      void toggleTaskInFile(app, task, checkbox.checked)
        .then((wrote) => {
          if (!wrote) {
            checkbox.checked = task.checked;
            new Notice("任务已变化，请刷新后重试。", 5_000);
            return;
          }
          invalidatePath(task.path);
          row.remove();
        })
        .catch((error: unknown) => {
          checkbox.checked = task.checked;
          new Notice(error instanceof Error ? error.message : "任务更新失败", 5_000);
        })
        .finally(() => { checkbox.disabled = false; });
    });
    const open = row.createEl("button", { text: task.text, attr: { type: "button", title: task.path } });
    open.addEventListener("click", () => void host.openVaultPath(task.path));
  }
}

function renderProjectCard(
  container: HTMLElement,
  project: ProjectSummary,
  tasks: readonly VaultTask[],
  host: ProjectSectionHost,
  app: App,
): void {
  const status = projectLifecycleStatus(project);
  const card = container.createDiv({ cls: "okf-project-card" });
  const heading = card.createDiv({ cls: "okf-project-card__heading" });
  const title = heading.createEl("button", {
    cls: "okf-project-card__title",
    text: project.title,
    attr: { type: "button", title: `打开 ${project.path}` },
  });
  title.addEventListener("click", () => void host.openVaultPath(project.path));
  heading.createSpan({ cls: `okf-project-card__status is-${status}`, text: STATUS_OPTIONS.find((item) => item.value === status)?.label ?? status });

  const fields = card.createDiv({ cls: "okf-project-card__fields" });
  labeledValue(fields, "当前状态", project.current_state);
  labeledValue(fields, "下一步", project.next_action);
  labeledValue(fields, "最近进展", project.recent_log);
  renderProjectTasks(fields, tasks, host, app);
  card.createDiv({ cls: "okf-project-card__counts", text: countLabel(project) });

  const actions = card.createDiv({ cls: "okf-project-card__actions" });
  const progress = actions.createEl("button", { text: "记录进展", attr: { type: "button" } });
  progress.addEventListener("click", () => host.promptProjectProgress(project.path));
  const decision = actions.createEl("button", { text: "新建决定", attr: { type: "button" } });
  decision.addEventListener("click", () => host.promptProjectDecision(project.path));
  const statusButton = actions.createEl("button", { text: "更改状态", attr: { type: "button" } });
  statusButton.addEventListener("click", () => host.promptProjectStatus(project.path, status));
  const log = actions.createEl("button", { text: "打开日志", attr: { type: "button" } });
  log.addEventListener("click", () => void host.openVaultPath(project.log_path));
}

export function createProjectSectionDefinition(host: ProjectSectionHost): CustomSectionDefinition {
  return {
    type: OKF_PROJECT_SECTION_TYPE,
    icon: "folder-kanban",
    label: "项目（OKF）",
    defaultName: "项目",
    async render({ container, column, app, setConfig }): Promise<void> {
      const config = normalizeProjectSectionConfig(column.extensionConfig);
      const toolbar = container.createDiv({ cls: "okf-project-section__toolbar" });
      const filters = toolbar.createDiv({ cls: "okf-project-section__filters" });
      for (const option of STATUS_OPTIONS) {
        const enabled = config.statuses.includes(option.value);
        const button = filters.createEl("button", {
          cls: `okf-project-section__filter${enabled ? " is-active" : ""}`,
          text: option.label,
          attr: { type: "button", "aria-pressed": String(enabled) },
        });
        button.addEventListener("click", () => {
          const statuses = enabled
            ? config.statuses.filter((status) => status !== option.value)
            : [...config.statuses, option.value];
          setConfig({ statuses: statuses.length > 0 ? statuses : [option.value] });
        });
      }
      const create = toolbar.createEl("button", {
        cls: "mod-cta okf-project-section__create",
        text: "新建项目",
        attr: { type: "button" },
      });
      create.addEventListener("click", () => host.promptProject());

      const loading = container.createDiv({ cls: "dashboard-library-empty", text: "正在读取项目…" });
      const [{ projects }, tasks] = await Promise.all([
        new VaultDashboardReader(app).projects(),
        collectVaultTasks(app),
      ]);
      loading.remove();
      const visible = filterProjects(projects, config);
      if (visible.length === 0) {
        container.createDiv({ cls: "dashboard-library-empty", text: "当前筛选条件下没有项目。" });
        return;
      }
      const grid = container.createDiv({ cls: "okf-project-section__grid" });
      for (const project of visible) {
        renderProjectCard(grid, project, projectFormalTasks(project, tasks), host, app);
      }
    },
  };
}

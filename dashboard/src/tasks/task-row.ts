import { MarkdownRenderer, type App, type Component } from "obsidian";
import type { VaultTask } from "../../apex/src/alltasks-scan.js";
import { toIsoDate } from "../../apex/src/alltasks-scan.js";
import { renderTaskCheckbox } from "../../apex/src/task-checkbox.js";
import { taskDateLabels, taskIsOverdue, TASK_PRIORITY_LABELS } from "./task-presentation.js";
import type { UpstreamTask } from "../../tasks-generated/core.js";
import { taskDisplayDescription } from "../../tasks-generated/core.js";

export interface TaskRowOptions {
  app: App;
  component: Component;
  task: VaultTask;
  allTasks: readonly UpstreamTask[];
  toggle(checked: boolean): Promise<boolean>;
  details(): void;
  source(): void;
  dates(): void;
  menu(trigger: HTMLElement): void;
  notify(message: string): void;
}

export function renderTaskRow(parent: HTMLElement, options: TaskRowOptions): HTMLElement {
  const { task } = options;
  const row = parent.createDiv({ cls: `okf-formal-task-row${task.checked ? " is-closed" : ""}${task.statusType === "CANCELLED" ? " is-cancelled" : ""}${taskIsOverdue(task) ? " is-overdue" : ""}` });
  row.dataset.taskIdentity = `${task.path}:${task.blockId ?? task.line}`;
  renderTaskCheckbox(row, { text: task.text, checked: task.checked, toggle: options.toggle, notify: options.notify });
  const main = row.createDiv({ cls: "okf-formal-task-row__main" });
  const title = main.createDiv({ cls: "okf-formal-task-row__title", attr: { role: "button", tabindex: "0", "aria-label": `查看待办：${task.text}` } });
  void MarkdownRenderer.render(options.app, task.text, title, task.path, options.component).catch(error => {
    title.createSpan({ text: `内容无法显示：${error instanceof Error ? error.message : "渲染失败"}` });
  });
  title.addEventListener("click", event => { if (!(event.target as HTMLElement).closest?.("a")) options.details(); });
  title.addEventListener("keydown", event => { if (event.target === title && ["Enter", " "].includes(event.key)) { event.preventDefault(); options.details(); } });
  const meta = main.createDiv({ cls: "okf-formal-task-row__meta" });
  const source = meta.createEl("button", { text: String(options.app.metadataCache?.getFileCache(task.file)?.frontmatter?.title ?? task.file.basename),
    cls: "okf-task-source", attr: { type: "button", title: task.path, "aria-label": "定位任务来源" } });
  source.addEventListener("click", options.source);
  const contextTitle = (path: string): string => {
    const file = options.app.vault.getAbstractFileByPath(path.replace(/^\//u, ""));
    return file ? String(options.app.metadataCache.getFileCache(file as typeof task.file)?.frontmatter?.title ?? file.name.replace(/\.md$/u, "")) : path;
  };
  for (const [kind, path] of [["课程", task.course], ["项目", task.project]]) if (path) {
    if (path.replace(/^\//u, "") === task.path) source.setText(`${kind}：${contextTitle(path)}`);
    else meta.createSpan({ cls: "okf-task-context", text: `${kind}：${contextTitle(path)}` });
  }
  const statusNames: Record<string, string> = { Todo: "待完成", Done: "已完成", "In Progress": "进行中", Cancelled: "已取消", "On Hold": "等待" };
  if (task.upstream?.status && task.statusType !== "TODO") {
    const status = meta.createEl("button", { cls: "okf-dashboard__badge", text: statusNames[task.upstream.status.name] ?? task.upstream.status.name, attr: { type: "button", title: "编辑状态" } });
    status.addEventListener("click", options.details);
  }
  if (task.upstream?.priority && task.upstream.priority !== "3") meta.createSpan({ cls: "okf-dashboard__badge", text: `优先级：${TASK_PRIORITY_LABELS[task.upstream.priority]}` });
  if (task.recurrence) meta.createSpan({ cls: "okf-dashboard__badge", text: `循环：${task.recurrence}` });
  if (task.upstream?.isBlocked(options.allTasks)) {
    const blocked = meta.createEl("button", { cls: "okf-dashboard__badge", text: "前置任务未完成", attr: { type: "button" } });
    blocked.addEventListener("click", options.details);
  }
  if (task.upstream?.parent) meta.createSpan({ cls: "okf-task-parent", text: `父项：${taskDisplayDescription(task.upstream.parent.description)}` });
  const dates = meta.createEl("button", { cls: "okf-formal-task-row__dates", text: taskDateLabels(task, toIsoDate(new Date())).join(" · ") || "安排日期",
    attr: { type: "button", "aria-label": "编辑任务日期" } });
  dates.addEventListener("click", task.checked ? options.details : options.dates);
  const actions = row.createDiv({ cls: "okf-formal-task-row__actions" });
  const more = actions.createEl("button", { text: "···", cls: "okf-task-more", attr: { type: "button", "aria-label": "待办的更多操作" } });
  options.menu(more);
  return row;
}

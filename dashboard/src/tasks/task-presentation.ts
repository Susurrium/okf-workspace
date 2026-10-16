import type { VaultTask } from "../../apex/src/alltasks-scan.js";
import { indexTasksByDay, toIsoDate } from "../../apex/src/alltasks-scan.js";

export type TaskView = "all" | "today" | "overdue" | "upcoming" | "unscheduled" | "done" | "cancelled" | "checklists" | "custom";
export const TASK_VIEW_LABELS: Readonly<Record<TaskView, string>> = {
  all: "未完成任务", today: "今日任务", overdue: "逾期任务", upcoming: "后续安排", unscheduled: "无日期", done: "已完成",
  cancelled: "已取消", checklists: "工作台清单", custom: "自定义查询",
};
export const TASK_PRIORITY_LABELS: Readonly<Record<string, string>> = {
  "0": "最高", "1": "高", "2": "中", "3": "普通", "4": "低", "5": "最低",
};

export function taskIdentity(task: VaultTask): string { return `${task.path}:${task.line}`; }

export function taskIsOverdue(task: VaultTask, now = new Date()): boolean {
  if (task.checked || !task.due) return false;
  const today = toIsoDate(now);
  if (task.due !== today) return task.due < today;
  return Boolean(task.dueTime && task.dueTime < `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
}

export function taskMatchesView(task: VaultTask, view: TaskView, now = new Date()): boolean {
  if (view === "checklists") return false;
  if (!task.formal) return false;
  if (view === "custom") return true;
  if (view === "done") return task.statusType === "DONE";
  if (view === "cancelled") return task.statusType === "CANCELLED";
  if (task.checked) return false;
  const today = toIsoDate(now);
  if (view === "today") return Boolean(indexTasksByDay([task]).get(today)?.length);
  if (view === "overdue") return taskIsOverdue(task, now);
  if (view === "upcoming") return [task.scheduled, task.due, task.start, task.end, task.reminder?.slice(0, 10)].some(date => date && date > today);
  if (view === "unscheduled") return ![task.scheduled, task.due, task.start, task.end, task.reminder].some(Boolean);
  return true;
}

export function taskDateLabels(task: VaultTask, day?: string): string[] {
  if (task.statusType === "DONE") return [task.completion ? `完成 ${task.completion}${task.completionTime ? ` ${task.completionTime}` : ""}` : "未记录完成日期"];
  if (task.statusType === "CANCELLED") return [task.cancelled ? `取消 ${task.cancelled}` : "未记录取消日期"];
  const labels = [
    task.scheduled ? { day: task.scheduled, label: `计划 ${task.scheduled}${task.scheduledTime ? ` ${task.scheduledTime}` : ""}` } : undefined,
    task.due ? { day: task.due, label: `截止 ${task.due}${task.dueTime ? ` ${task.dueTime}` : ""}` } : undefined,
    task.reminder ? { day: task.reminder.slice(0, 10), label: `提醒 ${task.reminder}` } : undefined,
    task.start ? { day: task.start, label: `开始 ${task.start}${task.startTime ? ` ${task.startTime}` : ""}` } : undefined,
    task.end ? { day: task.end, label: `结束 ${task.end}${task.endTime ? ` ${task.endTime}` : ""}` } : undefined,
  ].filter((value): value is { day: string; label: string } => Boolean(value));
  if (day) labels.sort((left, right) => Number(right.day === day) - Number(left.day === day));
  return labels.map(value => value.label);
}

export function sortTasks(tasks: readonly VaultTask[], sort: string, view: TaskView): VaultTask[] {
  const order = sort || (view === "done" ? "completion" : view === "cancelled" ? "cancelled" : "due");
  const value = (task: VaultTask): string => order === "title" ? task.text : order === "priority" ? task.upstream?.priority ?? "3"
    : order === "completion" ? task.completion ?? "" : order === "cancelled" ? task.cancelled ?? ""
      : order === "scheduled" ? `${task.scheduled ?? "9999"} ${task.scheduledTime ?? ""}` : `${task.due ?? "9999"} ${task.dueTime ?? ""}`;
  return [...tasks].sort((left, right) => (order === "completion" || order === "cancelled" ? -1 : 1)
    * value(left).localeCompare(value(right), "zh-CN") || left.path.localeCompare(right.path) || left.line - right.line);
}

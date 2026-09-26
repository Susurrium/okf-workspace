import { Notice, type App } from "obsidian";

import type { CustomSectionDefinition } from "../../../apex/src/section-registry.js";
import {
  collectVaultTasks,
  indexTasksByDay,
  invalidatePath,
  toggleTaskInFile,
  type VaultTask,
} from "../../../apex/src/alltasks-scan.js";

export const OKF_TODAY_SECTION_TYPE = "workspace-today";

export interface TodaySectionHost {
  openDailyForWriting(): Promise<void>;
  promptDailyCapture(): void;
  promptTaskDates(task: VaultTask): void;
  openVaultPath(path: string): Promise<void>;
}

function taskDates(task: VaultTask): string {
  return [
    task.reminder ? `提醒 ${task.reminder}` : "",
    task.scheduled ? `计划 ${task.scheduled}${task.scheduledTime ? ` ${task.scheduledTime}` : ""}` : "",
    task.due ? `截止 ${task.due}` : "",
  ].filter(Boolean).join(" · ");
}

export function localIsoDate(value = new Date()): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

export function todayFormalTasks(tasks: readonly VaultTask[], date: string): VaultTask[] {
  const formalOpen = tasks.filter((task) => task.formal && !task.checked);
  return indexTasksByDay(formalOpen).get(date) ?? [];
}

function renderTask(container: HTMLElement, task: VaultTask, host: TodaySectionHost, app: App): void {
  const row = container.createDiv({ cls: "okf-today-task" });
  const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": `完成 ${task.text}` } });
  checkbox.checked = task.checked;
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
  const title = row.createEl("button", {
    cls: "okf-today-task__title",
    text: task.text,
    attr: { type: "button", title: task.path },
  });
  title.addEventListener("click", () => void host.openVaultPath(task.path));
  const dates = row.createEl("button", {
    cls: "okf-today-task__dates",
    text: taskDates(task) || "设置日期",
    attr: { type: "button", title: "分别编辑提醒、计划日和截止日" },
  });
  dates.addEventListener("click", () => host.promptTaskDates(task));
  row.createSpan({ cls: "okf-today-task__source", text: task.file.basename });
}

export function createTodaySectionDefinition(host: TodaySectionHost): CustomSectionDefinition {
  return {
    type: OKF_TODAY_SECTION_TYPE,
    icon: "calendar-check-2",
    label: "今天",
    defaultName: "今天",
    async render({ container, app }): Promise<void> {
      const actions = container.createDiv({ cls: "okf-today-section__actions" });
      const daily = actions.createEl("button", { cls: "mod-cta", text: "打开今日日记", attr: { type: "button" } });
      daily.addEventListener("click", () => void host.openDailyForWriting());
      const capture = actions.createEl("button", { text: "随手记录", attr: { type: "button" } });
      capture.addEventListener("click", () => host.promptDailyCapture());

      const loading = container.createDiv({ cls: "dashboard-library-empty", text: "正在读取今日任务…" });
      const tasks = todayFormalTasks(await collectVaultTasks(app), localIsoDate());
      loading.remove();
      if (tasks.length === 0) {
        container.createDiv({ cls: "dashboard-library-empty", text: "今天没有已安排的任务。" });
        return;
      }
      const list = container.createDiv({ cls: "okf-today-section__tasks" });
      for (const task of tasks) renderTask(list, task, host, app);
    },
  };
}

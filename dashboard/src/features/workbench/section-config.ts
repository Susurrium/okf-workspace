import type { NoteSummary } from "../../api/types.js";
import { normalizedVaultPath } from "../../domain/note-identity.js";

export type SurfaceHost = "workbench" | "page";
export function sectionSupportsSort(section: string): boolean {
  return ["inbox", "sources", "learning", "projects", "knowledge", "life"].includes(section);
}
export interface WorkbenchSectionConfig {
  limit: number;
  itemsPerEdition: number;
  sourcePageSize: number;
  sort: "modified" | "title";
  course?: string;
  project?: string;
  statuses?: string[];
  showDailyUpdates: boolean;
  readingView: "subscriptions" | "daily-updates";
  feedStreams?: string[];
  taskView: "overview" | "all" | "today" | "overdue" | "upcoming" | "unscheduled" | "done" | "cancelled" | "checklists" | "custom";
}

export function readWorkbenchSectionConfig(raw: Record<string, unknown> = {}, host: SurfaceHost = "workbench"): WorkbenchSectionConfig {
  if (raw.mode !== undefined && !["summary", "embedded", "full"].includes(String(raw.mode))) throw new Error("分区展示方式无效");
  const sort = raw.sort ?? "modified";
  if (!["modified", "title"].includes(String(sort))) throw new Error("分区排序方式无效");
  // 旧模式只用于恢复历史数量，不能决定业务能力。
  const limit = raw.pageSize ?? raw.limit ?? (raw.mode === "summary" ? 5 : raw.mode ? 50 : host === "page" ? 30 : 10);
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("分区条目数量必须为 1–200 的整数");
  }
  const itemsPerEdition = raw.itemsPerEdition ?? (raw.mode === "summary" ? 2 : host === "workbench" ? 5 : 30);
  if (typeof itemsPerEdition !== "number" || !Number.isInteger(itemsPerEdition) || itemsPerEdition < 1 || itemsPerEdition > 200) {
    throw new Error("每期预览数量必须为 1–200 的整数");
  }
  const path = (key: "course" | "project"): string | undefined => {
    const value = raw[key];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string") throw new Error(`${key} 分区关系必须为笔记路径`);
    const normalized = value.trim().replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
    const pattern = key === "course" ? /^learning\/courses\/[^/]+\/course\.md$/u : /^projects\/[^/]+\/project\.md$/u;
    if (!pattern.test(normalized) || normalized.split("/").some((part) => [".", ".."].includes(part) || part.includes(":"))) {
      throw new Error(`${key} 分区关系路径无效：${value}`);
    }
    return normalized;
  };
  const sourcePageSize = raw.sourcePageSize ?? Math.min(8, limit);
  if (typeof sourcePageSize !== "number" || !Number.isInteger(sourcePageSize) || sourcePageSize < 1 || sourcePageSize > 8) {
    throw new Error("每批订阅来源数必须为 1–8 的整数");
  }
  const strings = (key: "statuses" | "feedStreams", allowed: readonly string[]): string[] | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !allowed.includes(item))) {
      throw new Error(`${key} 分区筛选无效`);
    }
    return [...new Set(value as string[])];
  };
  if (raw.showDailyUpdates !== undefined && typeof raw.showDailyUpdates !== "boolean") {
    throw new Error("每日更新显示设置必须为布尔值");
  }
  const readingView = raw.readingView ?? "subscriptions";
  if (!["subscriptions", "daily-updates"].includes(String(readingView))) throw new Error("订阅展示范围无效");
  const taskView = raw.taskView ?? "overview";
  if (!["overview", "all", "today", "overdue", "upcoming", "unscheduled", "done", "cancelled", "checklists", "custom"].includes(String(taskView))) throw new Error("任务范围无效");
  for (const key of ["folders", "excludeFolders", "taskViewFolders"]) {
    const paths = raw[key];
    if (paths !== undefined && (!Array.isArray(paths) || paths.some(path => typeof path !== "string" || path.replace(/\\/gu, "/").split("/").some(part => [".", ".."].includes(part) || part.includes(":"))))) {
      throw new Error(`${key} 必须为 Vault 内的文件夹路径列表`);
    }
  }
  return {
    sort: sort as WorkbenchSectionConfig["sort"], limit, itemsPerEdition, sourcePageSize,
    course: path("course"), project: path("project"),
    statuses: strings("statuses", ["active", "paused", "completed"]),
    feedStreams: strings("feedStreams", ["hotspot", "news", "treehole"]),
    showDailyUpdates: raw.showDailyUpdates !== false,
    readingView: readingView as WorkbenchSectionConfig["readingView"],
    taskView: taskView as WorkbenchSectionConfig["taskView"],
  };
}

export function operationMatchesSectionContext(item: { course?: string | null; project?: string | null },
  config: Pick<WorkbenchSectionConfig, "course" | "project">): boolean {
  const match = (value: string | null | undefined, expected: string | undefined, kind: "course" | "project"): boolean =>
    !expected || normalizedVaultPath(value) === normalizedVaultPath(expected) ||
    Boolean(value && !value.includes("/") && value === expected.split("/")[kind === "course" ? 2 : 1]);
  return match(item.course, config.course, "course") && match(item.project, config.project, "project");
}

export function workbenchInstanceKey(workbenchPath: string, sectionId: string): string {
  return JSON.stringify([normalizedVaultPath(workbenchPath.replace(/\.md$/iu, "")), sectionId]);
}

export function noteMatchesSectionContext(note: NoteSummary, config: Pick<WorkbenchSectionConfig, "course" | "project">): boolean {
  const course = normalizedVaultPath(config.course);
  const project = normalizedVaultPath(config.project);
  const matches = (relation: { course?: string | null; project?: string | null }): boolean =>
    (!course || normalizedVaultPath(relation.course) === course) &&
    (!project || normalizedVaultPath(relation.project) === project);
  if (!course && !project) return true;
  if (note.note_type === "Course") return Boolean(course) && normalizedVaultPath(note.path) === course;
  if (note.note_type === "Project") return Boolean(project) && normalizedVaultPath(note.path) === project;
  if (note.note_type === "Source" && !note.purpose && note.uses?.length) return note.uses.some(matches);
  const inheritedCourse = note.course ?? /^learning\/courses\/([^/]+)\//u.exec(note.path)?.[1];
  return matches({ ...note, course: note.course ?? (inheritedCourse ? `learning/courses/${inheritedCourse}/course.md` : null) });
}

export function sectionScopeLabel(config: Pick<WorkbenchSectionConfig, "course" | "project">,
  titles: ReadonlyMap<string, string> = new Map()): string {
  return [config.course ? `课程：${titles.get(dashboardPathForTitle(config.course)) ?? config.course.split("/")[2]}` : "",
    config.project ? `项目：${titles.get(dashboardPathForTitle(config.project)) ?? config.project.split("/")[1]}` : ""].filter(Boolean).join(" · ") || "全部内容";
}

function dashboardPathForTitle(path: string): string { return path.replace(/^\/+|\/+$/gu, ""); }

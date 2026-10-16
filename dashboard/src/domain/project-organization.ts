import type { ProjectSummary } from "../api/types.js";
import { projectLifecycleStatus, projectStatusLabel } from "./workspace-status.js";

export function projectCategory(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("项目类别必须是字符串");
  const category = value.trim();
  if (!category) return null;
  if ([...category].length > 80 || /[\u0000-\u001f\u007f]/u.test(category)) throw new Error("项目类别应为 1–80 个字符，不含控制字符");
  return category;
}

export interface ProjectOrganization {
  view: "list" | "kanban";
  group: "none" | "status" | "category";
  sort: "title" | "modified" | "manual";
  category: string;
  pinned: string[];
  order: string[];
}

function paths(value: unknown): string[] {
  if (value === undefined) return [];
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string" || !/^projects\/[^/]+\/project\.md$/u.test(item)
    || item.split("/").some(part => part === "." || part === ".." || part.includes(":")))) throw new Error("项目显示顺序包含无效路径");
  return [...new Set(parsed as string[])];
}

export function readProjectOrganization(filters: Record<string, unknown> = {}, sort: "title" | "modified" = "modified"): ProjectOrganization {
  const view = filters.projectView ?? "list";
  const group = filters.projectGroup ?? "none";
  const ordering = filters.projectSort ?? sort;
  if (typeof view !== "string" || typeof group !== "string" || typeof ordering !== "string"
    || !["list", "kanban"].includes(view) || !["none", "status", "category"].includes(group) || !["title", "modified", "manual"].includes(ordering)) throw new Error("项目展示配置无效");
  const category = filters.projectCategory ?? "*";
  if (typeof category !== "string") throw new Error("项目类别筛选无效");
  if (category !== "*") projectCategory(JSON.parse(category));
  return { view: view as ProjectOrganization["view"], group: group as ProjectOrganization["group"], sort: ordering as ProjectOrganization["sort"],
    category, pinned: paths(filters.projectPinned), order: paths(filters.projectOrder) };
}

export function projectOrganizationFilters(value: ProjectOrganization): Record<string, string> {
  return { projectView: value.view, projectGroup: value.group, projectSort: value.sort, projectCategory: value.category,
    projectPinned: JSON.stringify(value.pinned), projectOrder: JSON.stringify(value.order) };
}

export function orderedProjects(projects: readonly ProjectSummary[], prefs: ProjectOrganization): ProjectSummary[] {
  const rank = new Map(prefs.order.map((path, index) => [path, index]));
  const pins = new Map(prefs.pinned.map((path, index) => [path, index]));
  return [...projects].sort((a, b) => {
    const pa = pins.get(a.path), pb = pins.get(b.path);
    if (pa !== undefined || pb !== undefined) return (pa ?? Infinity) - (pb ?? Infinity);
    if (prefs.sort === "manual") {
      const ra = rank.get(a.path), rb = rank.get(b.path);
      if (ra !== undefined || rb !== undefined) return (ra ?? Infinity) - (rb ?? Infinity);
    }
    if (prefs.sort === "modified") return (b.modified_at ?? "").localeCompare(a.modified_at ?? "");
    if (prefs.sort === "manual") return 0;
    return a.title.localeCompare(b.title, "zh-CN") || a.path.localeCompare(b.path);
  });
}

export function projectGroups(projects: readonly ProjectSummary[], prefs: ProjectOrganization): { key: string; label: string; projects: ProjectSummary[] }[] {
  const group = prefs.view === "kanban" && prefs.group === "none" ? "status" : prefs.group;
  if (group === "none") return [{ key: "all", label: "全部项目", projects: [...projects] }];
  if (group === "status") return (["active", "paused", "completed"] as const).map(key => ({
    key, label: projectStatusLabel(key), projects: projects.filter(project => projectLifecycleStatus(project) === key),
  }));
  const names = [...new Set(projects.map(project => projectCategory(project.project_category)))];
  names.sort((a, b) => a === null ? 1 : b === null ? -1 : a.localeCompare(b, "zh-CN"));
  if (!names.includes(null)) names.push(null);
  return names.map(name => ({ key: JSON.stringify(name), label: name ?? "未分类",
    projects: projects.filter(project => projectCategory(project.project_category) === name) }));
}

import { serialize } from "../../apex/src/parser.js";
import type { DashboardColumn, DashboardData } from "../../apex/src/types.js";
import type { WorkspacePresetOption } from "../../apex/src/host.js";

export type WorkbenchPresetId = "daily" | "learning" | "project" | "reading";

export const WORKBENCH_PRESETS: readonly WorkspacePresetOption[] = [
  { id: "daily", label: "日常", description: "今日行动、待处理、项目、日历与每日阅读" },
  { id: "learning", label: "学习", description: "课程、学习材料、知识与资料入口" },
  { id: "project", label: "项目", description: "正式项目、项目行动与相关学习" },
  { id: "reading", label: "阅读", description: "Feed 订阅、历史、微信读书与阅读工具" },
] as const;

const BANNER = {
  quote: "把真实工作放在一个工作台里。",
  author: "OKF Workspace",
  image: "https://images.pexels.com/photos/2307638/pexels-photo-2307638.jpeg",
};

function column(
  id: string,
  name: string,
  sectionType: string,
  color: string,
  options: Partial<DashboardColumn> = {},
): DashboardColumn {
  return { id, name, sectionType, color, cards: [], ...options };
}

export function workbenchPresetData(preset: WorkbenchPresetId = "daily"): DashboardData {
  const columns: Record<WorkbenchPresetId, DashboardColumn[]> = {
    daily: [
      column("daily-memo", "随手记", "memo", "#f59e0b"),
      column("daily-today", "今日", "workspace-today", "#6366f1"),
      column("daily-inbox", "待处理", "workspace-inbox", "#ef8b45", { half: true }),
      column("daily-projects", "近期项目", "workspace-projects", "#10b981", {
        half: true,
        extensionConfig: { statuses: ["active"] },
      }),
      column("daily-calendar", "日历", "calendar", "#3b82f6"),
      column("daily-reading", "每日阅读", "workspace-reading", "#8b5cf6"),
    ],
    learning: [
      column("learning-main", "学习", "workspace-learning", "#6366f1"),
      column("learning-inbox", "待处理资料", "workspace-inbox", "#ef8b45", { half: true }),
      column("learning-knowledge", "知识", "workspace-knowledge", "#8b5cf6", { half: true }),
      column("learning-notes", "学习便签", "memo", "#f59e0b"),
    ],
    project: [
      column("project-main", "项目", "workspace-projects", "#10b981"),
      column("project-today", "项目行动", "workspace-today", "#6366f1", { half: true }),
      column("project-learning", "相关学习", "workspace-learning", "#8b5cf6", { half: true }),
      column("project-notes", "项目便签", "notes", "#f59e0b"),
    ],
    reading: [
      column("reading-feed", "订阅与 Feed", "workspace-reading", "#8b5cf6"),
      column("reading-weread", "微信读书", "weread", "#10b981"),
      column("reading-knowledge", "已整理知识", "workspace-knowledge", "#3b82f6"),
    ],
  };
  return {
    workbenchSchema: 1,
    banner: { ...BANNER },
    quickActions: [
      { name: "全局搜索", icon: "search", type: "command", target: "global-search:open" },
    ],
    columns: columns[preset].map((item) => ({ ...item })),
    bodyPreamble: "此文件保存工作台布局与原生便签；OKF 对象仍以各自 Vault 文件为准。",
  };
}

export function generateWorkbenchPresetMarkdown(presetId?: string): string {
  const preset = WORKBENCH_PRESETS.some((item) => item.id === presetId)
    ? presetId as WorkbenchPresetId
    : "daily";
  return serialize(workbenchPresetData(preset));
}

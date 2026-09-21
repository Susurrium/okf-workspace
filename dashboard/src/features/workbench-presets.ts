import { serialize } from "../../apex/src/parser.js";
import type { DashboardColumn, DashboardData } from "../../apex/src/types.js";
import type { WorkspacePresetOption } from "../../apex/src/host.js";

export type WorkbenchPresetId = "daily" | "learning" | "project" | "reading" | "life" | "system";

export const WORKBENCH_PRESETS: readonly WorkspacePresetOption[] = [
  { id: "daily", label: "日常", description: "今日行动、待处理、项目、日历与每日阅读" },
  { id: "learning", label: "学习", description: "课程、学习材料、知识与资料入口" },
  { id: "project", label: "项目", description: "正式项目、今日行动、学习工作区与资料入口" },
  { id: "reading", label: "阅读", description: "Feed 订阅、历史、微信读书与阅读工具" },
  { id: "life", label: "生活", description: "Daily、Reflection、Review 与记录整理" },
  { id: "system", label: "系统", description: "后台任务、失败恢复、诊断与维护" },
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
      column("daily-life", "生活记录", "workspace-life", "#ec4899", { half: true }),
      column("daily-system", "系统与后台任务", "workspace-system", "#64748b", { half: true }),
    ],
    learning: [
      column("learning-main", "学习", "workspace-learning", "#6366f1"),
      column("learning-inbox", "待处理资料", "workspace-inbox", "#ef8b45", { half: true }),
      column("learning-knowledge", "知识", "workspace-knowledge", "#8b5cf6", { half: true }),
      column("learning-notes", "学习便签", "memo", "#f59e0b"),
      column("learning-system", "学习任务状态", "workspace-system", "#64748b"),
    ],
    project: [
      column("project-main", "项目", "workspace-projects", "#10b981"),
      column("project-today", "今日行动", "workspace-today", "#6366f1", { half: true }),
      column("project-learning", "学习工作区", "workspace-learning", "#8b5cf6", { half: true }),
      column("project-notes", "项目便签", "notes", "#f59e0b"),
      column("project-inbox", "项目资料入口", "workspace-inbox", "#ef8b45"),
    ],
    reading: [
      column("reading-feed", "订阅与 Feed", "workspace-reading", "#8b5cf6"),
      column("reading-weread", "微信读书", "weread", "#10b981"),
      column("reading-knowledge", "知识工作区", "workspace-knowledge", "#3b82f6"),
      column("reading-inbox", "阅读资料入口", "workspace-inbox", "#ef8b45"),
    ],
    life: [
      column("life-main", "生活", "workspace-life", "#ec4899"),
      column("life-today", "今天", "workspace-today", "#6366f1"),
      column("life-calendar", "日历", "calendar", "#3b82f6"),
      column("life-memo", "随手记", "memo", "#f59e0b"),
    ],
    system: [
      column("system-main", "系统与后台任务", "workspace-system", "#64748b"),
      column("system-inbox", "转换与待处理", "workspace-inbox", "#ef8b45"),
    ],
  };
  return {
    workbenchSchema: 1,
    banner: { ...BANNER },
    quickActions: [
      { name: "全局搜索", icon: "search", type: "command", target: "global-search:open" },
      { name: "快速创建", icon: "plus", type: "command", target: "okf-workspace-dashboard:open-action-menu" },
      { name: "问我的笔记", icon: "message-circle", type: "command", target: "okf-workspace-dashboard:ask-notes" },
      { name: "导入资料", icon: "file-up", type: "command", target: "okf-workspace-dashboard:import-document" },
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

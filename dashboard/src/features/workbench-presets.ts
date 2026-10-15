import { serialize } from "../../apex/src/parser.js";
import type { DashboardColumn, DashboardData } from "../../apex/src/types.js";
import type { WorkspacePresetOption } from "../../apex/src/host.js";

export type WorkbenchPresetId = "daily" | "learning" | "project" | "reading" | "knowledge" | "life" | "system";

export const WORKBENCH_PRESETS: readonly WorkspacePresetOption[] = [
  { id: "daily", label: "日常", description: "今日行动、便签、每日更新与日历" },
  { id: "learning", label: "学习", description: "完整学习功能、课程关系与学习便签" },
  { id: "project", label: "项目", description: "完整项目功能、关联内容与项目便签" },
  { id: "reading", label: "订阅阅读", description: "来源、历史、微信读书与阅读工具" },
  { id: "knowledge", label: "知识", description: "知识目录、核验、复核与导航维护" },
  { id: "life", label: "日记与复盘", description: "日记、反思、复盘与记录整理" },
  { id: "system", label: "系统", description: "后台任务、失败恢复、诊断与维护" },
] as const;

const BANNER = {
  quote: "记录今天，继续重要的事。",
  author: "",
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

export function workbenchPresetData(preset: WorkbenchPresetId = "daily", context: Record<string, unknown> = {}): DashboardData {
  const columns: Record<WorkbenchPresetId, DashboardColumn[]> = {
    daily: [
      column("daily-today", "今天", "workspace-today", "#6366f1", {
        extensionConfig: { showDailyUpdates: false, pageSize: 5 },
      }),
      column("daily-memo", "工作台便签", "memo", "#f59e0b"),
      column("daily-updates", "每日更新", "workspace-updates", "#8b5cf6", {
        extensionConfig: { itemsPerEdition: 3, readingView: "daily-updates", feedStreams: ["hotspot", "news", "treehole"] },
      }),
      column("daily-calendar", "日历", "calendar", "#3b82f6", { extensionConfig: { initialView: "week" } }),
    ],
    learning: [
      column("learning-main", "学习", "workspace-learning", "#6366f1"),
      column("learning-notes", "学习便签", "memo", "#f59e0b"),
    ],
    project: [
      column("project-main", "项目", "workspace-projects", "#10b981"),
      column("project-notes", "工作台便签", "memo", "#f59e0b"),
    ],
    reading: [
      column("reading-feed", "订阅", "workspace-reading", "#8b5cf6"),
      column("reading-weread", "微信读书", "weread", "#10b981"),
    ],
    knowledge: [
      column("knowledge-main", "知识", "workspace-knowledge", "#8b5cf6"),
    ],
    life: [
      column("life-main", "日记与复盘", "workspace-life", "#ec4899"),
      column("life-calendar", "日历", "calendar", "#3b82f6"),
      column("life-memo", "随手记", "memo", "#f59e0b"),
    ],
    system: [
      column("system-main", "后台与诊断", "workspace-system", "#64748b"),
    ],
  };
  return {
    workbenchSchema: 1,
    banner: { ...BANNER },
    quickActions: [
      { name: "快速记录", icon: "pencil", type: "command", target: "okf-workspace-dashboard:quick-capture" },
      { name: "新建待办", icon: "list-plus", type: "command", target: "okf-workspace-dashboard:new-task" },
      { name: "全局搜索", icon: "search", type: "command", target: "global-search:open" },
      { name: "快捷操作", icon: "plus", type: "command", target: "okf-workspace-dashboard:open-action-menu" },
    ],
    hiddenPresets: ["p:daily-notes", "p:file-explorer:new-file"],
    columns: columns[preset].map((item) => ({ ...item,
      ...(item.sectionType?.startsWith("workspace-") ? { extensionConfig: { ...item.extensionConfig, ...context } } : {}) })),
    bodyPreamble: "这里保存工作台布局和便签；课程、项目及其他笔记保存在各自文件中。",
  };
}

export function generateWorkbenchPresetMarkdown(presetId?: string, context?: Record<string, unknown>): string {
  const preset = WORKBENCH_PRESETS.some((item) => item.id === presetId)
    ? presetId as WorkbenchPresetId
    : "daily";
  return serialize(workbenchPresetData(preset, context));
}

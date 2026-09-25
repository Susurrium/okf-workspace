import type { CustomSectionDefinition } from "../../../apex/src/section-registry.js";
import type { DashboardSection } from "../../plugin/dashboard-view.js";

export const OKF_SECTION_TYPES: Readonly<Record<DashboardSection, string>> = {
  today: "workspace-today",
  inbox: "workspace-inbox",
  reading: "workspace-reading",
  learning: "workspace-learning",
  projects: "workspace-projects",
  knowledge: "workspace-knowledge",
  life: "workspace-life",
  system: "workspace-system",
};

/**
 * Release-gate inventory. These are user-visible outcomes that every mounted
 * surface must retain; tests bind this inventory to the registered Apex types.
 */
export const OKF_SURFACE_CAPABILITIES: Readonly<Record<DashboardSection, readonly string[]>> = {
  today: ["继续工作", "待处理提醒", "今日任务", "每日更新", "导入资料"],
  inbox: ["Capture 路由", "Web Clip 判断", "批量不保留", "转换进度", "失败恢复"],
  reading: ["同步最新内容", "来源搜索", "完整条目分页", "阅读位置", "订阅设置"],
  learning: ["学习范围", "Course 上下文", "Project 上下文", "生成与重试", "Claudian", "完成与撤销", "沉淀 Wiki"],
  projects: ["状态视图", "记录进展", "项目想法", "项目资料", "Claudian", "项目日志"],
  knowledge: ["目录", "搜索", "筛选", "AI 核验", "生成状态", "失败恢复"],
  life: ["Daily", "Reflection", "Review", "日历", "记录整理"],
  system: ["诊断", "后台任务", "转换恢复", "语义操作恢复", "索引与同步", "设置"],
};

const SECTION_METADATA: Readonly<Record<DashboardSection, {
  icon: string;
  label: string;
  defaultName: string;
}>> = {
  today: { icon: "calendar-check-2", label: "今天（OKF）", defaultName: "今天" },
  inbox: { icon: "inbox", label: "待处理（OKF）", defaultName: "待处理" },
  reading: { icon: "rss", label: "阅读与订阅（OKF）", defaultName: "阅读与订阅" },
  learning: { icon: "graduation-cap", label: "学习（OKF）", defaultName: "学习" },
  projects: { icon: "folder-kanban", label: "项目（OKF）", defaultName: "项目" },
  knowledge: { icon: "network", label: "知识（OKF）", defaultName: "知识" },
  life: { icon: "heart", label: "生活（OKF）", defaultName: "生活" },
  system: { icon: "settings-2", label: "系统（OKF）", defaultName: "系统" },
};

export function okfSectionDefaultName(section: DashboardSection): string {
  return SECTION_METADATA[section].defaultName;
}

export interface OkfSurfaceSectionHost {
  mountOkfDashboardSurface(container: HTMLElement, section: DashboardSection): Promise<() => void>;
}

export function createOkfSurfaceSectionDefinition(
  host: OkfSurfaceSectionHost,
  section: DashboardSection,
): CustomSectionDefinition {
  const metadata = SECTION_METADATA[section];
  return {
    type: OKF_SECTION_TYPES[section],
    ...metadata,
    async render({ container }): Promise<() => void> {
      container.addClass("okf-workbench-surface");
      return host.mountOkfDashboardSurface(container, section);
    },
  };
}

export function createOkfSurfaceSectionDefinitions(
  host: OkfSurfaceSectionHost,
): CustomSectionDefinition[] {
  return (Object.keys(OKF_SECTION_TYPES) as DashboardSection[])
    .map((section) => createOkfSurfaceSectionDefinition(host, section));
}

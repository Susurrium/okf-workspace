import type { CustomSectionDefinition } from "../../../apex/src/section-registry.js";
import type { DashboardSection } from "../../plugin/dashboard-view.js";
import { SectionConfigModal } from "../../plugin/section-config-modal.js";
import type { SectionActions } from "../../../apex/src/section-actions.js";

export interface SurfaceMountContext {
  columnId: string;
  config: Record<string, unknown>;
  headerActions?: HTMLElement;
  sectionActions?: SectionActions;
}

export const OKF_SECTION_TYPES: Readonly<Record<DashboardSection, string>> = {
  today: "workspace-today",
  tasks: "workspace-tasks",
  inbox: "workspace-inbox",
  reading: "workspace-reading",
  sources: "workspace-sources",
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
  tasks: ["任务目录", "状态与循环", "依赖", "安排日期", "查询与保存视图", "来源定位"],
  inbox: ["随手记录路由", "Web Clip 判断", "批量不保留", "转换进度", "失败恢复"],
  reading: ["同步最新内容", "来源搜索", "完整条目分页", "阅读位置", "订阅设置"],
  sources: ["资料目录", "原件", "资料正文", "全部用途", "关联成果", "转换与导入记录"],
  learning: ["学习范围", "课程上下文", "项目上下文", "生成与重试", "Claudian", "完成与撤销", "整理为知识笔记"],
  projects: ["状态视图", "记录进展", "项目想法", "项目资料", "Claudian", "项目日志"],
  knowledge: ["目录", "搜索", "筛选", "AI 核验", "生成状态", "失败恢复"],
  life: ["Daily", "Reflection", "Review", "日历", "记录整理"],
  system: ["诊断", "后台任务", "转换恢复", "语义操作恢复", "索引与同步", "设置"],
};

const SECTION_METADATA: Readonly<Record<DashboardSection, {
  icon: string;
  label: string;
  defaultName: string;
  description: string;
}>> = {
  today: { icon: "calendar-check-2", label: "今天", defaultName: "今天", description: "今日任务、继续内容与需要判断的事项" },
  tasks: { icon: "list-checks", label: "任务", defaultName: "任务", description: "安排笔记中的任务，查看循环、依赖和完成历史" },
  inbox: { icon: "inbox", label: "收集箱", defaultName: "收集箱", description: "整理随手记录与尚未确定用途的资料" },
  reading: { icon: "rss", label: "订阅阅读", defaultName: "订阅阅读", description: "按来源阅读最新内容与历史，选择资料用途" },
  sources: { icon: "files", label: "资料", defaultName: "资料", description: "查找原件、正文、用途及关联成果" },
  learning: { icon: "graduation-cap", label: "学习", defaultName: "学习", description: "浏览课程与学习材料，准备内容并记录完成" },
  projects: { icon: "folder-kanban", label: "项目", defaultName: "项目", description: "记录进展、管理状态，查看关联任务与成果" },
  knowledge: { icon: "network", label: "知识笔记", defaultName: "知识笔记", description: "查找知识笔记与导航，核验及复核内容" },
  life: { icon: "heart", label: "日记与复盘", defaultName: "日记与复盘", description: "写日记、记录反思并进行定期复盘" },
  system: { icon: "settings-2", label: "后台与诊断", defaultName: "后台与诊断", description: "查看执行进度、恢复失败与配置服务" },
};

export function okfSectionDefaultName(section: DashboardSection): string {
  return SECTION_METADATA[section].defaultName;
}

export interface OkfSurfaceSectionHost {
  mountOkfDashboardSurface(container: HTMLElement, section: DashboardSection, context?: SurfaceMountContext): Promise<() => void>;
}

export function createOkfSurfaceSectionDefinition(
  host: OkfSurfaceSectionHost,
  section: DashboardSection,
): CustomSectionDefinition {
  const metadata = SECTION_METADATA[section];
  return {
    type: OKF_SECTION_TYPES[section],
    ...metadata,
    configure(context): void {
      new SectionConfigModal(context.app, context.column.extensionConfig ?? {}, context.setConfig, section).open();
    },
    async render({ container, column, headerActions, sectionActions }): Promise<() => void> {
      container.addClass("okf-workbench-surface");
      return column ? host.mountOkfDashboardSurface(container, section, {
        columnId: column.id ?? column.name, headerActions, sectionActions, config: section === "tasks"
          ? { taskView: "all", ...(column.libraryConfig ?? {}), ...(column.extensionConfig ?? {}) }
          : column.extensionConfig ?? {},
      }) : host.mountOkfDashboardSurface(container, section);
    },
  };
}

export function createOkfSurfaceSectionDefinitions(
  host: OkfSurfaceSectionHost,
): CustomSectionDefinition[] {
  const definitions = (Object.keys(OKF_SECTION_TYPES) as DashboardSection[])
    .map((section) => createOkfSurfaceSectionDefinition(host, section));
  const updates = createOkfSurfaceSectionDefinition(host, "reading");
  definitions.push({ ...updates, type: "workspace-updates", icon: "newspaper", label: "每日更新", defaultName: "每日更新",
    description: "指定来源的最新一期与阅读位置",
    configure: context => new SectionConfigModal(context.app,
      { readingView: "daily-updates", ...context.column.extensionConfig, scene: context.column.extensionConfig?.readingView === "subscriptions" ? undefined : "daily-updates" },
      context.setConfig, "reading").open(),
    render: context => updates.render({ ...context, column: { ...context.column,
      extensionConfig: { readingView: "daily-updates", ...context.column.extensionConfig, scene: context.column.extensionConfig?.readingView === "subscriptions" ? undefined : "daily-updates" } } }),
  });
  const tasks = createOkfSurfaceSectionDefinition(host, "tasks");
  definitions.push({ ...tasks, type: "alltasks", hidden: true });
  return definitions;
}

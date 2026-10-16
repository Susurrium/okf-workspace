import type { ConversionRecord, NoteSummary, SemanticOperationRecord } from "../api/types.js";
import { methodLabels } from "../imports/types.js";
import { hasPendingGeneration } from "./inbox-work-queue.js";
import { isSemanticOperationActive, isSemanticOperationRetryable } from "./semantic-operation-state.js";

export type ProjectLifecycleStatus = "active" | "paused" | "completed";
export interface ProjectStatusAction {
  status: ProjectLifecycleStatus;
  label: string;
}
type LearningWorkItemStatus = "pending" | "generating" | "failed" | "refreshing" | "ready" | "completed";

export function projectLifecycleStatus(project: Pick<NoteSummary, "project_status">): ProjectLifecycleStatus {
  if (project.project_status === "paused" || project.project_status === "completed") {
    return project.project_status;
  }
  return "active";
}

export function projectStatusLabel(status: ProjectLifecycleStatus): string {
  if (status === "paused") return "已暂停";
  if (status === "completed") return "已完成";
  return "进行中";
}

function projectStatusActionLabel(
  current: ProjectLifecycleStatus,
  target: ProjectLifecycleStatus,
): string {
  if (target === "active") return current === "completed" ? "重新开启" : "恢复推进";
  if (target === "paused") return "暂停项目";
  return "标记完成";
}

export function projectStatusActions(status: ProjectLifecycleStatus): ProjectStatusAction[] {
  return (["active", "paused", "completed"] as const)
    .filter((target) => target !== status)
    .map((target) => ({ status: target, label: projectStatusActionLabel(status, target) }));
}

export function learningWorkItemStatus(
  note: NoteSummary,
  operation?: SemanticOperationRecord,
): LearningWorkItemStatus {
  if (operation && isSemanticOperationActive(operation.status)) return "generating";
  if (operation && isSemanticOperationRetryable(operation.status)) return "failed";
  if (operation?.status === "completed" && !note.material_ready) return "refreshing";
  if (note.studied_at) return "completed";
  if (note.material_ready) return "ready";
  return "pending";
}

export function learningWorkItemStatusLabel(
  note: NoteSummary,
  operation?: SemanticOperationRecord,
): string {
  const status = learningWorkItemStatus(note, operation);
  if (status === "generating") return "生成中";
  if (status === "failed") return "生成失败";
  if (status === "refreshing") return "正在刷新";
  if (status === "ready") return "可学习";
  if (status === "completed") return "已完成";
  return "待生成";
}

export function courseStatusLabel(status: string | null | undefined): string {
  if (status === "paused") return "已暂停";
  if (status === "completed") return "已完成";
  return "进行中";
}

export function systemStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    configured: "已配置",
    "not-configured": "未配置",
    available: "可用",
    current: "最新",
    ok: "正常",
    healthy: "正常",
    deferred: "稍后配置",
    warning: "需要注意",
    failed: "失败",
    unavailable: "不可用",
  };
  return labels[status.toLocaleLowerCase()] ?? status;
}

export function systemStatusClass(status: string): string {
  const normalized = status.toLocaleLowerCase();
  if (["configured", "available", "current", "ok", "healthy"].includes(normalized)) {
    return "is-ok";
  }
  if (["failed", "unavailable"].includes(normalized)) return "is-error";
  return "is-warning";
}

export function semanticStageLabel(operation: SemanticOperationRecord): string {
  if (operation.status === "queued") return "已排队，等待生成";
  if (operation.status === "orphaned") return "后台生成中断，等待恢复";
  const labels: Record<string, string> = {
    retrieving: "正在检索相关笔记",
    generating: "正在生成内容",
    publishing: "正在写入目标笔记",
    indexing: "正在刷新检索索引",
  };
  return labels[operation.stage ?? ""] ?? "后台任务正在处理";
}

export function conversionMethodLabel(conversion: ConversionRecord): string {
  return conversion.method ? methodLabels[conversion.method] : conversion.parser;
}

export function conversionStatusLabel(conversion: ConversionRecord): string {
  if (hasPendingGeneration(conversion)) return conversion.error
    ? "转换已完成，生成入队失败；后台会重试，也可手动重试"
    : "转换已完成，等待生成入队";
  if (conversion.status === "queued") return "已排队";
  if (conversion.status === "converting") return `正在使用 ${conversionMethodLabel(conversion)} 转换`;
  if (conversion.status === "waiting-for-mineru") return "等待 MinerU；后台会自动重试";
  if (conversion.status === "waiting-for-parser") return "等待转换服务；后台会自动重试，也可更换方式";
  if (conversion.status === "ready") return "转换已完成，等待保存";
  if (conversion.stages?.quality === "failed") return "质量检查未通过，可更换方式重新转换";
  if (conversion.stages?.conversion === "completed" && conversion.stages.quality === "passed") return "转换已完成，保存需要处理";
  return "转换失败，需要处理";
}

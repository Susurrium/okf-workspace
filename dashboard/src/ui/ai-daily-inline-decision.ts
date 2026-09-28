import type {
  FeedDecisionAction,
  FeedDecisionResult,
} from "../feeds/types.js";

export const FEED_DECISION_ACTIONS: readonly {
  action: FeedDecisionAction;
  label: string;
  result: string;
}[] = [
  { action: "learn-now", label: "现在生成辅助学习材料", result: "保存资料并安排生成辅助学习材料" },
  { action: "learn-later", label: "稍后学习", result: "保存资料，之后从学习页继续" },
  { action: "wiki-now", label: "整理为知识笔记", result: "保存资料并安排生成知识笔记" },
  { action: "source-only", label: "只保存资料", result: "保存已获取的正文或摘要" },
  { action: "ignore", label: "不保留", result: "记录选择，不另存为资料笔记" },
];

export interface FeedDecisionFeedback {
  message: string;
  target?: string | undefined;
  targetLabel?: string | undefined;
}

function generationFeedback(result: FeedDecisionResult, subject: string): string {
  const status = result.semantic_operation?.status;
  if (status === "completed") return `${subject}已生成。`;
  const state = status ? {
    queued: "生成任务已排队，切换页面不会中断。",
    running: `正在生成${subject}，切换页面不会中断。`,
    failed: "生成失败，可在系统状态中重试。",
    cancelled: "生成已取消，已保存的资料仍然保留。",
    orphaned: "生成已中断，可在系统状态中重新生成。",
  }[status] : "生成任务尚未确认，请在系统状态中查看后再重试。";
  return `资料已保存；${state}`;
}

export function feedDecisionFeedback(result: FeedDecisionResult): FeedDecisionFeedback {
  switch (result.action) {
    case "learn-now":
      return {
        message: generationFeedback(result, "辅助学习材料"),
        target: result.study_guide,
        targetLabel: "打开学习笔记",
      };
    case "learn-later":
      return {
        message: "资料已保存到待学习列表；可在学习页生成辅助学习材料。",
        target: result.study_guide ?? result.source_text ?? result.source,
        targetLabel: result.study_guide ? "打开学习笔记" : "打开已保存资料",
      };
    case "wiki-now":
      return {
        message: generationFeedback(result, "知识笔记"),
        target: result.wiki,
        targetLabel: "打开知识笔记",
      };
    case "source-only":
      return {
        message: "资料已保存，内容为已获取的正文或摘要。",
        target: result.source_text ?? result.source,
        targetLabel: "打开已保存资料",
      };
    case "ignore":
      return { message: "已记录为不保留，没有另存为资料笔记。" };
    case "later":
      return {
        message: result.source
          ? "此前选择了稍后处理，已保存的资料仍可打开。你可以重新选择用途。"
          : "此前选择了稍后处理，尚无可打开的资料。你可以重新选择用途。",
        target: result.source,
        targetLabel: result.source ? "打开旧资料" : undefined,
      };
  }
}

import type {
  FeedDecisionAction,
  FeedDecisionResult,
  FeedItem,
} from "../feeds/types.js";
import type { AiDailyDecisionController } from "../services/ai-daily-decision-controller.js";

export const FEED_DECISION_ACTIONS: readonly {
  action: FeedDecisionAction;
  label: string;
  result: string;
}[] = [
  { action: "learn-now", label: "现在生成 Study Guide", result: "保存来源并创建待生成的 Study Guide" },
  { action: "learn-later", label: "稍后学习", result: "保存来源并创建待生成的学习入口" },
  { action: "wiki-now", label: "直接整理成 Wiki", result: "保存来源并生成未学习 Wiki" },
  { action: "source-only", label: "只保留原始资料", result: "仅保存来源和可读摘录" },
  { action: "ignore", label: "不保留", result: "记录决定但不写入 Vault" },
  { action: "later", label: "暂不处理（旧记录）", result: "只记录决定，不创建 Source 或学习入口" },
];

export interface InlineDecisionView {
  itemId: string;
  pending: boolean;
  selected?: FeedDecisionAction | undefined;
}

export interface FeedDecisionFeedback {
  message: string;
  target?: string | undefined;
  targetLabel?: string | undefined;
}

export function feedDecisionFeedback(result: FeedDecisionResult): FeedDecisionFeedback {
  switch (result.action) {
    case "learn-now":
      return {
        message: result.semantic_operation?.status === "completed"
          ? "学习材料已经生成完成。"
          : "已保存来源并创建学习入口；Codex 正在后台生成学习材料。",
        target: result.study_guide,
        targetLabel: "打开学习材料",
      };
    case "learn-later":
      return {
        message: "已保存来源并创建待生成的学习入口；可在 Learning 页面继续。",
        target: result.study_guide,
        targetLabel: "打开学习入口",
      };
    case "wiki-now":
      return {
        message: result.semantic_operation?.status === "completed"
          ? "Wiki 已经生成完成。"
          : "已保存来源；Codex 正在后台整理 Wiki。",
        target: result.wiki,
        targetLabel: "打开 Wiki",
      };
    case "source-only":
      return {
        message: "已保存 Source 和完整 Source Text，不会创建 Study Guide 或 Wiki。",
        target: result.source_text ?? result.source,
        targetLabel: "打开完整来源",
      };
    case "ignore":
      return { message: "已记录为不保留；没有向 Vault 写入内容。" };
    case "later":
      return { message: "已记录为稍后决定；没有创建 Source 或学习入口，以后仍可回来重新判断。" };
  }
}

export class AiDailyInlineDecision {
  public constructor(
    private readonly item: FeedItem,
    private readonly controller: AiDailyDecisionController,
  ) {}

  public view(): InlineDecisionView {
    const state = this.controller.state(this.item.item_id);
    return {
      itemId: this.item.item_id,
      pending: state.pending,
      selected: state.result?.action,
    };
  }

  public choose(action: FeedDecisionAction): Promise<unknown> {
    return this.controller.decide(this.item, action);
  }
}

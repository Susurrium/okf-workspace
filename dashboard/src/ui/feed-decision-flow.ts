import type { FeedDecisionAction, FeedDecisionResult } from "../feeds/types.js";
import { isSemanticOperationActive } from "../domain/semantic-operation-state.js";
import { FEED_DECISION_ACTIONS, feedDecisionFeedback } from "./ai-daily-inline-decision.js";

export interface FeedDecisionFlowActions {
  load(): Promise<FeedDecisionResult | undefined>;
  decide(action: FeedDecisionAction): Promise<FeedDecisionResult>;
  openPath(path: string): Promise<void>;
  notify(message: string): void;
}

/** Shared decision presentation for Reading and CodeMirror Live Preview. */
export function renderFeedDecisionFlow(controls: HTMLElement, status: HTMLElement, actions: FeedDecisionFlowActions): void {
  let busy = false;
  const message = (error: unknown): string => error instanceof Error ? error.message : "Feed 操作失败";
  const button = (label: string, handler: () => void): void => {
    controls.createEl("button", { text: label, attr: { type: "button" } }).addEventListener("click", handler);
  };
  const choose = async (action: FeedDecisionAction): Promise<void> => {
    if (busy) return;
    busy = true;
    controls.replaceChildren();
    status.setText(`正在执行：${FEED_DECISION_ACTIONS.find((item) => item.action === action)?.label ?? action}…`);
    try {
      const result = await actions.decide(action);
      if (controls.isConnected) renderResult(result);
      actions.notify(feedDecisionFeedback(result).message);
    } catch (error) {
      if (controls.isConnected) {
        renderPrimary();
        status.setText(`处理失败：${message(error)}`);
      }
      actions.notify(message(error));
    } finally { busy = false; }
  };
  const renderResult = (result: FeedDecisionResult): void => {
    const feedback = feedDecisionFeedback(result);
    const operation = result.semantic_operation;
    const operationText = operation ? ({
      queued: "任务已排队，等待 Codex 开始生成。",
      running: "Codex 正在后台生成；切换页面不会中断。",
      orphaned: "后台生成已中断，可在 Learning 或 System 中重新生成。",
      completed: "后台生成已完成。",
      failed: "后台生成失败，可在 Learning 或 System 中重试。",
      cancelled: "后台任务已取消。",
    })[operation.status] : "";
    status.setText([feedback.message, operationText, result.warnings?.join("；")].filter(Boolean).join(" "));
    controls.replaceChildren();
    if (feedback.target && feedback.targetLabel) button(feedback.targetLabel, () => {
      void actions.openPath(feedback.target!).catch((error: unknown) => actions.notify(message(error)));
    });
    if (result.action === "learn-later") button("现在生成学习材料", () => void choose("learn-now"));
    if (!operation || !isSemanticOperationActive(operation.status)) button("更改判断", renderPrimary);
  };
  const renderLearning = (): void => {
    controls.replaceChildren();
    status.setText("你想学习：现在生成 Study Guide，还是先放进 Learning？");
    button("现在生成 Study Guide", () => void choose("learn-now"));
    button("稍后学习", () => void choose("learn-later"));
    button("返回", renderPrimary);
  };
  const renderNoLearning = (): void => {
    controls.replaceChildren();
    status.setText("你不打算学习：它仍有长期参考价值吗？");
    button("直接整理成 Wiki", () => void choose("wiki-now"));
    button("只保留原始资料", () => void choose("source-only"));
    button("不保留", () => void choose("ignore"));
    button("返回", renderPrimary);
  };
  function renderPrimary(): void {
    controls.replaceChildren();
    status.setText("先判断你是否想学习这条内容；暂时不处理时直接离开即可。");
    button("想学习", renderLearning);
    button("不打算学习", renderNoLearning);
  }
  const load = async (): Promise<void> => {
    controls.replaceChildren();
    status.setText("正在读取你之前的判断…");
    try {
      const result = await actions.load();
      if (!controls.isConnected) return;
      if (result) renderResult(result);
      else renderPrimary();
    } catch (error) {
      if (!controls.isConnected) return;
      status.setText(`之前的判断暂时无法读取：${message(error)}`);
      button("重新读取", () => void load());
    }
  };
  void load();
}

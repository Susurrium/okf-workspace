import type { FeedDecisionAction, FeedDecisionResult } from "../feeds/types.js";
import { isSemanticOperationActive } from "../domain/semantic-operation-state.js";
import { FEED_DECISION_ACTIONS, feedDecisionFeedback } from "./ai-daily-inline-decision.js";
import { renderMaterialDecision } from "./material-decision.js";

export interface FeedDecisionFlowActions {
  load(): Promise<FeedDecisionResult | undefined>;
  decide(action: FeedDecisionAction): Promise<FeedDecisionResult>;
  openPath(path: string): Promise<void>;
  notify(message: string): void;
}

/** Shared decision presentation for Reading and CodeMirror Live Preview. */
export function renderFeedDecisionFlow(controls: HTMLElement, status: HTMLElement, actions: FeedDecisionFlowActions): void {
  let busy = false;
  const message = (error: unknown): string => error instanceof Error ? error.message : "订阅操作失败";
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
    status.setText([feedback.message, result.warnings?.join("；")].filter(Boolean).join(" "));
    controls.replaceChildren();
    if (feedback.target && feedback.targetLabel) button(feedback.targetLabel, () => {
      void actions.openPath(feedback.target!).catch((error: unknown) => actions.notify(message(error)));
    });
    if (result.action === "learn-later") button("现在生成学习材料", () => void choose("learn-now"));
    if (!operation || !isSemanticOperationActive(operation.status)) button("更改判断", renderPrimary);
  };
  function renderPrimary(): void {
    renderMaterialDecision(controls, status, { choose: action => void choose(action) });
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

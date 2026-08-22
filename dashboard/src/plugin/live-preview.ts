import { StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { Notice, type App } from "obsidian";

import type {
  FeedDecisionAction,
  FeedDecisionResult,
  FeedKind,
} from "../feeds/types.js";
import {
  FEED_DECISION_ACTIONS,
  feedDecisionFeedback,
} from "../ui/ai-daily-inline-decision.js";
import { feedItemMappings, type FeedItemMapping } from "../feeds/mappings.js";

export interface LiveDecisionAdapter {
  decide(feed: FeedKind, itemId: string, action: FeedDecisionAction): Promise<FeedDecisionResult>;
  openPath(path: string): Promise<void>;
}

class DecisionWidget extends WidgetType {
  public constructor(
    private readonly app: App,
    private readonly blockId: string,
    private readonly adapter: LiveDecisionAdapter,
  ) {
    super();
  }

  public toDOM(): HTMLElement {
    const container = document.createElement("span");
    container.className = "okf-live-decision-widget";
    const summary = container.createSpan({
      cls: "okf-feed-recommendation",
      text: "这条内容是否值得进入你的知识系统，由你决定。",
    });
    const controls = container.createSpan({ cls: "okf-feed-decisions" });
    const mapping = this.currentMapping();

    const action = (name: FeedDecisionAction): void => {
      const definition = FEED_DECISION_ACTIONS.find((candidate) => candidate.action === name);
      if (!mapping || !definition) return;
      for (const button of controls.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
      summary.setText(`正在执行：${definition.label}…`);
      void this.adapter
        .decide(mapping.feed, mapping.id, name)
        .then((result) => {
          const warning = result.warnings?.join("；");
          const feedback = feedDecisionFeedback(result);
          summary.setText(warning ? `${feedback.message}；${warning}` : feedback.message);
          controls.replaceChildren();
          if (feedback.target && feedback.targetLabel) {
            button(feedback.targetLabel, () => void this.adapter.openPath(feedback.target!));
          }
          new Notice(warning ? `${feedback.message}；${warning}` : feedback.message, 10_000);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Feed 操作失败";
          summary.setText(`处理失败：${message}`);
          renderPrimary();
          new Notice(message, 10_000);
        });
    };
    const button = (label: string, handler: () => void): void => {
      const element = controls.createEl("button", { text: label, attr: { type: "button" } });
      element.addEventListener("click", handler);
    };
    const renderLearning = (): void => {
      controls.replaceChildren();
      summary.setText("你想学习：现在生成 Study Guide，还是先放进 Learning？");
      button("现在生成 Study Guide", () => action("learn-now"));
      button("稍后学习", () => action("learn-later"));
      button("返回", renderPrimary);
    };
    const renderNoLearning = (): void => {
      controls.replaceChildren();
      summary.setText("你不打算学习：它仍有长期参考价值吗？");
      button("直接整理成 Wiki", () => action("wiki-now"));
      button("只保留原始资料", () => action("source-only"));
      button("不保留", () => action("ignore"));
      button("返回", renderPrimary);
    };
    function renderPrimary(): void {
      controls.replaceChildren();
      summary.setText("先判断你是否想学习这条内容；暂时不处理时直接离开即可。");
      button("想学习", renderLearning);
      button("不打算学习", renderNoLearning);
    }

    if (!mapping) {
      summary.setText("未找到这条内容的 Feed 映射");
      return container;
    }
    renderPrimary();
    return container;
  }

  private currentMapping(): (FeedItemMapping & { feed: FeedKind }) | undefined {
    const file = this.app.workspace.getActiveFile();
    if (!file) return undefined;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const feed = frontmatter?.feed;
    const mappings = feedItemMappings(frontmatter);
    if ((feed !== "ai-daily" && feed !== "treehole") || !mappings.length) return undefined;
    const mapping = mappings.find((candidate) => candidate.block_id === this.blockId);
    return mapping ? { ...mapping, feed } : undefined;
  }
}

function decorations(app: App, adapter: LiveDecisionAdapter, view: EditorView["state"]): DecorationSet {
  const widgets: { from: number; decoration: Decoration }[] = [];
  for (let lineNumber = 1; lineNumber <= view.doc.lines; lineNumber += 1) {
    const line = view.doc.line(lineNumber);
    const match = /^\s*\^(feed-[a-f0-9]{12}|treehole-\d+)\s*$/u.exec(line.text);
    const blockId = match?.[1];
    if (!blockId) continue;
    widgets.push({
      from: line.to,
      decoration: Decoration.widget({ widget: new DecisionWidget(app, blockId, adapter), side: 1 }),
    });
  }
  return Decoration.set(widgets.map((value) => value.decoration.range(value.from)), true);
}

export function feedLivePreviewExtension(app: App, adapter: LiveDecisionAdapter): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: (state) => decorations(app, adapter, state),
    update: (current, transaction) =>
      transaction.docChanged ? decorations(app, adapter, transaction.state) : current,
    provide: (field) => EditorView.decorations.from(field),
  });
}

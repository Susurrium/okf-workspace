import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, Notice, type App, type TFile } from "obsidian";

import type { FeedDecisionAction, FeedDecisionResult, FeedKind } from "../feeds/types.js";
import { feedItemMappings, type FeedItemMapping } from "../feeds/mappings.js";
import { renderFeedDecisionFlow } from "../ui/feed-decision-flow.js";

export interface LiveDecisionAdapter {
  load(feed: FeedKind, itemId: string): Promise<FeedDecisionResult | undefined>;
  decide(feed: FeedKind, itemId: string, action: FeedDecisionAction): Promise<FeedDecisionResult>;
  openPath(path: string): Promise<void>;
}

export function editorFeedMapping(
  app: App,
  file: TFile,
  blockId: string,
): (FeedItemMapping & { feed: FeedKind }) | undefined {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  const feed = frontmatter?.feed;
  if (feed !== "ai-daily" && feed !== "treehole") return undefined;
  const mapping = feedItemMappings(frontmatter).find((candidate) => candidate.block_id === blockId);
  return mapping ? { ...mapping, feed } : undefined;
}

class DecisionWidget extends WidgetType {
  public constructor(
    private readonly app: App,
    private readonly file: TFile,
    private readonly blockId: string,
    private readonly adapter: LiveDecisionAdapter,
  ) {
    super();
  }

  public eq(other: DecisionWidget): boolean {
    return this.file.path === other.file.path && this.blockId === other.blockId;
  }

  public toDOM(view: EditorView): HTMLElement {
    const container = view.dom.ownerDocument.createElement("span");
    container.className = "okf-live-decision-widget";
    const summary = container.createSpan({ cls: "okf-feed-recommendation" });
    const controls = container.createSpan({ cls: "okf-feed-decisions" });
    const mapping = editorFeedMapping(this.app, this.file, this.blockId);
    if (!mapping) {
      summary.setText("未找到这条内容的 Feed 映射");
      return container;
    }
    renderFeedDecisionFlow(controls, summary, {
      load: () => this.adapter.load(mapping.feed, mapping.id),
      decide: (action) => this.adapter.decide(mapping.feed, mapping.id, action),
      openPath: (path) => this.adapter.openPath(path),
      notify: (message) => { new Notice(message, 10_000); },
    });
    return container;
  }
}

function decorations(app: App, adapter: LiveDecisionAdapter, state: EditorState): DecorationSet {
  const file = state.field(editorInfoField, false)?.file;
  if (!file || !state.field(editorLivePreviewField, false)) return Decoration.none;
  const widgets: { from: number; decoration: Decoration }[] = [];
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const blockId = /^\s*\^(feed-[a-f0-9]{12}|treehole-\d+)\s*$/u.exec(line.text)?.[1];
    if (!blockId) continue;
    widgets.push({
      from: line.to,
      decoration: Decoration.widget({ widget: new DecisionWidget(app, file, blockId, adapter), side: 1 }),
    });
  }
  return Decoration.set(widgets.map((value) => value.decoration.range(value.from)), true);
}

export function feedLivePreviewExtension(app: App, adapter: LiveDecisionAdapter): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: (state) => decorations(app, adapter, state),
    update: (current, transaction) =>
      transaction.docChanged ||
      transaction.startState.field(editorInfoField, false)?.file !== transaction.state.field(editorInfoField, false)?.file ||
      transaction.startState.field(editorLivePreviewField, false) !== transaction.state.field(editorLivePreviewField, false)
        ? decorations(app, adapter, transaction.state)
        : current,
    provide: (field) => EditorView.decorations.from(field),
  });
}

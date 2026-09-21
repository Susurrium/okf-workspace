import { Notice } from "obsidian";

import type { CustomSectionDefinition } from "../../../apex/src/section-registry.js";
import {
  feedSubscriptionCardLabel,
  feedSubscriptionCardState,
  feedSubscriptionFailureLabel,
  feedSubscriptionHasLatest,
} from "../../domain/feed-subscriptions.js";
import type {
  FeedDashboardDigest,
  FeedDecisionResult,
  FeedDigestEdition,
  FeedDigestItem,
  FeedKind,
  FeedSubscriptionPage,
  FeedSubscriptionSource,
  FeedSubscriptionSourcePage,
  FeedSyncResult,
} from "../../feeds/types.js";
import type { FeedReadingPosition } from "../../plugin/settings.js";
import {
  feedDecisionLabel,
  formatFeedDate,
  mergeUniqueEditions,
  mergeUniqueSources,
  readingStreams,
} from "./reading-projection.js";

export const OKF_READING_SECTION_TYPE = "workspace-reading";
const SOURCE_PAGE_SIZE = 8;
const EDITION_PAGE_SIZE = 4;

export interface ReadingSectionHost {
  feedDashboardDigestSnapshot(): FeedDashboardDigest | undefined;
  loadFeedDashboardDigest(): Promise<FeedDashboardDigest>;
  loadFeedSubscriptionSources(query?: {
    limit?: number;
    cursor?: string;
    query?: string;
  }): Promise<FeedSubscriptionSourcePage>;
  loadFeedSubscriptions(query?: {
    limit?: number;
    cursor?: string;
    source_id?: string;
  }): Promise<FeedSubscriptionPage>;
  syncFeedsNow(): Promise<FeedSyncResult[]>;
  promptAddFeedSubscription(): void;
  promptFeedSubscriptionSettings(source: FeedSubscriptionSource): void;
  openFeedDigest(feed: FeedKind, digestId: string): Promise<void>;
  openFeedItem(feed: FeedKind, digestId: string, blockId: string): Promise<void>;
  feedReadingPosition(feed: FeedKind): FeedReadingPosition | undefined;
  rememberFeedReadingPosition(feed: FeedKind, editionId: string, itemId: string): Promise<void>;
  feedDecisionSnapshot(feed: FeedKind, itemId: string): FeedDecisionResult | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Engine 暂时不可用";
}

function button(
  parent: HTMLElement,
  label: string,
  run: (element: HTMLButtonElement) => void,
  primary = false,
): HTMLButtonElement {
  const element = parent.createEl("button", {
    text: label,
    cls: primary ? "mod-cta" : undefined,
    attr: { type: "button" },
  });
  element.addEventListener("click", () => run(element));
  return element;
}

function runButton(element: HTMLButtonElement, action: () => Promise<unknown>): void {
  if (element.disabled) return;
  element.disabled = true;
  void action()
    .catch((error: unknown) => new Notice(errorMessage(error), 10_000))
    .finally(() => { element.disabled = false; });
}

function editionMeta(edition: FeedDigestEdition): string {
  return `${formatFeedDate(edition.issued_at)} · ${edition.item_count} 条`;
}

function itemMetadata(item: FeedDigestItem): string {
  return [
    item.source_name || item.source,
    item.native_section,
    item.published_at,
    item.comment_count ? `${item.comment_count} 条评论` : "",
    item.media_count ? `${item.media_count} 个媒体` : "",
  ].filter(Boolean).join(" · ");
}

function renderItem(
  parent: HTMLElement,
  host: ReadingSectionHost,
  feed: FeedKind,
  edition: FeedDigestEdition,
  item: FeedDigestItem,
  index: number,
): void {
  const row = parent.createEl("article", {
    cls: "okf-feed-digest__item is-compact",
    attr: { role: "button", tabindex: "0", "data-feed-kind": feed },
  });
  const position = host.feedReadingPosition(feed);
  if (position?.editionId === edition.digest_id && position.itemId === item.item_id) {
    row.addClass("is-last-read");
    row.setAttr("aria-current", "true");
  }
  row.createEl("h5", {
    text: feed === "treehole" && item.pid ? `#${item.pid} · ${item.title}` : `${index}. ${item.title}`,
  });
  if (item.summary) row.createDiv({ cls: "okf-feed-digest__summary", text: item.summary });
  const meta = itemMetadata(item);
  if (meta) row.createDiv({ cls: "okf-dashboard__muted", text: meta });
  const decision = feedDecisionLabel(host.feedDecisionSnapshot(feed, item.item_id)?.action ?? item.decision);
  if (decision) row.createSpan({ cls: "okf-feed-digest__decision", text: decision });
  row.createSpan({ cls: "okf-feed-digest__open-label", text: "阅读与判断 →" });
  let opening = false;
  const open = (): void => {
    if (opening) return;
    opening = true;
    row.addClass("is-loading");
    void host.openFeedItem(feed, edition.digest_id, item.block_id)
      .then(async () => {
        const scope = row.closest(".okf-reading-native");
        for (const previous of scope?.querySelectorAll<HTMLElement>(
          `.okf-feed-digest__item[data-feed-kind="${feed}"].is-last-read`,
        ) ?? []) {
          previous.removeClass("is-last-read");
          previous.removeAttribute("aria-current");
        }
        row.addClass("is-last-read");
        row.setAttr("aria-current", "true");
        await host.rememberFeedReadingPosition(feed, edition.digest_id, item.item_id);
      })
      .catch((error: unknown) => new Notice(errorMessage(error), 10_000))
      .finally(() => {
        opening = false;
        row.removeClass("is-loading");
      });
  };
  row.addEventListener("click", open);
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  });
}

function renderEdition(
  parent: HTMLElement,
  host: ReadingSectionHost,
  feed: FeedKind,
  edition: FeedDigestEdition,
  heading = true,
): void {
  const section = parent.createEl("section", { cls: "okf-feed-digest__edition is-compact" });
  if (heading) section.createEl("h4", { text: editionMeta(edition) });
  if (edition.quality && edition.quality !== "ok") {
    section.createDiv({
      cls: "okf-dashboard__feed-warning",
      text: `本期采集可能不完整${edition.quality_reason ? `：${edition.quality_reason}` : ""}`,
    });
  }
  const items = section.createDiv({ cls: "okf-feed-digest__items" });
  edition.items.forEach((item, index) => renderItem(items, host, feed, edition, item, index + 1));
}

function renderDigestOverview(
  parent: HTMLElement,
  host: ReadingSectionHost,
  digest: FeedDashboardDigest,
): void {
  const shelf = parent.createDiv({ cls: "okf-feed-shelf okf-feed-shelf--daily" });
  for (const stream of readingStreams(digest)) {
    const card = shelf.createEl("article", {
      cls: `okf-feed-card okf-feed-card--scrollable okf-feed-project okf-feed-project--${stream.id}`,
    });
    const header = card.createEl("header", { cls: "okf-feed-card__header okf-feed-project__header" });
    header.createEl("h3", { text: stream.title });
    header.createDiv({
      cls: "okf-dashboard__muted okf-feed-card__meta",
      text: stream.edition ? editionMeta(stream.edition) : "当前没有可读内容",
    });
    const health = stream.id === "papers"
      ? digest.stream_health?.papers
      : stream.id === "treehole" ? undefined : digest.stream_health?.[stream.id];
    if (health && health.status !== "ok" && health.status !== "unknown") {
      card.createDiv({
        cls: "okf-dashboard__error",
        text: `更新异常，当前内容可能不是最新：${health.message ?? "上游更新尚未成功"}`,
      });
    }
    const body = card.createDiv({ cls: "okf-feed-card__body okf-feed-project__scroll" });
    if (stream.edition) renderEdition(body, host, stream.feed, stream.edition, false);
    else body.createDiv({ cls: "okf-dashboard__empty", text: `暂时没有${stream.title}内容。` });
    const footer = card.createEl("footer", { cls: "okf-feed-card__footer" });
    if (stream.edition) button(footer, "打开本期原生笔记", (element) => {
      runButton(element, () => host.openFeedDigest(stream.feed, stream.edition!.digest_id));
    });
  }
}

export function createReadingSectionDefinition(host: ReadingSectionHost): CustomSectionDefinition {
  return {
    type: OKF_READING_SECTION_TYPE,
    icon: "rss",
    label: "阅读与订阅（OKF）",
    defaultName: "阅读与订阅",
    render({ container }): void {
      container.addClass("okf-reading-native");
      const toolbar = container.createDiv({ cls: "okf-native-section__toolbar" });
      button(toolbar, "添加订阅", () => host.promptAddFeedSubscription(), true);
      const content = container.createDiv({ cls: "okf-reading-native__content" });
      let sourceQuery = "";
      let sources: FeedSubscriptionSource[] = [];
      let sourceCursor: string | null = null;
      let sourceHasMore = false;
      let sourceTotal = 0;
      let selectedSource: Pick<FeedSubscriptionSource, "source_id" | "source_name"> | undefined;
      let editions: FeedDigestEdition[] = [];
      let editionCursor: string | null = null;
      let editionHasMore = false;

      const renderError = (parent: HTMLElement, message: string, retry: () => void): void => {
        const error = parent.createDiv({ cls: "okf-dashboard__error", text: `Engine 不可用：${message}` });
        button(error, "重新读取", () => retry());
      };

      const loadSources = async (append = false): Promise<void> => {
        const page = await host.loadFeedSubscriptionSources({
          limit: SOURCE_PAGE_SIZE,
          ...(append && sourceCursor ? { cursor: sourceCursor } : {}),
          ...(sourceQuery ? { query: sourceQuery } : {}),
        });
        sources = append ? mergeUniqueSources(sources, page.sources) : page.sources;
        sourceCursor = page.next_cursor;
        sourceHasMore = page.has_more;
        sourceTotal = page.matched_sources;
      };

      const loadEditions = async (append = false): Promise<void> => {
        if (!selectedSource) return;
        const page = await host.loadFeedSubscriptions({
          limit: EDITION_PAGE_SIZE,
          source_id: selectedSource.source_id,
          ...(append && editionCursor ? { cursor: editionCursor } : {}),
        });
        editions = append ? mergeUniqueEditions(editions, page.editions) : page.editions;
        editionCursor = page.next_cursor;
        editionHasMore = page.has_more;
      };

      const showSourceDetail = (): void => {
        content.replaceChildren();
        if (!selectedSource) return;
        const header = content.createDiv({ cls: "okf-reading-source-detail__header" });
        button(header, "← 返回全部来源", () => {
          selectedSource = undefined;
          editions = [];
          showOverview();
        });
        header.createEl("h3", { text: selectedSource.source_name });
        const body = content.createDiv({ cls: "okf-reading-source-detail__editions" });
        if (!editions.length) body.createDiv({ cls: "okf-dashboard__muted", text: "正在读取来源历史…" });
        for (const edition of editions) renderEdition(body, host, "ai-daily", edition);
        const footer = content.createDiv({ cls: "okf-reading-source-detail__footer" });
        if (editionHasMore && editionCursor) button(footer, "加载更早内容", (element) => {
          runButton(element, async () => {
            await loadEditions(true);
            if (content.isConnected) showSourceDetail();
          });
        });
      };

      const openSource = (source: FeedSubscriptionSource): void => {
        selectedSource = { source_id: source.source_id, source_name: source.source_name };
        editions = [];
        editionCursor = null;
        editionHasMore = false;
        showSourceDetail();
        void loadEditions()
          .then(() => { if (content.isConnected && selectedSource?.source_id === source.source_id) showSourceDetail(); })
          .catch((error: unknown) => {
            if (!content.isConnected) return;
            const body = content.querySelector<HTMLElement>(".okf-reading-source-detail__editions");
            if (body) {
              body.replaceChildren();
              renderError(body, errorMessage(error), () => openSource(source));
            }
          });
      };

      const renderSource = (parent: HTMLElement, source: FeedSubscriptionSource): void => {
        const state = feedSubscriptionCardState(source);
        const card = parent.createEl("article", {
          cls: `okf-feed-card okf-feed-card--source okf-reading-source-card is-${state}`,
        });
        const header = card.createEl("header", { cls: "okf-feed-card__header" });
        header.createEl("h3", { text: source.source_name });
        header.createDiv({
          cls: "okf-dashboard__muted",
          text: feedSubscriptionHasLatest(source)
            ? `${formatFeedDate(source.latest_issued_at)} · 本期 ${source.latest_item_count} 条 · 待判断 ${source.pending_decision_count} · 历史 ${source.edition_count} 期`
            : `尚无最新一期 · 历史 ${source.edition_count} 期`,
        });
        card.createSpan({ cls: `okf-feed-subscription-status is-${state}`, text: feedSubscriptionCardLabel(state) });
        if (state === "error") card.createDiv({ cls: "okf-dashboard__error", text: feedSubscriptionFailureLabel(source.last_error_type) });
        const body = card.createDiv({ cls: "okf-feed-card__body okf-feed-project__scroll" });
        if (feedSubscriptionHasLatest(source)) {
          const edition: FeedDigestEdition = {
            digest_id: source.latest_digest_id,
            issued_at: source.latest_issued_at,
            title: source.source_name,
            section: "learning",
            item_count: source.latest_item_count,
            items: source.preview_items,
            quality: source.quality,
            quality_reason: source.quality_reason,
          };
          renderEdition(body, host, "ai-daily", edition, false);
        } else body.createDiv({ cls: "okf-dashboard__muted", text: "首次同步完成后会显示内容；已有历史不会因暂停或移除而删除。" });
        const footer = card.createEl("footer", { cls: "okf-feed-card__footer" });
        button(footer, "查看来源与历史", () => openSource(source));
        if (source.registry_managed || source.registry_status) {
          button(footer, "设置…", () => host.promptFeedSubscriptionSettings(source));
        }
      };

      const showOverview = (): void => {
        content.replaceChildren();
        const latest = content.createDiv({ cls: "okf-reading-native__latest" });
        const snapshot = host.feedDashboardDigestSnapshot();
        if (snapshot) renderDigestOverview(latest, host, snapshot);
        else latest.createDiv({ cls: "okf-dashboard__muted", text: "正在读取每日 Feed…" });

        const sourceSection = content.createEl("section", { cls: "okf-reading-native__sources" });
        const search = sourceSection.createDiv({ cls: "okf-reading-source-search" });
        const input = search.createEl("input", {
          attr: { type: "search", placeholder: "搜索订阅来源", "aria-label": "搜索订阅来源" },
        });
        input.value = sourceQuery;
        button(search, "搜索", (element) => {
          sourceQuery = input.value.trim();
          sources = [];
          sourceCursor = null;
          runButton(element, async () => { await loadSources(); showOverview(); });
        });
        search.createSpan({ cls: "okf-dashboard__muted", text: `共 ${sourceTotal} 个来源` });
        const grid = sourceSection.createDiv({ cls: "okf-reading-source-grid" });
        if (!sources.length) grid.createDiv({ cls: "okf-dashboard__empty", text: "还没有订阅来源，或当前搜索没有结果。" });
        for (const source of sources) renderSource(grid, source);
        const footer = sourceSection.createDiv({ cls: "okf-reading-source-footer" });
        if (sourceHasMore && sourceCursor) button(footer, "加载更多来源", (element) => {
          runButton(element, async () => { await loadSources(true); showOverview(); });
        });
      };

      button(toolbar, "同步最新内容", (element) => {
        runButton(element, async () => {
          const results = await host.syncFeedsNow();
          const failures = results.filter((result) => result.status === "error");
          if (failures.length) new Notice(`部分来源同步失败：${failures.map((item) => item.detail).join("；")}`, 10_000);
          await loadSources();
          if (content.isConnected) showOverview();
        });
      });

      const refreshOverview = (): void => {
        showOverview();
        void Promise.all([host.loadFeedDashboardDigest(), loadSources()])
          .then(() => { if (content.isConnected && !selectedSource) showOverview(); })
          .catch((error: unknown) => {
            if (!content.isConnected) return;
            content.replaceChildren();
            renderError(content, errorMessage(error), refreshOverview);
          });
      };
      refreshOverview();
    },
  };
}

import { noteTypeLabel, captureDestinationLabel } from "../ui/display-labels.js";
import { ItemView, Notice, TFile, WorkspaceLeaf, type App, type ViewStateResult } from "obsidian";
import { parse as parseYaml } from "yaml";
import {
  collectVaultTasks,
  invalidatePath,
  toggleTaskInFile,
  type VaultTask,
} from "../../apex/src/alltasks-scan.js";

import { LocalApi } from "../api/client.js";
import type {
  ConversionRecord,
  CourseSummary,
  NoteSummary,
  ProjectSummary,
  SemanticOperationRecord,
  SystemItem,
  SystemStatus,
} from "../api/types.js";
import {
  buildInboxWorkQueue,
  filterInboxItems,
  hasPendingGeneration,
  INGESTED_VIA_LABELS,
  INGESTED_VIA_ORDER,
  materialContextFromNote,
  type ConversionWorkItem,
  type DecisionWorkItem,
  type InboxWorkQueue,
  type IngestedViaFilter,
} from "../domain/inbox-work-queue.js";
import {
  canCompleteDashboardStudy,
  countTodayAttention,
  dashboardLearningContexts,
  dashboardLearningRowAction,
  dashboardLearningScopeMetric,
  dashboardLearningScopeCounts,
  dashboardCourseMetrics,
  dashboardProjectMetrics,
  filterDashboardLearningScope,
  selectDashboardContinueItems,
  type DashboardLearningContext,
  type DashboardObjectMetric,
} from "../domain/dashboard-experience.js";
import { aiDailyPreviewStreamTitle } from "../domain/ai-daily-preview.js";
import {
  feedSubscriptionAdapterLabel,
  feedSubscriptionCardLabel,
  feedSubscriptionCardState,
  feedSubscriptionFailureLabel,
  feedSubscriptionHasLatest,
  type FeedSubscriptionCardState,
} from "../domain/feed-subscriptions.js";
import {
  isSemanticOperationActive,
  isSemanticOperationRetryable,
} from "../domain/semantic-operation-state.js";
import type {
  FeedDashboardDigest,
  FeedDigestEdition,
  FeedDigestItem,
  FeedKind,
  FeedSubscriptionPage,
  FeedSubscriptionSource,
  FeedSubscriptionSourceItemsPage,
  FeedSubscriptionSourcePage,
  FeedSyncResult,
  AiDailyStream,
} from "../feeds/types.js";
import { FeedHttpError } from "../feeds/service.js";
import { bindDocumentDropTarget, type ImportFile } from "../imports/drop.js";
import type { DocumentImportOptions } from "../imports/types.js";
import type { ImportOrigin } from "./document-import-modal.js";
import { DASHBOARD_VERSION } from "../version.js";
import type OkfBrainPlugin from "./main.js";
import {
  DASHBOARD_FEEDS,
  type DashboardFeed,
} from "./dashboard-ui-state.js";
import type { CodexHandoffRequest } from "./claudian-bridge.js";
import { VaultDashboardReader, type InboxProjection } from "./vault-dashboard.js";
import {
  AnchoredActionPanel,
  type AnchoredActionPanelAction,
  type AnchoredActionPanelOptions,
} from "../ui/anchored-action-panel.js";

export const OKF_DASHBOARD_VIEW = "okf-workspace-dashboard";

class StandaloneOkfDashboardContainer extends ItemView {
  public getViewType(): string { return OKF_DASHBOARD_VIEW; }
  public getDisplayText(): string { return "工作台"; }
}

export type DashboardSection =
  | "today"
  | "inbox"
  | "reading"
  | "learning"
  | "projects"
  | "knowledge"
  | "life"
  | "system";
type Section = DashboardSection;

export interface EmbeddedDashboardSurfaceOptions {
  /** Mount the complete OKF surface inside an Apex custom section. */
  container?: HTMLElement;
  /** The page represented by the containing Apex section. */
  initialSection?: DashboardSection;
  /** Apex already owns the outer section navigation and chrome. */
  embedded?: boolean;
  /** A separate page for sections absent from the current Apex workbench. */
  focused?: boolean;
  /** Apex board to return to when a focused page was opened from a card. */
  workbenchPath?: string;
}
type TodayPane = "actions" | "reading";
type LearningContextFilter = "all" | DashboardLearningContext;
const SUBSCRIPTION_FIRST_PAGE_TTL_MS = 120_000;
const SUBSCRIPTION_SOURCE_PAGE_SIZE = 8;
const SUBSCRIPTION_EDITION_PAGE_SIZE = 4;
const READING_SOURCE_ITEMS_PAGE_SIZE = 40;
const READING_SOURCE_LOAD_THRESHOLD_PX = 160;
const READING_SOURCE_CACHE_LIMIT = 32;
const READING_SOURCE_REQUEST_CONCURRENCY = 4;

interface FeedCardSurface {
  card: HTMLElement;
  meta: HTMLElement;
  context: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
}

interface ReadingSourceItemsState {
  digestId: string;
  revision: string;
  itemCount: number;
  previewItems: FeedDigestItem[];
  items: FeedDigestItem[];
  nextCursor: string | null;
  hasMore: boolean;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  staleCursorRetried: boolean;
  request?: Promise<boolean>;
}

interface ReadingSourceItemsRequest {
  generation: number;
  sourceId: string;
  state: ReadingSourceItemsState;
  run: () => Promise<FeedSubscriptionSourceItemsPage>;
  resolve: (page: FeedSubscriptionSourceItemsPage) => void;
  reject: (error: unknown) => void;
}

class ReadingSourceItemsUnavailableError extends Error {
  public constructor() {
    super("当前服务不支持订阅来源条目分页");
    this.name = "ReadingSourceItemsUnavailableError";
  }
}

const NAVIGATION: readonly { id: Section; label: string }[] = [
  { id: "today", label: "今天" },
  { id: "inbox", label: "待处理" },
  { id: "reading", label: "订阅阅读" },
  { id: "learning", label: "学习" },
  { id: "projects", label: "项目" },
  { id: "knowledge", label: "知识库" },
  { id: "life", label: "生活" },
];

const PAGE_COPY: Readonly<Record<Section, { title: string; description: string }>> = {
  today: { title: "今天", description: "现在值得处理、继续和阅读的内容。" },
  inbox: { title: "待处理", description: "处理尚未确定去向的输入，并查看文件转换进度。" },
  reading: { title: "订阅阅读", description: "浏览 RSS、周刊、教程与工具更新；选择想学习后才会进入学习。" },
  learning: { title: "学习", description: "继续学习，或准备下一份学习笔记。" },
  projects: { title: "项目", description: "聚焦进行中项目的状态和下一步行动。" },
  knowledge: { title: "知识库", description: "搜索、阅读和维护知识笔记与知识导航。" },
  life: { title: "生活", description: "书写今天，回看最近的记录与复盘。" },
  system: { title: "系统状态", description: "只处理异常、后台任务和高级维护。" },
};

export const PROJECT_ACTION_PANEL_LABELS = [
  "记录待整理想法",
  "添加资料",
  "打开项目日志",
  "记录项目决策",
  "用 AI 整理项目",
] as const;

/** Resolves the concrete Vault files a Study Guide hands to Codex. */
export async function resolveDashboardLearningSources(
  app: App,
  notePath: string,
): Promise<string[]> {
  const note = app.vault.getAbstractFileByPath(notePath);
  if (!(note instanceof TFile)) {
    const onDisk = (await app.vault.adapter.stat(notePath))?.type === "file";
    throw new Error(onDisk
      ? `目标笔记在磁盘中，但 Obsidian 尚未识别；请重新加载后重试：${notePath}`
      : `目标笔记不存在，无法核对来源：${notePath}`);
  }
  const candidates = new Set<string>();
  const unresolved = new Set<string>();
  const add = (value: unknown): void => {
    if (value === undefined || value === null) return;
    if (typeof value !== "string") throw new Error(`来源路径不是字符串：${notePath}`);
    const normalized = value.replace(/^\/+|\/+$/gu, "");
    if (!normalized) return;
    if (normalized.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
      throw new Error(`来源路径无效：${value}`);
    }
    if (app.vault.getAbstractFileByPath(normalized) instanceof TFile) {
      candidates.add(normalized);
    } else {
      unresolved.add(normalized);
    }
  };
  const frontmatter = await currentFrontmatter(app, note);
  // A pending Source is itself the Learning row; its paired Source Text must
  // be handed to Claudian just as explicitly as it is for an existing Guide.
  add(frontmatter?.text);
  add(frontmatter?.extract);
  const sources = frontmatter?.sources;
  if (sources !== undefined && !Array.isArray(sources)) {
    throw new Error(`来源列表格式无效：${notePath}`);
  }
  if (Array.isArray(sources)) {
    for (const source of sources) {
      if (source && typeof source === "object") {
        const resource = (source as { resource?: unknown }).resource;
        if (resource === undefined) throw new Error(`来源条目缺少 resource：${notePath}`);
        add(resource);
      }
      else add(source);
    }
  }
  for (const sourcePath of [...candidates]) {
    const source = app.vault.getAbstractFileByPath(sourcePath);
    if (!(source instanceof TFile)) continue;
    const sourceFrontmatter = await currentFrontmatter(app, source);
    add(sourceFrontmatter?.text);
    add(sourceFrontmatter?.extract);
    const markdown = await app.vault.read(source);
    for (const match of markdown.matchAll(/\]\(\/?(sources\/(?:text|extracts)\/[^)]+\.md)\)/gu)) {
      add(match[1]);
    }
  }
  if (unresolved.size) {
    const details = await Promise.all([...unresolved].map(async (path) => {
      const onDisk = (await app.vault.adapter.stat(path))?.type === "file";
      return `${path}（${onDisk ? "磁盘存在但 Obsidian 未识别" : "磁盘不存在"}）`;
    }));
    throw new Error(`以下声明的来源无法读取，已停止生成，避免遗漏资料：${details.join("；")}`);
  }
  return [...candidates];
}

async function currentFrontmatter(app: App, file: TFile): Promise<Record<string, unknown>> {
  const markdown = await app.vault.read(file);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match) return {};
  const parsed: unknown = parseYaml(match[1] ?? "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`笔记 frontmatter 无法解析为字段：${file.path}`);
  }
  return parsed as Record<string, unknown>;
}

export class OkfDashboardView {
  public readonly app: App;
  public readonly contentEl: HTMLElement;
  private readonly embedded: boolean;
  private readonly focused: boolean;
  private readonly workbenchPath: string | undefined;
  private readonly initialSection: Section;
  private section: Section = "today";
  private taskCenterOpen = false;
  private todayPane: TodayPane = "actions";
  private learningTab: "pending" | "active" | "completed" = "active";
  private learningContext: LearningContextFilter = "all";
  private learningRelationPath = "";
  private inboxTab: "decision" | "progress" = "decision";
  private projectsTab: "active" | "paused" | "completed" = "active";
  private knowledgeFilter: "all" | "pending" | "wiki" | "map" | "unverified" | "stale" | "deprecated" = "all";
  private knowledgeQuery = "";
  private inboxIngestedVia: IngestedViaFilter = "all";
  private readonly selectedCaptures = new Set<string>();
  private readonly pageScroll = new Map<Section, number>();
  private readonly feedScroll: Partial<Record<DashboardFeed, number>> = {};
  private readonly feedScrollEdition: Partial<Record<DashboardFeed, string>> = {};
  private readonly feedScrollPersistTimers: Partial<Record<DashboardFeed, number>> = {};
  private readonly readingSourceScroll = new Map<string, number>();
  private readonly readingSourceScrollDigest = new Map<string, string>();
  private readonly readingSourceScrollPersistTimers = new Map<string, number>();
  private readonly readingSourceItems = new Map<string, ReadingSourceItemsState>();
  private readonly readingSourceItemsRequestQueue: ReadingSourceItemsRequest[] = [];
  private readingSourceItemsActiveRequests = 0;
  private readingSourceItemsRequestGeneration = 0;
  private readingSourceItemsEndpointConfirmed = false;
  private readingSourceItemsEndpointDisabled = false;
  private readingSourceItemsRequestsCancelled = false;
  private subscriptionLatestItemsPagination = false;
  private subscriptionEditions: FeedDigestEdition[] = [];
  private subscriptionCursor: string | null = null;
  private subscriptionHasMore = false;
  private subscriptionTotalEditions: number | null = null;
  private subscriptionCatalogComplete = true;
  private subscriptionsLoaded = false;
  private subscriptionPagesLoaded = 0;
  private subscriptionLoadedAt = 0;
  private subscriptionProjectionVersion = -1;
  private subscriptionDetailSourceId = "";
  private subscriptionFirstPageRequest: {
    projectionVersion: number;
    sourceId: string;
    generation: number;
    promise: Promise<boolean>;
  } | undefined;
  private subscriptionRequestGeneration = 0;
  private subscriptionPaginationGeneration = 0;
  private subscriptionSources: FeedSubscriptionSource[] = [];
  private subscriptionSourceCursor: string | null = null;
  private subscriptionSourceHasMore = false;
  private subscriptionSourceTotal = 0;
  private subscriptionSourceMatched = 0;
  private subscriptionSourceCatalogComplete = true;
  private subscriptionSourceCatalogIndexing = false;
  private subscriptionSourcesLoaded = false;
  private subscriptionSourcePagesLoaded = 0;
  private subscriptionSourcesLoadedAt = 0;
  private subscriptionSourceProjectionVersion = -1;
  private subscriptionSourceQuery = "";
  private subscriptionSourceLoadedQuery = "";
  private subscriptionSourceFirstPageRequest: {
    projectionVersion: number;
    query: string;
    generation: number;
    promise: Promise<boolean>;
  } | undefined;
  private subscriptionSourceRequestGeneration = 0;
  private subscriptionSourcePaginationGeneration = 0;
  private selectedSubscriptionSource: Pick<FeedSubscriptionSource, "source_id" | "source_name"> | undefined;
  private readingOverviewScroll = 0;
  private readingSearchTimer: number | undefined;
  private readingCatalogRetryTimer: number | undefined;
  private readingSearchRestore: { start: number; end: number } | undefined;
  private readonly actionPanels = new Set<AnchoredActionPanel>();
  private readonly vaultReader: VaultDashboardReader;
  private systemCache: SystemStatus | undefined;
  private renderVersion = 0;
  private pageScrollPersistTimer: number | undefined;
  private refreshTimer: number | undefined;
  private lastInteractionAt = 0;
  private lastRenderAt = 0;

  public constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OkfBrainPlugin,
    options: EmbeddedDashboardSurfaceOptions = {},
  ) {
    // ItemView's constructor appends a new .workspace-leaf-content to `leaf`.
    // An embedded Surface already lives inside Apex's active ItemView, so
    // constructing another ItemView here would split the pane into one hidden
    // Obsidian view per Surface and clip the real dashboard to a thin strip.
    const fallbackView = options.container ? undefined : new StandaloneOkfDashboardContainer(leaf);
    this.app = (plugin as unknown as { app?: App }).app
      ?? fallbackView?.app
      ?? (leaf as unknown as { app: App }).app;
    this.contentEl = options.container ?? fallbackView!.contentEl;
    this.embedded = options.embedded ?? false;
    this.focused = options.focused ?? false;
    this.workbenchPath = options.workbenchPath;
    this.vaultReader = new VaultDashboardReader(this.app);
    const state = this.plugin.getDashboardUiState();
    this.initialSection = options.initialSection ?? state.activeSection;
    this.section = this.initialSection;
    for (const [section, page] of Object.entries(state.pages)) {
      this.pageScroll.set(section as Section, page.scrollTop);
    }
    for (const feed of DASHBOARD_FEEDS) {
      this.feedScroll[feed] = state.feeds[feed].scrollTop;
      const editionId = state.feeds[feed].editionId;
      if (editionId) this.feedScrollEdition[feed] = editionId;
    }
    for (const [sourceId, position] of Object.entries(state.readingSources)) {
      this.readingSourceScroll.set(sourceId, position.scrollTop);
      this.readingSourceScrollDigest.set(sourceId, position.digestId);
    }
    const todayPane = state.pages.today.tab;
    if (todayPane === "actions" || todayPane === "reading") this.todayPane = todayPane;
    const learningTab = state.pages.learning.tab;
    if (learningTab === "pending" || learningTab === "active" || learningTab === "completed") {
      this.learningTab = learningTab;
    }
    const learningContext = state.pages.learning.filters.context;
    if (
      learningContext === "all" || learningContext === "course" ||
      learningContext === "project" || learningContext === "independent"
    ) {
      this.learningContext = learningContext;
    }
    const learningRelation = state.pages.learning.filters.relation;
    if (typeof learningRelation === "string") {
      this.learningRelationPath = learningRelation.replace(/^\/+|\/+$/gu, "");
    }
    const inboxTab = state.pages.inbox.tab;
    if (inboxTab === "decision" || inboxTab === "progress") this.inboxTab = inboxTab;
    const projectsTab = state.pages.projects.tab;
    if (projectsTab === "active" || projectsTab === "paused" || projectsTab === "completed") {
      this.projectsTab = projectsTab;
    }
    const knowledgeFilter = state.pages.knowledge.filters.view;
    if (
      knowledgeFilter === "all" || knowledgeFilter === "pending" || knowledgeFilter === "wiki" || knowledgeFilter === "map" ||
      knowledgeFilter === "unverified" || knowledgeFilter === "stale" || knowledgeFilter === "deprecated"
    ) {
      this.knowledgeFilter = knowledgeFilter;
    }
    const knowledgeQuery = state.pages.knowledge.filters.query;
    if (typeof knowledgeQuery === "string") this.knowledgeQuery = knowledgeQuery;
    const subscriptionSourceQuery = state.pages.reading.filters.query;
    if (typeof subscriptionSourceQuery === "string") {
      this.subscriptionSourceQuery = subscriptionSourceQuery.trim();
    }
    const ingestion = state.pages.inbox.filters.ingestedVia;
    if (
      typeof ingestion === "string" &&
      (ingestion === "all" || ingestion === "unlabeled" || INGESTED_VIA_ORDER.some((value) => value === ingestion))
    ) {
      this.inboxIngestedVia = ingestion as IngestedViaFilter;
    }
  }

  public getViewType(): string {
    return OKF_DASHBOARD_VIEW;
  }

  public getDisplayText(): string {
    return "工作台";
  }

  public getIcon(): string {
    return "brain-circuit";
  }

  public async onOpen(): Promise<void> {
    this.readingSourceItemsRequestsCancelled = false;
    this.contentEl.addEventListener("scroll", this.handlePageScroll, { passive: true });
    this.contentEl.addEventListener("pointerdown", this.markDashboardInteraction, { passive: true });
    this.contentEl.addEventListener("keydown", this.markDashboardInteraction);
    await this.render();
  }

  public async onClose(): Promise<void> {
    this.destroyActionPanels();
    this.contentEl.removeEventListener("scroll", this.handlePageScroll);
    this.contentEl.removeEventListener("pointerdown", this.markDashboardInteraction);
    this.contentEl.removeEventListener("keydown", this.markDashboardInteraction);
    if (this.pageScrollPersistTimer !== undefined) {
      window.clearTimeout(this.pageScrollPersistTimer);
      this.pageScrollPersistTimer = undefined;
    }
    if (this.refreshTimer !== undefined) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.readingSearchTimer !== undefined) {
      window.clearTimeout(this.readingSearchTimer);
      this.readingSearchTimer = undefined;
    }
    if (this.readingCatalogRetryTimer !== undefined) {
      window.clearTimeout(this.readingCatalogRetryTimer);
      this.readingCatalogRetryTimer = undefined;
    }
    this.subscriptionSourceRequestGeneration += 1;
    this.subscriptionSourcePaginationGeneration += 1;
    this.subscriptionSourceFirstPageRequest = undefined;
    this.subscriptionRequestGeneration += 1;
    this.subscriptionPaginationGeneration += 1;
    this.subscriptionFirstPageRequest = undefined;
    this.cancelReadingSourceItemRequests();
    for (const kind of DASHBOARD_FEEDS) {
      const timer = this.feedScrollPersistTimers[kind];
      if (timer !== undefined) window.clearTimeout(timer);
      delete this.feedScrollPersistTimers[kind];
      const scrollTop = this.feedScroll[kind];
      if (scrollTop !== undefined) {
        this.plugin.updateDashboardFeedUiState(kind, {
          scrollTop,
          editionId: this.feedScrollEdition[kind] ?? null,
        });
      }
    }
    for (const [sourceId, timer] of this.readingSourceScrollPersistTimers) {
      window.clearTimeout(timer);
      this.persistReadingSourceScroll(sourceId);
    }
    this.readingSourceScrollPersistTimers.clear();
    this.readingSourceScroll.clear();
    this.readingSourceScrollDigest.clear();
    const scrollTop = this.contentEl.scrollTop;
    this.pageScroll.set(this.section, scrollTop);
    this.plugin.updateDashboardPageUiState(this.section, { scrollTop });
  }

  public async refresh(): Promise<void> {
    this.scheduleExternalRefresh();
  }

  private api(): LocalApi {
    return this.plugin.api();
  }

  private async render(preserveScroll = false): Promise<void> {
    if (this.refreshTimer !== undefined) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const renderVersion = ++this.renderVersion;
    const root = this.contentEl;
    if (preserveScroll) {
      this.pageScroll.set(this.section, root.scrollTop);
      this.plugin.updateDashboardPageUiState(this.section, { scrollTop: root.scrollTop });
    }
    const previousScroll = this.pageScroll.get(this.section) ?? 0;
    this.destroyActionPanels();
    root.empty();
    root.addClass("okf-dashboard");
    root.toggleClass("okf-dashboard--embedded", this.embedded);
    root.toggleClass("okf-dashboard--focused", this.focused);
    if (!this.embedded) {
      const topbar = root.createDiv({ cls: "okf-dashboard__topbar" });
      if (this.focused) {
        const back = topbar.createEl("button", {
          text: "返回工作台",
          cls: "okf-dashboard__ghost-action",
          attr: { type: "button" },
        });
        back.addEventListener("click", () => void this.plugin.returnToOkfWorkbench(this.workbenchPath));
      } else {
        const nav = topbar.createDiv({ cls: "okf-dashboard__nav", attr: { role: "tablist" } });
        NAVIGATION.forEach((item, index) => {
          const active = item.id === this.section;
          const button = nav.createEl("button", {
            text: item.label,
            cls: active ? "is-active" : "",
            attr: { type: "button", role: "tab", "aria-selected": String(active) },
          });
          button.addEventListener("click", () => {
            this.openSection(item.id);
          });
          button.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const target = NAVIGATION[(index + direction + NAVIGATION.length) % NAVIGATION.length];
            if (target) this.openSection(target.id);
          });
        });
      }
      const utilities = topbar.createDiv({ cls: "okf-dashboard__utilities" });
      const search = utilities.createEl("button", {
        text: "搜索",
        cls: "okf-dashboard__ghost-action okf-dashboard__search-action",
        attr: { type: "button", "aria-label": "搜索笔记" },
      });
      search.addEventListener("click", () => this.openGlobalSearch());
      const create = utilities.createEl("button", {
        text: "＋",
        cls: "okf-dashboard__icon-action",
        attr: { type: "button", "aria-label": "快速创建" },
      });
      create.addEventListener("click", () => this.plugin.promptActionMenu());
      const codex = utilities.createEl("button", {
        text: "问我的笔记",
        cls: "okf-dashboard__ghost-action okf-dashboard__codex-action",
        attr: { type: "button", "aria-label": "问我的笔记" },
      });
      codex.addEventListener("click", () => this.plugin.promptAsk());
      this.renderBackgroundTasks(utilities);
      const settings = utilities.createEl("button", {
        text: "系统状态",
        cls: this.section === "system" ? "is-active okf-dashboard__ghost-action" : "okf-dashboard__ghost-action",
        attr: { type: "button", "aria-label": "系统状态与设置" },
      });
      settings.addEventListener("click", () => this.openSection("system"));
    }
    const body = root.createDiv({ cls: "okf-dashboard__body" });
    if (!this.embedded) {
      const pageHeader = body.createDiv({ cls: "okf-dashboard__page-header" });
      const pageCopy = PAGE_COPY[this.section];
      const heading = pageHeader.createDiv();
      heading.createEl("h2", { text: pageCopy.title });
      heading.createDiv({ cls: "okf-dashboard__muted", text: pageCopy.description });
      if (this.focused && !this.plugin.hasOkfSectionInActiveWorkbench(this.section, this.workbenchPath)) {
        const add = pageHeader.createEl("button", {
          text: "添加到当前工作台",
          cls: "okf-dashboard__secondary-action",
          attr: { type: "button" },
        });
        add.addEventListener("click", () => {
          void this.plugin.addOkfSectionToActiveWorkbench(this.section, this.workbenchPath)
            .catch((error: unknown) => new Notice(error instanceof Error ? error.message : "添加卡片失败"));
        });
      }
    }
    const loading = body.createDiv({ cls: "okf-dashboard__loading", text: "正在读取本地笔记…" });
    try {
      if (this.section === "today") await this.renderToday(body);
      else if (this.section === "inbox") await this.renderInbox(body);
      else if (this.section === "reading") await this.renderReading(body);
      else if (this.section === "system") await this.renderSystem(body);
      else if (this.section === "life") await this.renderLife(body);
      else if (this.section === "learning") await this.renderLearning(body);
      else if (this.section === "projects") await this.renderProjects(body);
      else await this.renderKnowledge(body);
      const warnings = this.vaultReader.getReadWarnings();
      if (warnings.length && renderVersion === this.renderVersion) {
        const warning = body.createEl("details", { cls: "okf-dashboard__error" });
        warning.createEl("summary", { text: `${warnings.length} 个文件暂时无法读取；其余内容仍可使用` });
        for (const item of warnings.slice(0, 10)) {
          warning.createDiv({ text: `${item.path}：${item.message}` });
        }
        const retry = warning.createEl("button", { text: "重新读取", attr: { type: "button" } });
        retry.addEventListener("click", () => void this.render(true));
      }
    } catch (error) {
      if (renderVersion !== this.renderVersion) return;
      const failure = body.createDiv({
        cls: "okf-dashboard__error",
        text: error instanceof Error ? error.message : "工作台加载失败",
      });
      const retry = failure.createEl("button", { text: "重新加载" });
      retry.addEventListener("click", () => void this.render());
      this.renderServiceSettingsAction(failure, error);
    } finally {
      loading.remove();
      if (renderVersion === this.renderVersion) {
        root.scrollTop = previousScroll;
        this.lastRenderAt = Date.now();
      }
    }
  }

  private renderBackgroundTasks(parent: HTMLElement): void {
    const operations = [...this.plugin.semanticOperationsSnapshot()];
    const conversions = [...this.plugin.conversionSnapshot()];
    const active = operations.filter((operation) => isSemanticOperationActive(operation.status));
    const interrupted = operations.filter((operation) => operation.status === "orphaned");
    const activeConversions = conversions.filter((conversion) =>
      ["queued", "converting", "waiting-for-mineru"].includes(conversion.status)
      || hasPendingGeneration(conversion),
    );
    const recentCutoff = Date.now() - 30 * 60_000;
    const recent = operations
      .filter((operation) =>
        ["completed", "failed", "cancelled"].includes(operation.status) &&
        Date.parse(operation.updated_at) >= recentCutoff,
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, 2);
    const recentConversions = conversions
      .filter((conversion) =>
        ["imported", "failed"].includes(conversion.status) &&
        !hasPendingGeneration(conversion) &&
        (conversion.status === "failed" || Date.parse(conversion.updated_at ?? "") >= recentCutoff),
      )
      .slice(0, 2);
    if (
      !active.length &&
      !interrupted.length &&
      !recent.length &&
      !activeConversions.length &&
      !recentConversions.length
    ) return;
    const running = active.length + activeConversions.length;
    const failed = interrupted.length + recent.filter((item) => item.status === "failed").length +
      recentConversions.filter((item) => item.status === "failed").length;
    const toggle = parent.createEl("button", {
      cls: `okf-dashboard__task-toggle${running ? " is-running" : ""}${failed ? " is-error" : ""}`,
      text: failed ? `任务异常 ${failed}` : running ? `后台任务 ${running}` : "最近任务",
      attr: {
        type: "button",
        "aria-expanded": String(this.taskCenterOpen),
      },
    });
    toggle.addEventListener("click", () => {
      this.taskCenterOpen = !this.taskCenterOpen;
      void this.render(true);
    });
    if (!this.taskCenterOpen) return;
    const center = parent.createEl("section", { cls: "okf-dashboard__task-center is-open" });
    const close = center.createEl("button", { cls: "okf-dashboard__task-close", text: "收起" });
    close.addEventListener("click", () => {
      this.taskCenterOpen = false;
      void this.render(true);
    });
    const heading = center.createDiv({ cls: "okf-dashboard__section-heading" });
    heading.createEl("h3", { text: "后台任务" });
    heading.createDiv({
      cls: "okf-dashboard__muted",
      text: running
        ? `${running} 个任务正在处理；切换页面不会中断`
        : failed
          ? `${failed} 个任务需要处理`
          : "最近完成",
    });
    const list = center.createDiv({ cls: "okf-dashboard__cards" });
    for (const operation of [...active, ...interrupted, ...recent]) {
      const card = list.createDiv({ cls: "okf-dashboard__card" });
      const isWiki = operation.kind === "generate-wiki";
      card.createEl("strong", { text: isWiki ? "知识笔记生成" : "学习材料生成" });
      const label =
        operation.status === "queued"
          ? "排队中"
          : operation.status === "running"
            ? semanticStageLabel(operation)
            : operation.status === "orphaned"
              ? "后台任务中断"
            : operation.status === "completed"
              ? "已完成"
              : operation.status === "failed"
                ? "失败"
                : "已取消";
      card.createDiv({ cls: "okf-dashboard__muted", text: `${label} · ${operation.target}` });
      if (operation.status === "running" && operation.stage_detail) {
        card.createDiv({ cls: "okf-dashboard__muted", text: operation.stage_detail });
      }
      if (operation.error) card.createDiv({ text: operation.error });
      if (
        operation.status === "completed" ||
        this.app.vault.getAbstractFileByPath(operation.target) instanceof TFile
      ) {
        const open = card.createEl("button", {
          text: operation.status === "completed" ? "打开结果" : "打开已有目标笔记",
        });
        open.addEventListener("click", () => void this.openPath(operation.target));
      }
      if (
        isSemanticOperationActive(operation.status) &&
        !["publishing", "indexing"].includes(operation.stage ?? "")
      ) {
        const cancel = card.createEl("button", { text: "取消后台任务" });
        cancel.addEventListener("click", () => {
          void this.runButtonAction(
            cancel,
            () => this.api().cancelSemanticOperation(operation.operation_id),
            true,
            "已请求停止后台任务",
          );
        });
      } else if (isSemanticOperationRetryable(operation.status)) {
        const retry = card.createEl("button", { text: "重新生成" });
        retry.addEventListener("click", () => {
          void this.runButtonAction(
            retry,
            async () => {
              const retried = await this.api().retrySemanticOperation(operation.operation_id);
              this.plugin.watchSemanticOperation(retried.operation_id);
            },
            true,
            "已重新加入后台任务",
          );
        });
      }
    }
    for (const conversion of [...activeConversions, ...recentConversions]) {
      const card = list.createDiv({ cls: "okf-dashboard__card" });
      card.createEl("strong", { text: `文档导入 · ${conversion.source_filename}` });
      const readyToPublish =
        conversion.status === "failed" &&
        conversion.stages?.conversion === "completed" &&
        conversion.stages.routing === "failed";
      const label = hasPendingGeneration(conversion)
        ? conversionStatusLabel(conversion)
        : conversion.status === "queued"
          ? "已排队"
          : conversion.status === "converting"
            ? `正在使用 ${conversion.parser} 转换`
            : conversion.status === "waiting-for-mineru"
              ? "等待 MinerU"
              : conversion.status === "imported"
                ? "已导入"
                : readyToPublish
                  ? "转换已完成，待继续保存"
                  : "需要处理";
      card.createDiv({ cls: "okf-dashboard__muted", text: label });
      if (conversion.error) {
        card.createDiv({ text: readyToPublish ? `上次保存失败：${conversion.error}` : conversion.error });
      }
      for (const warning of conversion.warnings ?? []) {
        card.createDiv({ cls: "okf-dashboard__muted", text: warning });
      }
      const target = conversion.outputs.source_text ?? conversion.outputs.source;
      if (target) {
        const open = card.createEl("button", { text: "打开转换正文" });
        open.addEventListener("click", () => void this.openPath(target));
      }
      if (readyToPublish || hasPendingGeneration(conversion)) {
        const resume = card.createEl("button", {
          text: hasPendingGeneration(conversion) ? "重试生成入队" : "继续保存",
        });
        resume.addEventListener("click", () => {
          void this.runButtonAction(resume, async () => {
            const record = await this.api().retryConversion(conversion.conversion_id);
            this.plugin.watchDocumentConversion(record.conversion_id);
          }, true, "已继续保存；不会重新转换文档");
        });
      }
    }
  }

  private renderDocumentDropZone(
    parent: HTMLElement,
    relation: Pick<DocumentImportOptions, "course" | "project">,
    origin: ImportOrigin,
  ): void {
    const zone = parent.createDiv({
      cls: "okf-document-drop okf-dashboard__document-drop",
      text: "拖入文件或文件夹以导入资料 · 也可点击此处选择",
      attr: { role: "button", tabindex: "0", "aria-label": "导入文件或文件夹" },
    });
    const open = (files: ImportFile[] = []): void => this.plugin.openDocumentImport(files, relation, origin);
    zone.addEventListener("click", () => open());
    zone.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
    bindDocumentDropTarget(zone, open, (error) => {
      new Notice(error instanceof Error ? error.message : "无法读取拖入的文件夹", 8_000);
    });
  }

  private async renderToday(container: HTMLElement): Promise<void> {
    const [data, inbox, vaultTasks] = await Promise.all([
      this.vaultReader.today(),
      this.vaultReader.inbox(),
      this.collectFormalTasks(),
    ]);
    const actions = container.createDiv({ cls: "okf-dashboard__hero-actions okf-dashboard__today-actions" });
    const daily = actions.createEl("button", {
      text: data.daily.exists ? "继续写今日日记" : "创建今日日记",
      cls: "mod-cta okf-dashboard__primary-action",
    });
    daily.addEventListener("click", () => void this.openDaily(data));
    const jot = actions.createEl("button", { text: "快速记录", cls: "okf-dashboard__secondary-action" });
    jot.addEventListener("click", () => this.plugin.promptCapture());
    const importDocument = actions.createEl("button", {
      text: "导入资料",
      cls: "okf-dashboard__ghost-action",
    });
    importDocument.addEventListener("click", () => this.plugin.openDocumentImport([], {}, "today"));
    this.renderDocumentDropZone(container, {}, "today");

    const paneTabs = container.createDiv({
      cls: "okf-dashboard__segments okf-today-pane-tabs",
      attr: { role: "tablist", "aria-label": "今天内容" },
    });
    for (const option of [
      { value: "actions" as const, label: "行动" },
      { value: "reading" as const, label: "每日更新" },
    ]) {
      const selected = this.todayPane === option.value;
      const button = paneTabs.createEl("button", {
        text: option.label,
        cls: selected ? "is-active" : "",
        attr: { type: "button", role: "tab", "aria-selected": String(selected) },
      });
      button.addEventListener("click", () => {
        this.todayPane = option.value;
        this.plugin.updateDashboardPageUiState("today", { tab: option.value });
        void this.render(true);
      });
    }

    const workspace = container.createDiv({ cls: "okf-today-workspace" });
    const actionPane = workspace.createEl("section", {
      cls: `okf-today-pane okf-today-pane--actions${this.todayPane === "actions" ? " is-mobile-active" : ""}`,
      attr: { "aria-label": "行动" },
    });
    const readingPane = workspace.createEl("section", {
      cls: `okf-today-pane okf-today-pane--reading${this.todayPane === "reading" ? " is-mobile-active" : ""}`,
      attr: { "aria-label": "每日更新" },
    });
    const actionSection = this.dashboardSection(
      actionPane,
      "今日行动",
      "先继续正在推进的内容，再处理需要判断的事项。",
      "okf-today-action-section",
    );
    const systemWarningSlot = actionSection.createDiv({
      cls: "okf-today-system-slot is-empty",
      attr: { "aria-live": "polite", "aria-label": "系统状态提醒" },
    });
    const actionGrid = actionSection.createDiv({ cls: "okf-today-action-grid" });

    const attentionCounts = countTodayAttention({
      inbox,
      pendingStudyCount: data.pending_study_count,
      pendingWikiCount: data.pending_wiki_count,
      tasks: data.tasks,
      operations: this.plugin.semanticOperationsSnapshot(),
      conversions: this.plugin.conversionSnapshot(),
    });

    const continueItems = selectDashboardContinueItems(
      [...data.recent_study, ...data.active_projects, ...data.active_courses],
      { recentOpenedPaths: this.plugin.recentDashboardFiles().map((item) => item.path) },
    );
    const continuing = this.dashboardSection(
      actionGrid,
      "继续进行",
      "最近打开和可以接着推进的内容。",
      "okf-dashboard__continue",
    );
    if (continueItems.length) {
      const list = continuing.createDiv({ cls: "okf-dashboard__continue-list" });
      const recentPaths = new Set(this.plugin.recentDashboardFiles().map((item) => item.path.replace(/^\/+|\/+$/gu, "")));
      for (const item of continueItems) {
        const project = data.active_projects.find((candidate) => candidate.path === item.note.path);
        const course = data.active_courses.find((candidate) => candidate.path === item.note.path);
        const recentlyOpened = recentPaths.has(item.note.path.replace(/^\/+|\/+$/gu, ""));
        const meta = item.kind === "study-guide"
          ? `学习笔记 · ${recentlyOpened ? "最近打开" : "可学习"}`
          : item.kind === "project"
            ? `项目 · 下一步：${compactText(project?.next_action || "尚未填写", 90)}`
            : `课程 · ${course?.current_progress || `${course?.lesson_count ?? 0} 篇课堂笔记`}`;
        this.compactRow(
          list,
          item.note.title,
          meta,
          "打开",
          () => void this.openPath(item.note.path),
        );
      }
    } else {
      continuing.remove();
    }

    const pending = this.dashboardSection(
      actionGrid,
      "待处理",
      "需要整理的记录、待准备的材料和异常任务。",
      "okf-today-pending",
    );
    const attention = pending.createDiv({
      cls: "okf-dashboard__attention-strip is-vertical",
      attr: { "aria-label": "待处理" },
    });
    this.attentionItem(
      attention,
      "异常",
      attentionCounts.background_failed,
      () => this.openSection("system"),
      true,
    );
    this.attentionItem(attention, "待处理", attentionCounts.inbox_decisions, () => {
      this.inboxTab = "decision";
      this.plugin.updateDashboardPageUiState("inbox", { tab: "decision" });
      this.openSection("inbox");
    });
    this.attentionItem(attention, "待生成学习笔记", attentionCounts.pending_study, () => {
      this.learningTab = "pending";
      this.learningContext = "all";
      this.learningRelationPath = "";
      this.plugin.updateDashboardPageUiState("learning", {
        tab: "pending",
        filters: { context: "all", relation: null },
      });
      this.openSection("learning");
    });
    this.attentionItem(attention, "待生成知识笔记", attentionCounts.pending_wiki, () => {
      this.knowledgeFilter = "pending";
      this.plugin.updateDashboardPageUiState("knowledge", { filters: { view: "pending" } });
      this.openSection("knowledge");
    });
    this.attentionItem(attention, "知识待复核", data.stale_knowledge.length, () => {
      this.knowledgeFilter = "stale";
      this.plugin.updateDashboardPageUiState("knowledge", { filters: { view: "stale" } });
      this.openSection("knowledge");
    });
    this.attentionItem(attention, "后台运行", attentionCounts.background_running, () => {
      if (this.embedded) {
        this.openSection("system");
        return;
      }
      this.taskCenterOpen = true;
      void this.render(true);
    });
    if (!attention.querySelectorAll<HTMLElement>(".okf-dashboard__attention-item").length) pending.remove();

    if (data.tasks.length) {
      const tasks = this.dashboardSection(
        actionGrid,
        "待办",
        `${data.tasks.length} 项未完成；这里显示前 4 项。`,
        "okf-today-tasks",
      );
      const list = tasks.createDiv({ cls: "okf-dashboard__compact-list okf-formal-task-list" });
      const taskIndex = new Map(vaultTasks.map((task) => [`${task.path}:${task.line + 1}`, task]));
      for (const item of data.tasks.slice(0, 4)) {
        const task = taskIndex.get(`${item.path}:${item.line}`);
        if (task) this.renderFormalTaskRow(list, task);
        else {
          this.compactRow(
            list,
            compactText(item.text, 100),
            relationName(item.path),
            "打开",
            () => void this.openPath(item.path),
          );
        }
      }
      if (data.tasks.length > 4) {
        const more = tasks.createEl("button", { text: "查看全部待办", cls: "okf-dashboard__ghost-action" });
        more.addEventListener("click", () => void this.openPath("system/views/Tasks.md"));
      }
    }

    const actionColumnCount = actionGrid.querySelectorAll<HTMLElement>(".okf-dashboard__section").length;
    actionGrid.addClass(`has-${actionColumnCount}-columns`);
    if (!actionColumnCount) {
      actionGrid.createDiv({ cls: "okf-dashboard__empty", text: "今天没有需要继续或处理的行动。" });
    }

    this.renderDailyFeeds(readingPane);

    void this.api()
      .systemStatus()
      .then((system) => {
        if (!system.actionable.length || !systemWarningSlot.isConnected) return;
        systemWarningSlot.removeClass("is-empty");
        const warning = systemWarningSlot.createDiv({ cls: "okf-dashboard__inline-alert" });
        warning.createEl("strong", { text: `System · ${system.actionable.length} 项需要处理` });
        warning.createSpan({ text: " " + system.actionable[0]?.detail });
        const open = warning.createEl("button", { text: "查看", cls: "okf-dashboard__ghost-action" });
        open.addEventListener("click", () => this.openSection("system"));
      })
      .catch(() => undefined);
  }

  private collapsedExcerpt(parent: HTMLElement, excerpt: string): void {
    const visible = excerpt.trim();
    if (!visible) return;
    const details = parent.createEl("details", { cls: "okf-dashboard__excerpt" });
    details.createEl("summary", { text: "预览内容" });
    details.createDiv({ text: visible });
  }

  private dashboardSection(
    parent: HTMLElement,
    title: string,
    description: string,
    className = "",
  ): HTMLElement {
    const section = parent.createEl("section", {
      cls: `okf-dashboard__section ${className}`.trim(),
    });
    const heading = section.createDiv({ cls: "okf-dashboard__section-heading" });
    heading.createEl("h3", { text: title });
    heading.createDiv({ cls: "okf-dashboard__muted", text: description });
    return section;
  }

  private attentionItem(
    parent: HTMLElement,
    label: string,
    count: number,
    action: () => void,
    danger = false,
  ): void {
    if (count <= 0) return;
    const button = parent.createEl("button", {
      cls: `okf-dashboard__attention-item${danger ? " is-danger" : ""}`,
      attr: { type: "button", "aria-label": `${label} ${count}` },
    });
    button.createEl("strong", { text: String(count) });
    button.createSpan({ text: label });
    button.addEventListener("click", action);
  }

  private compactRow(
    parent: HTMLElement,
    title: string,
    meta: string,
    actionLabel: string,
    action: () => void,
    badge?: string,
  ): HTMLElement {
    const row = parent.createDiv({ cls: "okf-dashboard__compact-row" });
    const main = row.createDiv({ cls: "okf-dashboard__row-main" });
    const titleButton = main.createEl("button", {
      text: title,
      cls: "okf-dashboard__row-title",
      attr: { type: "button" },
    });
    titleButton.addEventListener("click", action);
    if (meta) main.createDiv({ cls: "okf-dashboard__row-meta", text: meta });
    if (badge) row.createSpan({ cls: "okf-dashboard__badge", text: badge });
    const open = row.createEl("button", {
      text: actionLabel,
      cls: "okf-dashboard__ghost-action okf-dashboard__row-action",
      attr: { type: "button" },
    });
    open.addEventListener("click", action);
    return row;
  }

  private renderFormalTaskRow(parent: HTMLElement, task: VaultTask): void {
    const row = parent.createDiv({ cls: "okf-formal-task-row" });
    const checkbox = row.createEl("input", {
      attr: { type: "checkbox", "aria-label": `完成 ${task.text}` },
    });
    checkbox.checked = task.checked;
    checkbox.addEventListener("change", () => {
      checkbox.disabled = true;
      void toggleTaskInFile(this.app, task, checkbox.checked)
        .then((wrote) => {
          if (!wrote) {
            checkbox.checked = task.checked;
            new Notice("任务已变化，请刷新后重试。", 5_000);
            return;
          }
          invalidatePath(task.path);
          row.remove();
          this.plugin.refreshDashboardViews();
        })
        .catch((error: unknown) => {
          checkbox.checked = task.checked;
          new Notice(error instanceof Error ? error.message : "任务更新失败", 5_000);
        })
        .finally(() => { checkbox.disabled = false; });
    });
    const title = row.createEl("button", {
      cls: "okf-formal-task-row__title",
      text: task.text,
      attr: { type: "button", title: task.path },
    });
    title.addEventListener("click", () => void this.openPath(task.path));
    const dates = [
      task.reminder ? `提醒 ${task.reminder}` : "",
      task.scheduled ? `计划 ${task.scheduled}${task.scheduledTime ? ` ${task.scheduledTime}` : ""}` : "",
      task.due ? `截止 ${task.due}` : "",
    ].filter(Boolean).join(" · ");
    const editDates = row.createEl("button", {
      cls: "okf-dashboard__ghost-action okf-formal-task-row__dates",
      text: dates || "设置日期",
      attr: { type: "button", title: "分别编辑提醒、计划日和截止日" },
    });
    editDates.addEventListener("click", () => this.plugin.promptTaskDates(task));
  }

  private collectFormalTasks(): Promise<VaultTask[]> {
    const vault = (this.app as App & { vault?: { getMarkdownFiles?: unknown } }).vault;
    if (!vault || typeof vault.getMarkdownFiles !== "function") return Promise.resolve([]);
    return collectVaultTasks(this.app);
  }

  private openSection(section: Section): void {
    if (this.embedded || this.focused) {
      void this.plugin.navigateToOkfSection(section, this.contentEl, this.workbenchPath)
        .catch((error: unknown) => new Notice(error instanceof Error ? error.message : "无法打开页面"));
      return;
    }
    if (this.refreshTimer !== undefined) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.pageScrollPersistTimer !== undefined) {
      window.clearTimeout(this.pageScrollPersistTimer);
      this.pageScrollPersistTimer = undefined;
    }
    const currentScroll = this.contentEl.scrollTop;
    this.pageScroll.set(this.section, currentScroll);
    this.plugin.updateDashboardPageUiState(this.section, { scrollTop: currentScroll });
    this.section = section;
    this.plugin.updateDashboardUiState({ activeSection: section });
    void this.render();
  }

  private openGlobalSearch(): void {
    const commands = (
      this.app as typeof this.app & {
        commands?: { executeCommandById: (id: string) => boolean };
      }
    ).commands;
    const opened = commands?.executeCommandById("global-search:open") ?? false;
    if (!opened) new Notice("无法打开 Obsidian 搜索，可使用 Ctrl/Cmd + Shift + F。", 6_000);
  }

  private readonly handlePageScroll = (): void => {
    this.lastInteractionAt = Date.now();
    if (this.pageScrollPersistTimer !== undefined) {
      window.clearTimeout(this.pageScrollPersistTimer);
    }
    this.pageScrollPersistTimer = window.setTimeout(() => {
      this.pageScrollPersistTimer = undefined;
      const scrollTop = this.contentEl.scrollTop;
      this.pageScroll.set(this.section, scrollTop);
      this.plugin.updateDashboardPageUiState(this.section, { scrollTop });
    }, 150);
  };

  private readonly markDashboardInteraction = (): void => {
    this.lastInteractionAt = Date.now();
  };

  private scheduleExternalRefresh(): void {
    if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
    const focused = this.contentEl.ownerDocument?.activeElement;
    const editing = focused instanceof HTMLElement &&
      this.contentEl.contains(focused) &&
      (focused.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName));
    const actionPanelOpen = [...this.actionPanels].some((panel) => panel.isOpen);
    const recentlyInteracting = Date.now() - this.lastInteractionAt < 1_200;
    const recentlyRendered = Date.now() - this.lastRenderAt < 350;
    const delay = editing || actionPanelOpen || recentlyInteracting ? 1_200 : recentlyRendered ? 350 : 180;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      const active = this.contentEl.ownerDocument?.activeElement;
      const stillEditing = active instanceof HTMLElement &&
        this.contentEl.contains(active) &&
        (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
      if (
        stillEditing ||
        [...this.actionPanels].some((panel) => panel.isOpen) ||
        Date.now() - this.lastInteractionAt < 1_200
      ) {
        this.scheduleExternalRefresh();
        return;
      }
      void this.render(true);
    }, delay);
  }

  private destroyActionPanels(): void {
    for (const panel of this.actionPanels) panel.destroy();
    this.actionPanels.clear();
  }

  private attachActionPanel(
    trigger: HTMLButtonElement,
    options: AnchoredActionPanelOptions,
  ): void {
    // The lightweight Vitest Obsidian runtime intentionally has no browser
    // document. The component itself has dedicated DOM-level tests.
    if (!trigger.ownerDocument?.defaultView) return;
    const panel = new AnchoredActionPanel(trigger, {
      ...options,
      responsiveContainer: options.responsiveContainer ?? this.contentEl,
      onOpen: () => {
        this.lastInteractionAt = Date.now();
        options.onOpen?.();
      },
      onActionError: options.onActionError ?? ((error: unknown) => {
        new Notice(error instanceof Error ? error.message : "操作失败", 10_000);
      }),
    });
    this.actionPanels.add(panel);
  }

  private renderMetrics(
    parent: HTMLElement,
    metrics: readonly DashboardObjectMetric[],
    related: Partial<Record<DashboardObjectMetric["key"], readonly Pick<NoteSummary, "path" | "title">[]>> = {},
  ): void {
    const strip = parent.createEl("span", {
      cls: "okf-work-item__metrics",
      attr: { "aria-label": "关联内容统计" },
    });
    let expanded: HTMLElement | undefined;
    let selected: string | undefined;
    for (const metric of metrics) {
      const notes = related[metric.key] ?? [];
      const element = strip.createEl(notes.length ? "button" : "span", {
        cls: `okf-work-item__metric${metric.count === 0 ? " is-zero" : ""}`,
        text: `${metric.label} ${metric.count}`,
        attr: { "data-metric": metric.key, ...(notes.length ? { type: "button", "aria-label": `查看${metric.label} ${metric.count} 条` } : {}) },
      });
      if (!notes.length) continue;
      element.addEventListener("click", () => {
        if (notes.length === 1) { void this.openPath(notes[0]!.path); return; }
        expanded?.remove();
        for (const button of strip.querySelectorAll("button")) button.setAttribute("aria-expanded", "false");
        if (selected === metric.key) { selected = undefined; return; }
        selected = metric.key;
        element.setAttr("aria-expanded", "true");
        expanded = parent.createDiv({ cls: "okf-work-item__related", attr: { "aria-label": metric.label } });
        for (const note of notes) {
          const link = expanded.createEl("button", { text: note.title, cls: "okf-dashboard__ghost-action", attr: { type: "button" } });
          link.addEventListener("click", () => void this.openPath(note.path));
        }
      });
    }
  }

  private createFeedCardSurface(
    parent: HTMLElement,
    options: {
      title: string;
      meta: string;
      cardClass?: string;
      headerClass?: string;
      metaClass?: string;
      contextClass?: string;
      bodyClass?: string;
      footerClass?: string;
      attributes?: Record<string, string>;
    },
  ): FeedCardSurface {
    const appendClass = (base: string, extra?: string): string => extra ? `${base} ${extra}` : base;
    const card = parent.createEl("article", {
      cls: appendClass("okf-feed-card", options.cardClass),
      attr: options.attributes ?? {},
    });
    const header = card.createEl("header", {
      cls: appendClass("okf-feed-card__header", options.headerClass),
    });
    header.createEl("h3", { text: options.title });
    const meta = header.createDiv({
      cls: appendClass("okf-dashboard__muted okf-feed-card__meta", options.metaClass),
      text: options.meta,
    });
    const context = card.createDiv({
      cls: appendClass("okf-feed-card__context", options.contextClass),
    });
    const body = card.createDiv({
      cls: appendClass("okf-feed-card__body", options.bodyClass),
    });
    const footer = card.createEl("footer", {
      cls: appendClass("okf-feed-card__footer", options.footerClass),
    });
    return { card, meta, context, body, footer };
  }

  private renderServiceSettingsAction(container: HTMLElement, error: unknown): void {
    if (!(error instanceof Error) || !error.message.includes("工作区本地服务缺少 Python 或部署配置路径")) return;
    const settings = container.createEl("button", {
      text: "配置本地服务",
      attr: { type: "button" },
    });
    settings.addEventListener("click", () => this.plugin.openPluginSettings());
  }

  private renderDailyFeeds(parent: HTMLElement): void {
    const reading = this.dashboardSection(
      parent,
      "每日更新",
      "滚动浏览中国热点、AI 资讯和树洞热榜的本期全部条目；打开本期汇总可阅读全文并选择用途。",
      "okf-dashboard__reading",
    );
    const alert = reading.createDiv({ cls: "okf-dashboard__inline-alert is-hidden" });
    const shelf = reading.createDiv({ cls: "okf-feed-shelf okf-feed-shelf--daily" });
    const definitions: readonly {
      id: DashboardFeed;
      kind: FeedKind;
      title: string;
      section?: AiDailyStream;
      modifier: string;
    }[] = [
      {
        id: "ai-daily-hotspot",
        kind: "ai-daily",
        title: "中国热点",
        section: "hotspot",
        modifier: "hotspot",
      },
      {
        id: "ai-daily-news",
        kind: "ai-daily",
        title: "AI 资讯",
        section: "news",
        modifier: "news",
      },
      {
        id: "treehole",
        kind: "treehole",
        title: "树洞热榜",
        modifier: "treehole",
      },
    ];
    const surfaces = definitions.map((definition) => {
      const surface = this.createFeedCardSurface(shelf, {
        title: definition.title,
        meta: "正在读取最新一期…",
        cardClass: `okf-feed-card--scrollable okf-feed-project okf-feed-project--${definition.modifier}`,
        headerClass: "okf-feed-project__header",
        bodyClass: "okf-feed-project__scroll okf-feed-project__preview",
        footerClass: "okf-feed-project__footer",
      });
      surface.body.createDiv({ cls: "okf-dashboard__muted", text: `正在读取${definition.title}…` });
      const restoreScroll = this.attachFeedScroll(definition.id, surface.body);
      return { ...definition, ...surface, restoreScroll };
    });
    let rendered: FeedDashboardDigest | undefined;
    const renderDigest = (digest: FeedDashboardDigest): void => {
      if (!shelf.isConnected) return;
      rendered = digest;
      for (const surface of surfaces) {
        surface.context.empty();
        const health = surface.section ? digest.stream_health?.[surface.section] : undefined;
        if (health && (health.status === "error" || health.status === "degraded")) {
          surface.context.createDiv({ cls: "okf-dashboard__error", text: `更新异常，当前内容可能不是最新：${health.message ?? "上游更新尚未成功"}${health.last_success_at ? ` · 上次成功 ${formatFeedDate(health.last_success_at)}` : ""}` });
        }
        const edition = surface.kind === "treehole"
          ? digest.treehole ?? undefined
          : latestAiDailyEdition(digest, surface.section!);
        surface.body.empty();
        surface.footer.empty();
        if (!edition) {
          surface.meta.setText("当前没有可读内容");
          surface.body.createDiv({
            cls: "okf-dashboard__empty",
            text: `暂时没有${surface.title}内容。`,
          });
          surface.restoreScroll(undefined);
          continue;
        }
        surface.meta.setText(`${formatFeedDate(edition.issued_at)} · ${edition.item_count} 条`);
        this.renderFeedDigestEdition(surface.body, surface.kind, edition, {
          heading: false,
          mode: "compact",
        });
        const openDigest = surface.footer.createEl("button", {
          text: "打开本期汇总",
          cls: "okf-dashboard__ghost-action okf-feed-project__digest-action",
        });
        openDigest.addEventListener("click", () => {
          this.openFeedDigest(openDigest, surface.kind, edition.digest_id);
        });
        surface.restoreScroll(edition.digest_id);
      }
    };
    const cached = this.plugin.feedDashboardDigestSnapshot();
    if (cached) renderDigest(cached);
    void this.plugin.loadFeedDashboardDigest()
      .then((digest) => {
        if (digest !== rendered) renderDigest(digest);
      })
      .catch((error: unknown) => {
        if (!shelf.isConnected) return;
        const message = error instanceof Error ? error.message : "订阅摘要暂时无法读取";
        alert.removeClass("is-hidden");
        alert.addClass("okf-dashboard__error");
        alert.setText(`${rendered ? "刷新失败，保留上次内容" : "暂时无法读取"}：${message}`);
        const retry = alert.createEl("button", {
          text: "重新读取",
          cls: "okf-dashboard__secondary-action",
          attr: { type: "button" },
        });
        retry.addEventListener("click", () => {
          reading.remove();
          this.renderDailyFeeds(parent);
        });
        this.renderServiceSettingsAction(alert, error);
        for (const surface of surfaces) {
          surface.context.empty();
          if (!rendered) {
            surface.meta.setText("暂时无法读取");
            surface.body.empty();
          }
        }
      });
  }

  private renderReadingPapers(parent: HTMLElement): void {
    const shelf = parent.createEl("section", {
      cls: "okf-feed-shelf okf-reading-papers",
      attr: { "aria-label": "AI 论文周刊" },
    });
    const surface = this.createFeedCardSurface(shelf, {
      title: "AI 论文周刊",
      meta: "正在读取最新一期…",
      cardClass: "okf-feed-card--scrollable okf-feed-project okf-feed-project--papers",
      headerClass: "okf-feed-project__header",
      bodyClass: "okf-feed-project__scroll okf-feed-project__preview",
      footerClass: "okf-feed-project__footer",
    });
    const restoreScroll = this.attachFeedScroll("ai-daily-papers", surface.body);
    let renderedEditionId: string | undefined;
    const renderEdition = (edition: FeedDigestEdition | null | undefined): void => {
      if (!shelf.isConnected) return;
      surface.body.empty();
      surface.footer.empty();
      renderedEditionId = edition?.digest_id;
      if (!edition) {
        surface.meta.setText("当前没有可读内容");
        surface.body.createDiv({
          cls: "okf-dashboard__empty",
          text: "暂时没有 AI Papers 周刊，远端发布新一期后会自动显示。",
        });
        restoreScroll(undefined);
        return;
      }
      surface.meta.setText(`${formatFeedDate(edition.issued_at)} · ${edition.item_count} 篇`);
      this.renderFeedDigestEdition(surface.body, "ai-daily", edition, {
        heading: false,
        mode: "compact",
      });
      const openDigest = surface.footer.createEl("button", {
        text: "打开本期汇总",
        cls: "okf-dashboard__ghost-action okf-feed-project__digest-action",
      });
      openDigest.addEventListener("click", () => {
        this.openFeedDigest(openDigest, "ai-daily", edition.digest_id);
      });
      restoreScroll(edition.digest_id);
    };
    const snapshot = typeof this.plugin.feedDashboardDigestSnapshot === "function"
      ? this.plugin.feedDashboardDigestSnapshot()
      : undefined;
    renderEdition(snapshot?.ai_papers);
    const renderHealth = (digest: FeedDashboardDigest | undefined): void => {
      surface.context.empty();
      const health = digest?.stream_health?.papers;
      if (health && (health.status === "error" || health.status === "degraded")) {
        surface.context.createDiv({ cls: "okf-dashboard__error", text: `更新异常，当前内容可能不是最新：${health.message ?? "AI Papers 上游更新尚未成功"}` });
      }
    };
    renderHealth(snapshot);
    if (typeof this.plugin.loadFeedDashboardDigest !== "function") return;
    void this.plugin.loadFeedDashboardDigest()
      .then((digest) => {
        if (!shelf.isConnected) return;
        renderHealth(digest);
        renderEdition(digest.ai_papers);
      })
      .catch((error: unknown) => {
        if (!shelf.isConnected) return;
        surface.context.empty();
        surface.context.createDiv({
          cls: "okf-dashboard__error",
          text: `${renderedEditionId ? "刷新失败，保留上次内容" : "暂时无法读取"}：${error instanceof Error ? error.message : "AI Papers 暂时无法读取"}`,
        });
        const retry = surface.context.createEl("button", { text: "重新读取", attr: { type: "button" } });
        retry.addEventListener("click", () => { shelf.remove(); this.renderReadingPapers(parent); });
        this.renderServiceSettingsAction(surface.context, error);
      });
  }

  private async renderReading(container: HTMLElement): Promise<void> {
    const actions = container.createDiv({
      cls: "okf-dashboard__hero-actions okf-reading-actions",
    });
    const add = actions.createEl("button", {
      text: "添加订阅",
      cls: "mod-cta okf-dashboard__primary-action",
      attr: { type: "button" },
    });
    add.addEventListener("click", () => this.plugin.promptAddFeedSubscription());
    const sync = actions.createEl("button", {
      text: "同步最新内容",
      cls: "okf-dashboard__secondary-action",
    });
    sync.addEventListener("click", () => {
      void this.runButtonAction(
        sync,
        () => this.syncFeedsAndRefresh(),
        false,
        "订阅内容已同步",
      );
    });

    if (this.selectedSubscriptionSource) {
      if (this.subscriptionSourcesNeedRefresh()) {
        try {
          await this.refreshSubscriptionSourceFirstPage();
          const refreshed = this.subscriptionSources.find((candidate) =>
            candidate.source_id === this.selectedSubscriptionSource?.source_id
          );
          if (refreshed) {
            this.selectedSubscriptionSource = {
              source_id: refreshed.source_id,
              source_name: refreshed.source_name,
            };
          }
        } catch (error) {
          if (!this.subscriptionSourcesLoaded) throw error;
        }
      }
      await this.renderReadingSourceDetail(container, this.selectedSubscriptionSource);
      return;
    }

    this.renderReadingPapers(container);

    let refreshWarning = "";
    if (this.subscriptionSourcesNeedRefresh()) {
      try {
        await this.refreshSubscriptionSourceFirstPage();
      } catch (error) {
        if (!this.subscriptionSourcesLoaded) throw error;
        refreshWarning = error instanceof Error ? error.message : "订阅内容刷新失败";
      }
    }
    if (refreshWarning) {
      container.createDiv({
        cls: "okf-dashboard__inline-alert",
        text: `最新内容暂时无法刷新，正在显示上次加载结果：${refreshWarning}`,
      });
    }
    if (!this.subscriptionSourceCatalogComplete) {
      container.createDiv({
        cls: "okf-dashboard__inline-alert",
        text: this.subscriptionSourceCatalogIndexing
          ? "正在整理历史订阅；当前来源会在索引完成后自动补全。"
          : "历史订阅索引尚未完成，系统正在自动重试。",
      });
    }

    if (
      this.subscriptionSourceTotal > SUBSCRIPTION_SOURCE_PAGE_SIZE ||
      Boolean(this.subscriptionSourceQuery)
    ) {
      const search = container.createDiv({ cls: "okf-reading-source-search" });
      const input = search.createEl("input", {
        attr: {
          type: "search",
          placeholder: "搜索订阅来源",
          "aria-label": "搜索订阅来源",
        },
      });
      input.value = this.subscriptionSourceQuery;
      const restore = this.readingSearchRestore;
      if (restore) {
        this.readingSearchRestore = undefined;
        input.focus({ preventScroll: true });
        input.setSelectionRange(restore.start, restore.end);
      }
      input.addEventListener("input", () => {
        if (this.readingSearchTimer !== undefined) window.clearTimeout(this.readingSearchTimer);
        const query = input.value.trim();
        this.readingSearchTimer = window.setTimeout(() => {
          this.readingSearchTimer = undefined;
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? start;
          this.changeSubscriptionSourceQuery(query, { start, end });
        }, 250);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (this.readingSearchTimer !== undefined) {
          window.clearTimeout(this.readingSearchTimer);
          this.readingSearchTimer = undefined;
        }
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        this.changeSubscriptionSourceQuery(input.value.trim(), { start, end });
      });
      const count = this.subscriptionSourceQuery
        ? `找到 ${this.subscriptionSourceMatched} 个来源`
        : `共 ${this.subscriptionSourceTotal} 个来源`;
      search.createSpan({ cls: "okf-dashboard__muted", text: count });
    }

    if (!this.subscriptionSources.length) {
      container.createDiv({
        cls: "okf-dashboard__empty okf-dashboard__empty--panel",
        text: this.subscriptionSourceQuery
          ? `没有找到与“${this.subscriptionSourceQuery}”匹配的订阅来源。`
          : "还没有订阅阅读内容。同步后，RSS、周刊与教程更新会显示在这里。",
      });
      return;
    }

    const grid = container.createEl("section", {
      cls: "okf-reading-source-grid",
      attr: { "aria-label": "订阅来源" },
    });
    for (const source of this.subscriptionSources) {
      this.renderSubscriptionSourceCard(grid, source);
    }

    const footer = container.createDiv({ cls: "okf-reading-source-footer" });
    if (this.subscriptionSourceHasMore && this.subscriptionSourceCursor) {
      const cursor = this.subscriptionSourceCursor;
      const query = this.subscriptionSourceQuery;
      const projectionVersion = this.plugin.feedProjectionVersion();
      const paginationGeneration = this.subscriptionSourcePaginationGeneration;
      const more = footer.createEl("button", {
        text: "加载更多来源",
        cls: "okf-dashboard__secondary-action",
      });
      more.addEventListener("click", () => {
        void this.runButtonAction(more, async () => {
          const page = await this.plugin.loadFeedSubscriptionSources({
            limit: SUBSCRIPTION_SOURCE_PAGE_SIZE,
            cursor,
            ...(query ? { query } : {}),
          });
          if (
            query !== this.subscriptionSourceQuery ||
            projectionVersion !== this.plugin.feedProjectionVersion() ||
            paginationGeneration !== this.subscriptionSourcePaginationGeneration ||
            this.subscriptionSourceCursor !== cursor
          ) return;
          this.appendSubscriptionSourcePage(page);
          await this.render(true);
        });
      });
    } else {
      footer.createSpan({
        cls: "okf-dashboard__muted",
        text: !this.subscriptionSourceCatalogComplete
          ? "正在补全更多来源…"
          : this.subscriptionSourceQuery
            ? `已显示全部 ${this.subscriptionSourceMatched} 个匹配来源`
            : `已显示全部 ${this.subscriptionSourceTotal} 个来源`,
      });
    }
  }

  private renderSubscriptionSourceCard(parent: HTMLElement, source: FeedSubscriptionSource): void {
    const cardState = feedSubscriptionCardState(source);
    const hasLatest = feedSubscriptionHasLatest(source);
    const surface = this.createFeedCardSurface(parent, {
      title: source.source_name,
      meta: hasLatest
        ? [
            formatFeedDate(source.latest_issued_at),
            `本期 ${source.latest_item_count} 条`,
            `待判断 ${source.pending_decision_count}`,
            `历史 ${source.edition_count} 期`,
          ].join(" · ")
        : this.emptySubscriptionSourceMeta(source),
      cardClass: [
        "okf-feed-card--source",
        hasLatest ? "okf-feed-card--scrollable" : "okf-feed-card--empty",
        "okf-reading-source-card",
        `is-${cardState}`,
      ].join(" "),
      headerClass: "okf-reading-source-card__header",
      metaClass: "okf-reading-source-card__meta",
      contextClass: "okf-reading-source-card__sections",
      bodyClass: hasLatest
        ? "okf-feed-project__scroll okf-reading-source-card__preview"
        : "okf-reading-source-card__preview",
      footerClass: "okf-reading-source-card__footer",
      attributes: {
        "data-source-id": source.source_id,
        "data-subscription-status": cardState,
      },
    });
    if (
      source.registry_managed !== undefined || source.status !== undefined ||
      source.registry_status !== undefined
    ) {
      surface.context.createSpan({
        cls: `okf-feed-subscription-status is-${cardState}`,
        text: feedSubscriptionCardLabel(cardState),
      });
    }
    const sections = Object.entries(source.native_section_counts)
      .filter(([label, count]) => Boolean(label.trim()) && count > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"));
    if (sections.length) {
      for (const [label, count] of sections.slice(0, 3)) {
        surface.context.createSpan({ cls: "okf-dashboard__badge", text: `${label} ${count}` });
      }
      if (sections.length > 3) {
        surface.context.createSpan({
          cls: "okf-dashboard__badge",
          text: `其他 ${sections.length - 3} 类`,
        });
      }
    }
    if (!hasLatest) {
      const empty = surface.body.createDiv({ cls: "okf-reading-source-card__empty" });
      empty.createEl("strong", { text: feedSubscriptionCardLabel(cardState) });
      empty.createDiv({ text: this.emptySubscriptionSourceMessage(source, cardState) });
      if (cardState === "error") {
        empty.createDiv({
          cls: "okf-dashboard__inline-alert",
          text: feedSubscriptionFailureLabel(source.last_error_type),
        });
      }
      this.renderSubscriptionSettingsAction(surface.footer, source);
      return;
    }
    const edition: FeedDigestEdition = {
      digest_id: source.latest_digest_id,
      issued_at: source.latest_issued_at,
      title: source.source_name,
      section: "learning",
      quality: source.quality ?? null,
      quality_reason: source.quality_reason ?? null,
      item_count: source.latest_item_count,
      items: [],
    };
    let state = this.readingSourceItemsState(source);
    const restoreScroll = this.attachReadingSourceScroll(source.source_id, surface.body);
    const adoptCurrentState = (rehydrate: boolean): ReadingSourceItemsState | undefined => {
      if (!surface.card.isConnected || this.readingSourceItemsRequestsCancelled) return undefined;
      const current = this.readingSourceItems.get(source.source_id);
      if (current) {
        if (
          current.digestId !== source.latest_digest_id ||
          current.revision !== this.readingSourceRevision(source)
        ) return undefined;
        state = current;
        this.touchReadingSourceItems(source.source_id, current);
        return current;
      }
      if (!rehydrate) return undefined;
      state = this.readingSourceItemsState(source);
      return state;
    };
    const renderDetachedPreview = (): void => {
      if (!surface.card.isConnected || this.readingSourceItemsRequestsCancelled) return;
      surface.body.empty();
      this.renderFeedDigestEdition(surface.body, "ai-daily", {
        ...edition,
        items: source.preview_items,
      }, {
        heading: false,
        mode: "compact",
        suppressSourceMetadata: true,
      });
      restoreScroll(source.latest_digest_id);
    };
    const renderItems = (): void => {
      const current = adoptCurrentState(false);
      if (!current) {
        renderDetachedPreview();
        return;
      }
      surface.body.empty();
      this.renderFeedDigestEdition(surface.body, "ai-daily", {
        ...edition,
        item_count: current.itemCount,
        items: current.items,
      }, {
        heading: false,
        mode: "compact",
        suppressSourceMetadata: true,
      });
      if (current.status === "loading") {
        surface.body.createDiv({
          cls: "okf-dashboard__muted okf-reading-source-card__load-state",
          text: current.nextCursor ? "正在加载更多条目…" : "正在加载本期全部条目…",
        });
      } else if (current.status === "error") {
        const failure = surface.body.createDiv({
          cls: "okf-reading-source-card__load-state is-error",
        });
        failure.createSpan({ text: current.error ?? "本期条目暂时无法继续加载。" });
        const retry = failure.createEl("button", {
          text: "重试加载",
          cls: "okf-dashboard__ghost-action",
          attr: { type: "button" },
        });
        retry.addEventListener("click", () => {
          const retryState = adoptCurrentState(true);
          if (!retryState) return;
          const request = this.loadReadingSourceItemsPage(source, retryState);
          renderItems();
          void request.then(renderItems);
        });
      }
      restoreScroll(source.latest_digest_id);
    };
    surface.body.addEventListener("scroll", () => {
      const previous = state;
      const current = adoptCurrentState(true);
      if (!current) return;
      // Scrolling is an access for both caches. Rehydrating an evicted card
      // moves the same source to the recent end of both LRUs before loading.
      this.touchReadingSourceItems(source.source_id, current);
      if (current !== previous) renderItems();
      if (
        !this.readingSourceNearBottom(surface.body) ||
        current.status === "loading" ||
        !current.hasMore ||
        !this.canLoadReadingSourceItems()
      ) return;
      const request = this.loadReadingSourceItemsPage(source, current);
      renderItems();
      void request.then(renderItems);
    }, { passive: true });
    renderItems();
    // Capability negotiation keeps the same three-item overview compatible
    // with older Engine releases. A supported Engine fills the fixed-height
    // card lazily, without inflating the source overview response.
    if (this.canLoadReadingSourceItems() && state.status === "idle") {
      this.loadReadingSourceItemsPage(source, state);
      renderItems();
    }
    // A render can replace the card while its shared source request is still
    // running. Every new surface subscribes to that same single-flight so it
    // cannot remain stuck on the loading placeholder.
    const pending = state.request;
    if (pending) void pending.then(renderItems);
    const viewAll = surface.footer.createEl("button", {
      text: "查看该来源",
      cls: "okf-dashboard__ghost-action",
      attr: { type: "button" },
    });
    viewAll.addEventListener("click", () => this.openSubscriptionSource(source));
    this.renderSubscriptionSettingsAction(surface.footer, source);
  }

  private renderSubscriptionSettingsAction(
    footer: HTMLElement,
    source: FeedSubscriptionSource,
  ): void {
    if (
      source.registry_managed !== true && source.status !== "removed" &&
      source.registry_status !== "removed"
    ) return;
    const settings = footer.createEl("button", {
      text: "设置…",
      cls: "okf-dashboard__ghost-action",
      attr: { type: "button" },
    });
    settings.addEventListener("click", () => this.plugin.promptFeedSubscriptionSettings(source));
  }

  private emptySubscriptionSourceMeta(
    source: FeedSubscriptionSource,
  ): string {
    return [
      source.adapter ? feedSubscriptionAdapterLabel(source.adapter) : "",
      source.edition_count ? `历史 ${source.edition_count} 期` : "尚无历史",
    ].filter(Boolean).join(" · ");
  }

  private emptySubscriptionSourceMessage(
    source: FeedSubscriptionSource,
    state: FeedSubscriptionCardState,
  ): string {
    if (state === "disabled") return "恢复后才会继续抓取新内容；已有历史不会删除。";
    if (state === "error") return "最近一次更新失败，可在设置中重新检测、暂停或移除。";
    if (state === "removed") return "订阅设置已移除，已有历史内容仍然保留。";
    return source.canonical_url
      ? "来源卡已建立，后台首次更新完成后会自动出现内容。"
      : "正在等待这个来源的首次更新。";
  }

  private async renderReadingSourceDetail(
    container: HTMLElement,
    source: Pick<FeedSubscriptionSource, "source_id" | "source_name">,
  ): Promise<void> {
    let refreshWarning = "";
    if (this.subscriptionsNeedRefresh(source.source_id)) {
      try {
        await this.refreshSubscriptionFirstPage();
      } catch (error) {
        if (!this.subscriptionsLoaded) throw error;
        refreshWarning = error instanceof Error ? error.message : "订阅来源刷新失败";
      }
    }
    const detail = container.createEl("section", {
      cls: "okf-reading-source-detail",
      attr: { "data-source-id": source.source_id },
    });
    const header = detail.createDiv({ cls: "okf-reading-source-detail__header" });
    const back = header.createEl("button", {
      text: "← 返回全部来源",
      cls: "okf-dashboard__ghost-action",
      attr: { type: "button" },
    });
    back.addEventListener("click", () => this.closeSubscriptionSource());
    const copy = header.createDiv({ cls: "okf-reading-source-detail__copy" });
    copy.createEl("h3", { text: source.source_name });
    copy.createDiv({
      cls: "okf-dashboard__muted",
      text: this.subscriptionEditions.length
        ? `已加载 ${this.subscriptionEditions.length} 期`
        : "正在读取来源历史…",
    });
    const latest = this.subscriptionEditions[0];
    if (latest) {
      const openLatest = header.createEl("button", {
        text: "打开最新一期",
        cls: "okf-dashboard__secondary-action",
      });
      openLatest.addEventListener("click", () => {
        this.openFeedDigest(openLatest, "ai-daily", latest.digest_id);
      });
    }
    if (refreshWarning) {
      detail.createDiv({
        cls: "okf-dashboard__inline-alert",
        text: `最新内容暂时无法刷新，正在显示上次加载结果：${refreshWarning}`,
      });
    }
    if (!this.subscriptionCatalogComplete) {
      detail.createDiv({
        cls: "okf-dashboard__inline-alert",
        text: "正在整理这个来源的历史期次；页面会自动补全更早内容。",
      });
    }
    if (!this.subscriptionEditions.length) {
      detail.createDiv({ cls: "okf-dashboard__empty", text: "这个来源还没有可读内容。" });
      return;
    }
    const editions = detail.createDiv({ cls: "okf-reading-source-detail__editions" });
    for (const edition of this.subscriptionEditions) {
      this.renderFeedDigestEdition(editions, "ai-daily", edition, {
        heading: `${formatFeedDate(edition.issued_at)} · ${edition.item_count} 条`,
        mode: "full",
        suppressSourceMetadata: true,
      });
    }
    const total = this.subscriptionEditions.reduce((sum, edition) => sum + edition.item_count, 0);
    const footer = detail.createDiv({ cls: "okf-reading-source-detail__footer" });
    if (this.subscriptionHasMore && this.subscriptionCursor) {
      const cursor = this.subscriptionCursor;
      const sourceId = source.source_id;
      const projectionVersion = this.plugin.feedProjectionVersion();
      const paginationGeneration = this.subscriptionPaginationGeneration;
      const more = footer.createEl("button", {
        text: "加载更早内容",
        cls: "okf-dashboard__secondary-action",
      });
      more.addEventListener("click", () => {
        void this.runButtonAction(more, async () => {
          const page = await this.plugin.loadFeedSubscriptions({
            limit: SUBSCRIPTION_EDITION_PAGE_SIZE,
            cursor,
            source_id: sourceId,
          });
          if (
            this.selectedSubscriptionSource?.source_id !== sourceId ||
            projectionVersion !== this.plugin.feedProjectionVersion() ||
            paginationGeneration !== this.subscriptionPaginationGeneration ||
            this.subscriptionCursor !== cursor
          ) return;
          this.appendSubscriptionPage(page);
          await this.render(true);
        });
      });
    } else {
      footer.createSpan({
        cls: "okf-dashboard__muted",
        text: this.subscriptionCatalogComplete
          ? `已显示全部 ${total} 条`
          : "正在补全更早期次…",
      });
    }
  }

  private openSubscriptionSource(source: FeedSubscriptionSource): void {
    this.readingOverviewScroll = this.contentEl.scrollTop;
    this.selectedSubscriptionSource = {
      source_id: source.source_id,
      source_name: source.source_name,
    };
    this.resetSubscriptionDetail(source.source_id);
    this.pageScroll.set("reading", 0);
    this.plugin.updateDashboardPageUiState("reading", { scrollTop: 0 });
    void this.render();
  }

  private closeSubscriptionSource(): void {
    this.selectedSubscriptionSource = undefined;
    this.pageScroll.set("reading", this.readingOverviewScroll);
    this.plugin.updateDashboardPageUiState("reading", { scrollTop: this.readingOverviewScroll });
    void this.render();
  }

  private changeSubscriptionSourceQuery(
    query: string,
    restore?: { start: number; end: number },
  ): void {
    const queryChanged = query !== this.subscriptionSourceQuery;
    const retryingUnloadedQuery = !queryChanged && this.subscriptionSourceLoadedQuery !== query;
    if (!queryChanged && !retryingUnloadedQuery) return;
    this.readingSearchRestore = restore;
    if (queryChanged) {
      this.subscriptionSourceQuery = query;
      this.readingOverviewScroll = 0;
      this.pageScroll.set("reading", 0);
      this.plugin.updateDashboardPageUiState("reading", {
        scrollTop: 0,
        filters: { query: query || null },
      });
    }
    const requestedQuery = query;
    const originatingRenderVersion = this.renderVersion;
    void this.refreshSubscriptionSourceFirstPage()
      .then((committed) => {
        if (
          !committed ||
          this.section !== "reading" ||
          this.subscriptionSourceQuery !== requestedQuery ||
          this.renderVersion !== originatingRenderVersion
        ) return;
        return this.render();
      })
      .catch((error: unknown) => {
        if (this.subscriptionSourceQuery !== requestedQuery) return;
        // The existing input stays mounted and focused on failure. Clear only
        // the deferred post-render focus request; pressing Enter captures a
        // fresh selection and retries the same unloaded query.
        this.readingSearchRestore = undefined;
        const message = error instanceof Error ? error.message : "无法搜索订阅来源";
        new Notice(`${message}；可按 Enter 重试`, 10_000);
      });
  }

  private async refreshSubscriptionSourceFirstPage(): Promise<boolean> {
    const projectionVersion = this.plugin.feedProjectionVersion();
    const query = this.subscriptionSourceQuery;
    const inFlight = this.subscriptionSourceFirstPageRequest;
    if (inFlight?.projectionVersion === projectionVersion && inFlight.query === query) {
      return inFlight.promise;
    }
    const generation = ++this.subscriptionSourceRequestGeneration;
    const promise = this.loadAndCommitSubscriptionSourceFirstPage(
      projectionVersion,
      query,
      generation,
    ).catch((error: unknown) => {
      if (
        generation !== this.subscriptionSourceRequestGeneration ||
        projectionVersion !== this.plugin.feedProjectionVersion() ||
        query !== this.subscriptionSourceQuery
      ) return false;
      throw error;
    });
    this.subscriptionSourceFirstPageRequest = {
      projectionVersion,
      query,
      generation,
      promise,
    };
    try {
      return await promise;
    } finally {
      if (this.subscriptionSourceFirstPageRequest?.promise === promise) {
        this.subscriptionSourceFirstPageRequest = undefined;
      }
    }
  }

  private async loadAndCommitSubscriptionSourceFirstPage(
    projectionVersion: number,
    query: string,
    generation = ++this.subscriptionSourceRequestGeneration,
  ): Promise<boolean> {
    const page = await this.plugin.loadFeedSubscriptionSources({
      limit: SUBSCRIPTION_SOURCE_PAGE_SIZE,
      ...(query ? { query } : {}),
    });
    if (
      generation !== this.subscriptionSourceRequestGeneration ||
      projectionVersion !== this.plugin.feedProjectionVersion() ||
      query !== this.subscriptionSourceQuery
    ) return false;
    // A refreshed first page cannot prove that an older cursor still borders
    // the same source set: sources may have been added, removed, renamed, or
    // reordered beyond the visible page. Restarting the cursor chain avoids
    // silently retaining deleted cards or making new tail sources unreachable.
    this.subscriptionSources = mergeSubscriptionSources([], page.sources);
    this.setSubscriptionLatestItemsPagination(page.latest_items_pagination === true);
    this.subscriptionSourceCursor = page.next_cursor;
    this.subscriptionSourceHasMore = page.has_more;
    this.subscriptionSourcePagesLoaded = 1;
    this.subscriptionSourceTotal = page.total_sources;
    this.subscriptionSourceMatched = page.matched_sources;
    this.subscriptionSourceCatalogComplete = page.catalog_complete !== false;
    this.subscriptionSourceCatalogIndexing = page.catalog_indexing === true;
    this.subscriptionSourcesLoaded = true;
    this.subscriptionSourcesLoadedAt = Date.now();
    this.subscriptionSourceProjectionVersion = projectionVersion;
    this.subscriptionSourceLoadedQuery = query;
    this.subscriptionSourcePaginationGeneration += 1;
    if (!this.subscriptionSourceCatalogComplete) this.scheduleReadingCatalogRetry();
    return true;
  }

  private appendSubscriptionSourcePage(page: FeedSubscriptionSourcePage): void {
    this.subscriptionSources = mergeSubscriptionSources(this.subscriptionSources, page.sources);
    this.subscriptionSourceCursor = page.next_cursor;
    this.subscriptionSourceHasMore = page.has_more;
    this.subscriptionSourceTotal = page.total_sources;
    this.subscriptionSourceMatched = page.matched_sources;
    this.subscriptionSourceCatalogComplete = page.catalog_complete !== false;
    this.subscriptionSourceCatalogIndexing = page.catalog_indexing === true;
    this.subscriptionSourcePagesLoaded += 1;
  }

  private subscriptionSourcesNeedRefresh(now = Date.now()): boolean {
    return !this.subscriptionSourcesLoaded ||
      this.subscriptionSourceLoadedQuery !== this.subscriptionSourceQuery ||
      this.subscriptionSourceProjectionVersion !== this.plugin.feedProjectionVersion() ||
      now - this.subscriptionSourcesLoadedAt >= SUBSCRIPTION_FIRST_PAGE_TTL_MS;
  }

  private scheduleReadingCatalogRetry(): void {
    if (this.readingCatalogRetryTimer !== undefined) return;
    this.readingCatalogRetryTimer = window.setTimeout(() => {
      this.readingCatalogRetryTimer = undefined;
      if (this.section !== "reading") return;
      const detail = this.selectedSubscriptionSource !== undefined;
      const incomplete = detail
        ? !this.subscriptionCatalogComplete
        : !this.subscriptionSourceCatalogComplete;
      if (!incomplete) return;
      const focused = this.contentEl.ownerDocument?.activeElement;
      const editing = focused instanceof HTMLElement &&
        this.contentEl.contains(focused) &&
        (focused.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName));
      if (editing) {
        this.scheduleReadingCatalogRetry();
        return;
      }
      if (detail) this.subscriptionLoadedAt = 0;
      else this.subscriptionSourcesLoadedAt = 0;
      void this.render(true);
    }, 1_500);
  }

  private async refreshSubscriptionFirstPage(): Promise<boolean> {
    const projectionVersion = this.plugin.feedProjectionVersion();
    const sourceId = this.selectedSubscriptionSource?.source_id ?? "";
    const inFlight = this.subscriptionFirstPageRequest;
    if (inFlight?.projectionVersion === projectionVersion && inFlight.sourceId === sourceId) {
      return inFlight.promise;
    }
    const generation = ++this.subscriptionRequestGeneration;
    const promise = this.loadAndCommitSubscriptionFirstPage(
      projectionVersion,
      sourceId,
      generation,
    ).catch((error: unknown) => {
      if (
        generation !== this.subscriptionRequestGeneration ||
        projectionVersion !== this.plugin.feedProjectionVersion() ||
        sourceId !== (this.selectedSubscriptionSource?.source_id ?? "")
      ) return false;
      throw error;
    });
    this.subscriptionFirstPageRequest = {
      projectionVersion,
      sourceId,
      generation,
      promise,
    };
    try {
      return await promise;
    } finally {
      if (this.subscriptionFirstPageRequest?.promise === promise) {
        this.subscriptionFirstPageRequest = undefined;
      }
    }
  }

  private async loadAndCommitSubscriptionFirstPage(
    projectionVersion: number,
    sourceId = this.selectedSubscriptionSource?.source_id ?? "",
    generation = ++this.subscriptionRequestGeneration,
  ): Promise<boolean> {
    const page = await this.plugin.loadFeedSubscriptions({
      limit: SUBSCRIPTION_EDITION_PAGE_SIZE,
      ...(sourceId ? { source_id: sourceId } : {}),
    });
    if (
      generation !== this.subscriptionRequestGeneration ||
      projectionVersion !== this.plugin.feedProjectionVersion() ||
      sourceId !== (this.selectedSubscriptionSource?.source_id ?? "") ||
      (page.source_id !== undefined && page.source_id !== null && page.source_id !== sourceId)
    ) return false;
    const loadedDigestIds = new Set(this.subscriptionEditions.map((edition) => edition.digest_id));
    const firstPageOverlapsHistory = page.editions.some((edition) =>
      loadedDigestIds.has(edition.digest_id)
    );
    // The deepest cursor is only safe when the refreshed first page still joins
    // the already loaded history. If several new editions create a gap, restart
    // pagination from the new first page so no intermediate edition is skipped.
    const preserveLoadedHistory = this.subscriptionPagesLoaded > 1 && firstPageOverlapsHistory;
    const totalChanged = page.total_editions !== undefined && page.total_editions !== null &&
      this.subscriptionTotalEditions !== null &&
      page.total_editions !== this.subscriptionTotalEditions;
    const preserveContinuousHistory = preserveLoadedHistory && !totalChanged;
    this.subscriptionEditions = preserveContinuousHistory
      ? mergeSubscriptionEditions(page.editions, this.subscriptionEditions)
      : mergeSubscriptionEditions([], page.editions);
    if (!preserveContinuousHistory) {
      this.subscriptionCursor = page.next_cursor;
      this.subscriptionHasMore = page.has_more;
      this.subscriptionPagesLoaded = 1;
    }
    if (page.total_editions !== undefined && page.total_editions !== null) {
      this.subscriptionTotalEditions = page.total_editions;
    }
    this.subscriptionCatalogComplete = page.catalog_complete !== false;
    this.subscriptionsLoaded = true;
    this.subscriptionLoadedAt = Date.now();
    this.subscriptionProjectionVersion = projectionVersion;
    this.subscriptionDetailSourceId = sourceId;
    this.subscriptionPaginationGeneration += 1;
    if (!this.subscriptionCatalogComplete) this.scheduleReadingCatalogRetry();
    return true;
  }

  private async syncFeedsAndRefresh(): Promise<void> {
    const results = await this.plugin.syncFeedsNow();
    if (this.section === "reading") {
      await this.refreshSubscriptionSourceFirstPage();
      if (this.selectedSubscriptionSource) await this.refreshSubscriptionFirstPage();
    }
    await this.render(true);
    const failure = feedSyncFailureMessage(results);
    if (failure) throw new Error(failure);
  }

  private appendSubscriptionPage(page: FeedSubscriptionPage): void {
    this.subscriptionEditions = mergeSubscriptionEditions(this.subscriptionEditions, page.editions);
    this.subscriptionCursor = page.next_cursor;
    this.subscriptionHasMore = page.has_more;
    if (page.total_editions !== undefined && page.total_editions !== null) {
      this.subscriptionTotalEditions = page.total_editions;
    }
    this.subscriptionCatalogComplete = page.catalog_complete !== false;
    this.subscriptionPagesLoaded += 1;
  }

  private subscriptionsNeedRefresh(sourceId: string, now = Date.now()): boolean {
    return !this.subscriptionsLoaded ||
      this.subscriptionDetailSourceId !== sourceId ||
      this.subscriptionProjectionVersion !== this.plugin.feedProjectionVersion() ||
      now - this.subscriptionLoadedAt >= SUBSCRIPTION_FIRST_PAGE_TTL_MS;
  }

  private resetSubscriptionDetail(sourceId: string): void {
    this.subscriptionRequestGeneration += 1;
    this.subscriptionPaginationGeneration += 1;
    this.subscriptionFirstPageRequest = undefined;
    this.subscriptionEditions = [];
    this.subscriptionCursor = null;
    this.subscriptionHasMore = false;
    this.subscriptionTotalEditions = null;
    this.subscriptionCatalogComplete = true;
    this.subscriptionsLoaded = false;
    this.subscriptionPagesLoaded = 0;
    this.subscriptionLoadedAt = 0;
    this.subscriptionProjectionVersion = -1;
    this.subscriptionDetailSourceId = sourceId;
  }

  private readingSourceItemsState(source: FeedSubscriptionSource): ReadingSourceItemsState {
    if (!feedSubscriptionHasLatest(source)) {
      throw new Error("Reading source items require a published latest edition");
    }
    const current = this.readingSourceItems.get(source.source_id);
    const revision = this.readingSourceRevision(source);
    if (
      current &&
      current.digestId === source.latest_digest_id &&
      current.revision === revision
    ) {
      current.itemCount = source.latest_item_count;
      current.previewItems = this.mergeReadingSourceItems([], source.preview_items);
      current.items = this.mergeReadingSourceItems(current.items, source.preview_items);
      this.touchReadingSourceItems(source.source_id, current);
      return current;
    }
    const items = this.mergeReadingSourceItems([], source.preview_items);
    const complete = items.length >= source.latest_item_count;
    const state: ReadingSourceItemsState = {
      digestId: source.latest_digest_id,
      revision,
      itemCount: source.latest_item_count,
      previewItems: items,
      items,
      nextCursor: null,
      hasMore: !complete,
      status: complete ? "ready" : "idle",
      staleCursorRetried: false,
    };
    this.readingSourceItems.set(source.source_id, state);
    this.touchReadingSourceItems(source.source_id, state);
    return state;
  }

  private readingSourceRevision(
    source: Pick<FeedSubscriptionSource, "latest_digest_id" | "latest_item_count" | "latest_revision">,
  ): string {
    return source.latest_revision ??
      `legacy:${source.latest_digest_id}:${source.latest_item_count}`;
  }

  private touchReadingSourceItems(sourceId: string, state: ReadingSourceItemsState): void {
    if (this.readingSourceItems.get(sourceId) !== state) return;
    this.readingSourceItems.delete(sourceId);
    this.readingSourceItems.set(sourceId, state);
    while (this.readingSourceItems.size > READING_SOURCE_CACHE_LIMIT) {
      const oldest = this.readingSourceItems.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.readingSourceItems.get(oldest);
      this.readingSourceItems.delete(oldest);
      if (evicted) this.cancelQueuedReadingSourceItemsState(oldest, evicted);
    }
  }

  private cancelQueuedReadingSourceItemsState(
    sourceId: string,
    state: ReadingSourceItemsState,
  ): void {
    for (let index = this.readingSourceItemsRequestQueue.length - 1; index >= 0; index -= 1) {
      const queued = this.readingSourceItemsRequestQueue[index];
      if (queued?.sourceId !== sourceId || queued.state !== state) continue;
      this.readingSourceItemsRequestQueue.splice(index, 1);
      queued.reject(new ReadingSourceItemsUnavailableError());
    }
  }

  private mergeReadingSourceItems(
    current: readonly FeedDigestItem[],
    incoming: readonly FeedDigestItem[],
  ): FeedDigestItem[] {
    const replacements = new Map(incoming.map((item) => [item.item_id, item]));
    const merged = current.map((item) => replacements.get(item.item_id) ?? item);
    const seen = new Set(merged.map((item) => item.item_id));
    for (const item of incoming) {
      if (seen.has(item.item_id)) continue;
      seen.add(item.item_id);
      merged.push(item);
    }
    return merged;
  }

  private loadReadingSourceItemsPage(
    source: FeedSubscriptionSource,
    state: ReadingSourceItemsState,
  ): Promise<boolean> {
    if (this.readingSourceItems.get(source.source_id) !== state) {
      return Promise.resolve(false);
    }
    if (!this.canLoadReadingSourceItems()) return Promise.resolve(false);
    if (state.request) return state.request;
    if (state.status === "ready" && !state.hasMore) return Promise.resolve(false);
    this.touchReadingSourceItems(source.source_id, state);
    state.status = "loading";
    delete state.error;
    const request = this.performReadingSourceItemsLoad(source, state, state.nextCursor);
    state.request = request;
    void request.then(() => {
      if (state.request === request) delete state.request;
    });
    return request;
  }

  private async performReadingSourceItemsLoad(
    source: FeedSubscriptionSource,
    state: ReadingSourceItemsState,
    initialCursor: string | null,
  ): Promise<boolean> {
    let cursor = initialCursor;
    while (true) {
      let page: FeedSubscriptionSourceItemsPage;
      try {
        page = await this.enqueueReadingSourceItemsRequest(source, state, cursor);
      } catch (error) {
        if (this.readingSourceItems.get(source.source_id) !== state) return false;
        if (
          error instanceof FeedHttpError && error.status === 400 && cursor &&
          !state.staleCursorRetried
        ) {
          state.staleCursorRetried = true;
          state.items = this.mergeReadingSourceItems([], state.previewItems);
          state.nextCursor = null;
          state.hasMore = state.items.length < state.itemCount;
          state.status = "loading";
          delete state.error;
          this.resetReadingSourceScroll(source.source_id, state.digestId);
          cursor = null;
          continue;
        }
        if (
          error instanceof ReadingSourceItemsUnavailableError ||
          (error instanceof FeedHttpError && error.status === 404)
        ) {
          state.nextCursor = null;
          state.hasMore = false;
          state.status = "ready";
          delete state.error;
          return true;
        }
        state.status = "error";
        state.error = error instanceof Error ? error.message : "本期条目暂时无法继续加载。";
        return true;
      }
      if (
        this.readingSourceItems.get(source.source_id) !== state ||
        !this.canLoadReadingSourceItems() ||
        state.revision !== this.readingSourceRevision(source)
      ) return false;
      const pageRevision = page.latest_revision ?? (
        source.latest_revision === undefined
          ? `legacy:${page.digest_id}:${page.item_count}`
          : undefined
      );
      if (
        page.source_id !== source.source_id ||
        page.digest_id !== state.digestId ||
        pageRevision !== state.revision
      ) {
        state.status = "error";
        state.error = "来源已更新；正在刷新订阅阅读 以显示新一期。";
        this.markSubscriptionSourceOverviewStale();
        return true;
      }
      if (page.item_count !== state.itemCount) {
        state.status = "error";
        state.error = "来源条目已更新；正在刷新订阅阅读 以显示最新内容。";
        this.markSubscriptionSourceOverviewStale();
        return true;
      }
      if (page.has_more && (!page.next_cursor || page.next_cursor === cursor || !page.items.length)) {
        state.status = "error";
        state.error = "本期条目分页没有继续位置";
        return true;
      }
      if (!page.has_more && page.next_cursor) {
        state.status = "error";
        state.error = "本期条目分页返回了无效的继续位置";
        return true;
      }
      const merged = cursor
        ? this.mergeReadingSourceItems(state.items, page.items)
        : this.mergeReadingSourceItems([], page.items);
      if (!page.has_more && merged.length !== page.item_count) {
        state.status = "error";
        state.error = "本期条目数量与分页结果不一致";
        return true;
      }
      state.items = merged;
      state.nextCursor = page.next_cursor;
      state.hasMore = page.has_more;
      state.status = "ready";
      delete state.error;
      this.touchReadingSourceItems(source.source_id, state);
      return true;
    }
  }

  private enqueueReadingSourceItemsRequest(
    source: FeedSubscriptionSource,
    state: ReadingSourceItemsState,
    cursor: string | null,
  ): Promise<FeedSubscriptionSourceItemsPage> {
    const loadItems = this.plugin.loadFeedSubscriptionSourceItems;
    if (!this.canLoadReadingSourceItems() || typeof loadItems !== "function") {
      return Promise.reject(new ReadingSourceItemsUnavailableError());
    }
    const generation = this.readingSourceItemsRequestGeneration;
    return new Promise((resolve, reject) => {
      this.readingSourceItemsRequestQueue.push({
        generation,
        sourceId: source.source_id,
        state,
        run: () => {
          if (
            generation !== this.readingSourceItemsRequestGeneration ||
            this.readingSourceItems.get(source.source_id) !== state ||
            !this.canLoadReadingSourceItems()
          ) return Promise.reject(new ReadingSourceItemsUnavailableError());
          return loadItems.call(this.plugin, source.source_id, {
            limit: READING_SOURCE_ITEMS_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          });
        },
        resolve,
        reject,
      });
      this.pumpReadingSourceItemsRequests();
    });
  }

  private pumpReadingSourceItemsRequests(): void {
    const concurrency = this.readingSourceItemsEndpointConfirmed
      ? READING_SOURCE_REQUEST_CONCURRENCY
      : 1;
    while (
      this.readingSourceItemsActiveRequests < concurrency &&
      this.readingSourceItemsRequestQueue.length
    ) {
      const queued = this.readingSourceItemsRequestQueue.shift();
      if (!queued) break;
      if (
        queued.generation !== this.readingSourceItemsRequestGeneration ||
        !this.canLoadReadingSourceItems()
      ) {
        queued.reject(new ReadingSourceItemsUnavailableError());
        continue;
      }
      this.readingSourceItemsActiveRequests += 1;
      let request: Promise<FeedSubscriptionSourceItemsPage>;
      try {
        request = queued.run();
      } catch (error) {
        request = Promise.reject(error);
      }
      void request.then((page) => {
        if (
          queued.generation !== this.readingSourceItemsRequestGeneration ||
          !this.canLoadReadingSourceItems()
        ) {
          queued.reject(new ReadingSourceItemsUnavailableError());
          return;
        }
        this.readingSourceItemsEndpointConfirmed = true;
        queued.resolve(page);
      }, (error: unknown) => {
        if (
          queued.generation === this.readingSourceItemsRequestGeneration &&
          !this.readingSourceItemsRequestsCancelled
        ) {
          if (error instanceof FeedHttpError && error.status === 404) {
            this.disableReadingSourceItemsEndpoint();
          } else if (error instanceof FeedHttpError) {
            // Any routed HTTP response other than 404 proves that the endpoint
            // exists. Do not let one oversized or invalid source serialize all
            // of the independent cards behind the compatibility probe.
            this.readingSourceItemsEndpointConfirmed = true;
          }
        }
        queued.reject(error);
      }).finally(() => {
        this.readingSourceItemsActiveRequests -= 1;
        this.pumpReadingSourceItemsRequests();
      });
    }
  }

  private canLoadReadingSourceItems(): boolean {
    return this.subscriptionLatestItemsPagination &&
      !this.readingSourceItemsEndpointDisabled &&
      !this.readingSourceItemsRequestsCancelled &&
      typeof this.plugin.loadFeedSubscriptionSourceItems === "function";
  }

  private cancelReadingSourceItemRequests(): void {
    this.readingSourceItemsRequestsCancelled = true;
    this.readingSourceItemsRequestGeneration += 1;
    const unavailable = new ReadingSourceItemsUnavailableError();
    while (this.readingSourceItemsRequestQueue.length) {
      this.readingSourceItemsRequestQueue.shift()?.reject(unavailable);
    }
    this.readingSourceItems.clear();
  }

  private setSubscriptionLatestItemsPagination(enabled: boolean): void {
    const next = enabled && !this.readingSourceItemsEndpointDisabled;
    if (this.subscriptionLatestItemsPagination === next) return;
    this.subscriptionLatestItemsPagination = next;
    this.readingSourceItemsRequestGeneration += 1;
    if (!next) this.readingSourceItemsEndpointConfirmed = false;
    const unavailable = new ReadingSourceItemsUnavailableError();
    while (this.readingSourceItemsRequestQueue.length) {
      this.readingSourceItemsRequestQueue.shift()?.reject(unavailable);
    }
    for (const state of this.readingSourceItems.values()) {
      state.nextCursor = null;
      state.hasMore = next ? state.items.length < state.itemCount : false;
      state.status = next && state.hasMore ? "idle" : "ready";
      state.staleCursorRetried = false;
      delete state.error;
    }
    if (next) this.pumpReadingSourceItemsRequests();
  }

  private disableReadingSourceItemsEndpoint(): void {
    if (this.readingSourceItemsEndpointDisabled) return;
    this.readingSourceItemsEndpointDisabled = true;
    this.setSubscriptionLatestItemsPagination(false);
    this.markSubscriptionSourceOverviewStale();
  }

  private markSubscriptionSourceOverviewStale(): void {
    this.subscriptionSourcesLoadedAt = 0;
    if (this.section === "reading") this.scheduleExternalRefresh();
  }

  private resetReadingSourceScroll(sourceId: string, digestId: string): void {
    if (this.readingSourceScrollDigest.get(sourceId) !== digestId) return;
    this.readingSourceScroll.set(sourceId, 0);
    this.persistReadingSourceScroll(sourceId);
  }

  private readingSourceNearBottom(element: HTMLElement): boolean {
    return element.scrollHeight - element.scrollTop - element.clientHeight <=
      READING_SOURCE_LOAD_THRESHOLD_PX;
  }

  private attachFeedScroll(
    feed: DashboardFeed,
    element: HTMLElement,
  ): (editionId: string | undefined) => void {
    element.dataset.feed = feed;
    const restore = (editionId: string | undefined): void => {
      if (editionId && this.feedScrollEdition[feed] !== editionId) {
        this.feedScrollEdition[feed] = editionId;
        this.feedScroll[feed] = 0;
        this.plugin.updateDashboardFeedUiState(feed, { scrollTop: 0, editionId });
      }
      element.scrollTop = this.feedScroll[feed] ?? 0;
    };
    element.addEventListener("scroll", () => {
      this.lastInteractionAt = Date.now();
      this.feedScroll[feed] = element.scrollTop;
      const pending = this.feedScrollPersistTimers[feed];
      if (pending !== undefined) window.clearTimeout(pending);
      this.feedScrollPersistTimers[feed] = window.setTimeout(() => {
        delete this.feedScrollPersistTimers[feed];
        this.plugin.updateDashboardFeedUiState(feed, {
          scrollTop: this.feedScroll[feed] ?? 0,
          editionId: this.feedScrollEdition[feed] ?? null,
        });
      }, 120);
    }, { passive: true });
    return restore;
  }

  private attachReadingSourceScroll(
    sourceId: string,
    element: HTMLElement,
  ): (digestId: string) => void {
    element.dataset.sourceId = sourceId;
    const restore = (digestId: string): void => {
      element.dataset.digestId = digestId;
      const previousDigest = this.readingSourceScrollDigest.get(sourceId);
      if (previousDigest !== digestId) {
        this.readingSourceScrollDigest.set(sourceId, digestId);
        this.readingSourceScroll.set(sourceId, 0);
        if (previousDigest !== undefined) this.persistReadingSourceScroll(sourceId);
      }
      this.touchReadingSourceScroll(sourceId, digestId);
      element.scrollTop = this.readingSourceScroll.get(sourceId) ?? 0;
    };
    element.addEventListener("scroll", () => {
      this.lastInteractionAt = Date.now();
      this.readingSourceScroll.set(sourceId, element.scrollTop);
      this.touchReadingSourceScroll(sourceId, element.dataset.digestId);
      const pending = this.readingSourceScrollPersistTimers.get(sourceId);
      if (pending !== undefined) window.clearTimeout(pending);
      this.readingSourceScrollPersistTimers.set(sourceId, window.setTimeout(() => {
        this.readingSourceScrollPersistTimers.delete(sourceId);
        this.persistReadingSourceScroll(sourceId);
      }, 120));
    }, { passive: true });
    return restore;
  }

  private touchReadingSourceScroll(sourceId: string, digestId?: string): void {
    const currentDigest = digestId ?? this.readingSourceScrollDigest.get(sourceId);
    if (!currentDigest) return;
    const scrollTop = this.readingSourceScroll.get(sourceId) ?? 0;
    this.readingSourceScroll.delete(sourceId);
    this.readingSourceScrollDigest.delete(sourceId);
    this.readingSourceScroll.set(sourceId, scrollTop);
    this.readingSourceScrollDigest.set(sourceId, currentDigest);
    while (this.readingSourceScroll.size > READING_SOURCE_CACHE_LIMIT) {
      const oldest = this.readingSourceScroll.keys().next().value;
      if (oldest === undefined) break;
      const timer = this.readingSourceScrollPersistTimers.get(oldest);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        this.readingSourceScrollPersistTimers.delete(oldest);
        this.persistReadingSourceScroll(oldest);
      }
      this.readingSourceScroll.delete(oldest);
      this.readingSourceScrollDigest.delete(oldest);
    }
  }

  private persistReadingSourceScroll(sourceId: string): void {
    const digestId = this.readingSourceScrollDigest.get(sourceId);
    if (!digestId) return;
    this.plugin.updateDashboardReadingSourceUiState(sourceId, {
      digestId,
      scrollTop: this.readingSourceScroll.get(sourceId) ?? 0,
      updatedAt: new Date().toISOString(),
    });
  }

  private openFeedDigest(
    button: HTMLButtonElement,
    kind: FeedKind,
    digestId: string,
  ): void {
    if (button.disabled) return;
    button.disabled = true;
    void this.plugin.openFeedDigest(kind, digestId)
      .catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : "无法打开订阅本期汇总", 10_000);
      })
      .finally(() => {
        button.disabled = false;
      });
  }

  private renderFeedDigestEdition(
    parent: HTMLElement,
    kind: FeedKind,
    edition: FeedDigestEdition,
    options: {
      heading?: string | false;
      mode?: "compact" | "full";
      limit?: number;
      suppressSourceMetadata?: boolean;
    } = {},
  ): void {
    const mode = options.mode ?? "full";
    const section = parent.createEl("section", {
      cls: `okf-feed-digest__edition is-${mode}`,
    });
    const defaultHeading = kind === "ai-daily"
      ? edition.section === "papers"
        ? "AI 论文周刊"
        : edition.section
          ? aiDailyPreviewStreamTitle(edition.section)
          : "其他"
      : "本期条目";
    const heading = options.heading === undefined ? defaultHeading : options.heading;
    if (heading !== false) section.createEl("h4", { text: heading });
    if (edition.quality && edition.quality !== "ok") {
      section.createDiv({
        cls: "okf-dashboard__feed-warning",
        text: edition.quality_reason
          ? `采集不完整：${humanizeFeedQuality(edition.quality_reason)}`
          : "本期采集可能不完整。",
      });
    }
    const items = section.createDiv({ cls: "okf-feed-digest__items" });
    const visibleItems = options.limit === undefined
      ? edition.items
      : edition.items.slice(0, Math.max(0, options.limit));
    for (const [index, item] of visibleItems.entries()) {
      this.renderFeedDigestItem(
        items,
        kind,
        edition,
        item,
        index + 1,
        mode,
        options.suppressSourceMetadata ?? false,
      );
    }
  }

  private renderFeedDigestItem(
    parent: HTMLElement,
    kind: FeedKind,
    edition: FeedDigestEdition,
    item: FeedDigestItem,
    index: number,
    mode: "compact" | "full" = "full",
    suppressSourceMetadata = false,
  ): void {
    const card = parent.createEl("article", {
      cls: `okf-feed-digest__item is-${mode}`,
      attr: {
        role: "link",
        tabindex: "0",
        "data-feed-kind": kind,
        "aria-label": `阅读与判断：${item.title}`,
      },
    });
    const readingPosition = this.plugin.feedReadingPosition(kind);
    if (readingPosition?.editionId === edition.digest_id && readingPosition.itemId === item.item_id) {
      card.addClass("is-last-read");
      card.setAttr("aria-current", "true");
    }
    card.createEl("h5", {
      text: kind === "treehole" && item.pid ? `#${item.pid} · ${item.title}` : `${index}. ${item.title}`,
    });
    if (item.summary) card.createDiv({ cls: "okf-feed-digest__summary", text: item.summary });
    const metadata = kind === "treehole"
      ? treeholeMetadata(item)
      : aiDailyMetadata(item, suppressSourceMetadata);
    if (metadata) card.createDiv({ cls: "okf-dashboard__muted", text: metadata });
    const decision = feedDecisionLabel(
      this.plugin.feedDecisionSnapshot(kind, item.item_id)?.action ?? item.decision,
    );
    if (decision) card.createSpan({ cls: "okf-feed-digest__decision", text: decision });
    card.createSpan({ cls: "okf-feed-digest__open-label", text: "阅读与判断 →" });
    let opening = false;
    const open = (): void => {
      if (opening) return;
      opening = true;
      card.addClass("is-loading");
      card.setAttr("aria-disabled", "true");
      void this.plugin
        .openFeedItem(kind, edition.digest_id, item.block_id)
        .then(async () => {
          for (const previous of this.contentEl.querySelectorAll<HTMLElement>(
            `.okf-feed-digest__item[data-feed-kind="${kind}"].is-last-read`,
          )) {
            previous.removeClass("is-last-read");
            previous.removeAttribute("aria-current");
          }
          card.addClass("is-last-read");
          card.setAttr("aria-current", "true");
          await this.plugin.rememberFeedReadingPosition(kind, edition.digest_id, item.item_id);
        })
        .catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : "无法打开订阅条目", 10_000);
        })
        .finally(() => {
          opening = false;
          card.removeClass("is-loading");
          card.removeAttribute("aria-disabled");
        });
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  }

  private inboxWorkQueue(projection: InboxProjection): InboxWorkQueue {
    return buildInboxWorkQueue(
      projection,
      this.plugin.conversionSnapshot(),
    );
  }

  private async renderInbox(container: HTMLElement): Promise<void> {
    const projection = await this.vaultReader.inbox();
    const queue = this.inboxWorkQueue(projection);
    const openCapturePaths = new Set(projection.captures.map((note) => note.path));
    for (const path of this.selectedCaptures) {
      if (!openCapturePaths.has(path)) this.selectedCaptures.delete(path);
    }

    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const capture = actions.createEl("button", {
      text: "快速记录到待处理",
      cls: "mod-cta okf-dashboard__primary-action",
    });
    capture.addEventListener("click", () => this.plugin.promptCapture());
    const importDocument = actions.createEl("button", {
      text: "导入资料",
      cls: "okf-dashboard__secondary-action",
    });
    importDocument.addEventListener("click", () => this.plugin.openDocumentImport([], {}, "inbox"));
    this.renderDocumentDropZone(container, {}, "inbox");

    const stageTabs = container.createDiv({
      cls: "okf-dashboard__segments okf-dashboard__stage-tabs",
      attr: { role: "tablist", "aria-label": "待处理页面" },
    });
    const progressCount = queue.conversion.length;
    for (const option of [
      { value: "decision" as const, label: "待判断", count: queue.decision.length },
      { value: "progress" as const, label: "转换进度", count: progressCount },
    ]) {
      const selected = this.inboxTab === option.value;
      const button = stageTabs.createEl("button", {
        text: `${option.label} ${option.count}`,
        cls: selected ? "is-active" : "",
        attr: { type: "button", role: "tab", "aria-selected": String(selected) },
      });
      button.addEventListener("click", () => {
        this.selectedCaptures.clear();
        this.inboxTab = option.value;
        this.plugin.updateDashboardPageUiState("inbox", { tab: option.value });
        void this.render(true);
      });
    }

    const filters = container.createDiv({
      cls: "okf-dashboard__segments okf-dashboard__ingestion-filters",
      attr: { role: "tablist", "aria-label": "按进入渠道筛选待处理" },
    });
    const currentStageItems = this.inboxTab === "decision"
      ? queue.decision
      : queue.conversion;
    const options: { value: IngestedViaFilter; label: string; count: number }[] = [
      { value: "all", label: "全部", count: currentStageItems.length },
      ...INGESTED_VIA_ORDER.map((value) => ({
        value,
        label: INGESTED_VIA_LABELS[value],
        count: currentStageItems.filter((item) => item.ingested_via === value).length,
      })),
    ];
    const unlabeledCount = currentStageItems.filter((item) => item.ingested_via === "unlabeled").length;
    if (unlabeledCount) {
      options.push({
        value: "unlabeled",
        label: INGESTED_VIA_LABELS.unlabeled,
        count: unlabeledCount,
      });
    }
    for (const option of options) {
      const selected = option.value === this.inboxIngestedVia;
      const button = filters.createEl("button", {
        text: `${option.label} ${option.count}`,
        cls: selected ? "is-active" : "",
        attr: { type: "button", role: "tab", "aria-selected": String(selected) },
      });
      button.addEventListener("click", () => {
        this.selectedCaptures.clear();
        this.inboxIngestedVia = option.value;
        this.plugin.updateDashboardPageUiState("inbox", {
          filters: { ingestedVia: option.value },
        });
        void this.render(true);
      });
    }

    if (this.inboxTab === "decision") {
      const visible = filterInboxItems(queue.decision, this.inboxIngestedVia);
      let discardSelected: HTMLButtonElement | undefined;
      const updateSelection = (): void => {
        if (!discardSelected) return;
        discardSelected.setText(`移到回收站 (${this.selectedCaptures.size})`);
        discardSelected.toggleClass("is-hidden", !this.selectedCaptures.size);
      };
      if (visible.some((item) => item.note.note_type === "Capture")) {
        const toolbar = container.createDiv({ cls: "okf-dashboard__selection-toolbar" });
        discardSelected = toolbar.createEl("button", {
          text: "移到回收站 (0)",
          cls: "okf-dashboard__danger-action is-hidden",
        });
        discardSelected.addEventListener("click", () => {
          const paths = [...this.selectedCaptures];
          if (!paths.length || !discardSelected) return;
          void this.runButtonAction(discardSelected, async () => {
            const result = await this.api().batchCaptures("discard", paths);
            this.selectedCaptures.clear();
            new Notice(`已将 ${result.count} 条记录移到回收站`);
          }, true);
        });
      }
      this.renderInboxDecisionStage(container, visible, updateSelection);
      updateSelection();
    } else {
      const conversions = filterInboxItems(queue.conversion, this.inboxIngestedVia);
      if (!conversions.length) {
        container.createDiv({
          cls: "okf-dashboard__empty okf-dashboard__empty--panel",
          text: "当前没有文件转换进度。学习材料生成在学习查看，其他后台任务在右上角任务中心查看。",
        });
      }
      if (conversions.length) this.renderInboxConversionStage(container, conversions);
    }

  }

  private renderInboxDecisionStage(
    container: HTMLElement,
    items: DecisionWorkItem[],
    updateSelection: () => void,
  ): void {
    const section = this.dashboardSection(
      container,
      `待判断 ${items.length}`,
      "先完成你的判断；暂时不处理时直接离开，资料会继续留在这里。",
      "okf-inbox-stage",
    );
    if (!items.length) {
      section.createDiv({ cls: "okf-dashboard__empty", text: "当前筛选下没有待判断输入。" });
      return;
    }
    const cards = section.createDiv({ cls: "okf-dashboard__compact-list" });
    for (const item of items) {
      const card = cards.createDiv({ cls: "okf-dashboard__compact-row okf-dashboard__compact-row--stacked" });
      if (item.note.note_type === "Capture") {
        const checkbox = card.createEl("input", {
          attr: { type: "checkbox", "aria-label": `选择 ${item.note.title}` },
        });
        checkbox.checked = this.selectedCaptures.has(item.note.path);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) this.selectedCaptures.add(item.note.path);
          else this.selectedCaptures.delete(item.note.path);
          updateSelection();
        });
      }
      this.inboxNoteIdentity(card, item.note, item.ingested_via);
      this.collapsedExcerpt(card, item.note.excerpt);
      if (item.note.note_type === "Capture" && item.ingested_via === "web-clip") {
        this.webCaptureActions(card, item.note);
      } else if (item.note.note_type === "Capture") {
        this.inboxActions(card, item.note);
      } else {
        this.pendingSourceActions(card, item.note);
      }
    }
  }

  private renderInboxConversionStage(
    container: HTMLElement,
    items: ConversionWorkItem[],
  ): void {
    const section = this.dashboardSection(
      container,
      `待转换 ${items.length}`,
      "文件正在后台转换；失败后可在这里重试。",
      "okf-inbox-stage",
    );
    if (!items.length) {
      section.createDiv({ cls: "okf-dashboard__empty", text: "当前筛选下没有待转换文件。" });
      return;
    }
    const cards = section.createDiv({ cls: "okf-dashboard__cards" });
    for (const item of items) this.renderInboxConversionCard(cards, item.conversion);
  }

  private inboxNoteIdentity(
    card: HTMLElement,
    note: NoteSummary,
    channel: keyof typeof INGESTED_VIA_LABELS,
  ): void {
    const title = card.createEl("button", {
      text: note.title,
      cls: "okf-dashboard__row-title",
      attr: { type: "button" },
    });
    title.addEventListener("click", () => void this.openPath(note.path));
    const badges = card.createDiv({ cls: "okf-dashboard__badges" });
    this.ingestionBadge(badges, channel);
    const detail = [
      resourceHost(note.resource),
      note.kind?.toLocaleUpperCase(),
      relativeMoment(note.created_at ?? note.modified_at),
    ].filter(Boolean).join(" · ");
    if (detail) card.createDiv({ cls: "okf-dashboard__muted", text: detail });
  }

  private ingestionBadge(
    parent: HTMLElement,
    channel: keyof typeof INGESTED_VIA_LABELS,
    count?: number,
  ): void {
    parent.createSpan({
      cls: `okf-dashboard__badge okf-dashboard__badge--${channel}`,
      text: `${INGESTED_VIA_LABELS[channel]}${count === undefined ? "" : ` ${count}`}`,
    });
  }

  private webCaptureActions(parent: HTMLElement, note: NoteSummary): void {
    const actions = parent.createDiv({ cls: "okf-dashboard__actions okf-dashboard__decision-entry" });
    const status = actions.createDiv({ cls: "okf-dashboard__muted", text: "由你判断学习意愿和长期价值。" });
    const choices = actions.createDiv({ cls: "okf-dashboard__decision-choices" });
    const button = (
      label: string,
      handler: (button: HTMLButtonElement) => void,
      className = "",
    ): HTMLButtonElement => {
      const item = choices.createEl("button", {
        text: label,
        cls: className,
        attr: { type: "button" },
      });
      item.addEventListener("click", () => handler(item));
      return item;
    };
    const renderPrimary = (): void => {
      choices.empty();
      status.setText("先判断你是否想学习这份网页资料。");
      button("我想学习", () => renderLearning(), "okf-dashboard__secondary-action");
      button("我不准备学习", () => renderReference(), "okf-dashboard__ghost-action");
    };
    const renderLearning = (): void => {
      choices.empty();
      status.setText("现在生成辅助学习材料，或保存到学习稍后开始。");
      button("现在生成辅助学习材料", () => this.plugin.promptPublishWebCapture(note.path, "learn-now"), "okf-dashboard__secondary-action");
      button("稍后学习", () => this.plugin.promptPublishWebCapture(note.path, "learn-later"));
      button("返回", () => renderPrimary(), "okf-dashboard__ghost-action");
    };
    const renderReference = (): void => {
      choices.empty();
      status.setText("不准备学习时，再判断它是否值得长期保留。");
      button("直接生成知识笔记", () => this.plugin.promptPublishWebCapture(note.path, "wiki-now"), "okf-dashboard__secondary-action");
      button("只保存资料", () => this.plugin.promptPublishWebCapture(note.path, "source-only"));
      button("不保留", (discard) => {
        void this.runButtonAction(discard, () => this.api().discardCapture(note.path), true);
      }, "okf-dashboard__danger-action");
      button("返回", () => renderPrimary(), "okf-dashboard__ghost-action");
    };
    renderPrimary();
  }

  private pendingSourceActions(parent: HTMLElement, note: NoteSummary): void {
    const actions = parent.createDiv({ cls: "okf-dashboard__actions" });
    const learn = actions.createEl("button", { text: "用于学习" });
    learn.addEventListener("click", () => this.plugin.promptRoutePendingSource(note.path, "learn"));
    const wiki = actions.createEl("button", { text: "生成知识笔记" });
    wiki.addEventListener("click", () => this.plugin.promptRoutePendingSource(note.path, "wiki"));
    const sourceOnly = actions.createEl("button", { text: "只保存资料" });
    sourceOnly.addEventListener("click", () => this.plugin.promptRoutePendingSource(note.path, "source"));
  }

  private pendingGenerationActions(
    parent: HTMLElement,
    note: NoteSummary,
    operation?: SemanticOperationRecord,
    includeOperations = false,
  ): void {
    const actions = parent.createDiv({ cls: "okf-work-item__actions" });
    const active = operation && isSemanticOperationActive(operation.status);
    if (operation && isSemanticOperationActive(operation.status)) {
      const progress = actions.createEl("button", {
        text: semanticStageLabel(operation),
        cls: "okf-dashboard__ghost-action okf-work-item__primary-action",
      });
      progress.disabled = true;
    } else if (operation && isSemanticOperationRetryable(operation.status)) {
      const retry = actions.createEl("button", {
        text: "重新生成",
        cls: "mod-cta okf-dashboard__primary-action okf-work-item__primary-action",
      });
      retry.addEventListener("click", () => {
        void this.runButtonAction(retry, async () => {
          const retried = await this.api().retrySemanticOperation(operation.operation_id);
          this.plugin.watchSemanticOperation(retried.operation_id);
        }, true, "已重新加入后台任务");
      });
    } else if (operation?.status === "completed") {
      const completed = actions.createEl("button", {
        text: "正在刷新",
        cls: "okf-dashboard__ghost-action okf-work-item__primary-action",
      });
      completed.disabled = true;
    } else {
      const intent = note.purpose === "wiki" ? "wiki" : "learn";
      const generate = actions.createEl("button", {
        text: intent === "wiki" ? "生成知识笔记" : "生成学习材料",
        cls: "mod-cta okf-dashboard__primary-action okf-work-item__primary-action",
      });
      generate.addEventListener("click", () => {
        void this.runButtonAction(generate, async () => {
          const result = await this.api().routeImportedSource(note.path, {
            intent,
            generate: true,
            ...materialContextFromNote(note),
          });
          if (result.semantic_operation) {
            this.plugin.watchSemanticOperation(result.semantic_operation.operation_id);
          }
        }, true, "已加入后台生成任务");
      });
    }
    if (!includeOperations || operation?.status === "completed") return;
    const panelActions: AnchoredActionPanelAction[] = [];
    if (active && !["publishing", "indexing"].includes(operation.stage ?? "")) {
      panelActions.push({
        id: "cancel",
        title: "取消后台生成",
        description: "停止生成；已开始保存的内容可能无法取消",
        tone: "danger",
        onSelect: () => this.cancelSemanticOperation(operation.operation_id),
      });
    } else if (!active) {
      panelActions.push({
        id: "claudian-write",
        title: "补充要求后生成",
        description: "携带来源文件，在 Claudian 中补充要求后再开始",
        onSelect: async () => {
          const sources = await this.learningSources(note.path);
          await this.copyPrompt(
            "请读取附带的目标 Study Guide 和明确来源，按资料生成第一版可连续阅读的学习材料，并写入目标笔记。" +
              "我在本消息中补充的要求一并执行；没有补充要求时直接按资料处理。" +
              "完成后说明写入路径、实际读取的来源和重要缺口。",
            {
              contextPaths: [...new Set([note.path, ...sources])],
              actionMode: "write",
              skill: "prepare-study-guide",
            },
          );
        },
      });
    }
    if (!panelActions.length) return;
    const trigger = actions.createEl("button", {
      text: "其他操作 ▾",
      cls: "okf-dashboard__ghost-action okf-work-item__operation-trigger",
      attr: { type: "button", "aria-label": `${note.title} 的其他操作` },
    });
    this.attachActionPanel(trigger, {
      label: `其他操作 · ${note.title}`,
      renderHeader: (container) => this.renderPanelHeader(
        container,
        note.title,
        learningWorkItemStatusLabel(note, operation),
      ),
      actions: panelActions,
    });
  }

  private renderInboxConversionCard(parent: HTMLElement, conversion: ConversionRecord): void {
    const card = parent.createDiv({ cls: "okf-dashboard__card" });
    card.createEl("h3", { text: conversion.source_filename || conversion.conversion_id });
    const badges = card.createDiv({ cls: "okf-dashboard__badges" });
    this.ingestionBadge(badges, "file-import");
    card.createDiv({ cls: "okf-dashboard__muted", text: conversionStatusLabel(conversion) });
    if (conversion.error) card.createDiv({ text: conversion.error });
    const actions = card.createDiv({ cls: "okf-dashboard__actions" });
    const target = conversion.outputs.source_text ?? conversion.outputs.source;
    if (target) {
      const open = actions.createEl("button", { text: "打开转换正文" });
      open.addEventListener("click", () => void this.openPath(target));
    }
    if (hasPendingGeneration(conversion)) {
      const retry = actions.createEl("button", { text: "重试生成入队" });
      retry.addEventListener("click", () => {
        void this.runButtonAction(retry, async () => {
          const record = await this.api().retryConversion(conversion.conversion_id);
          this.plugin.watchDocumentConversion(record.conversion_id);
        }, true, "正在重试生成入队，无需重新转换");
      });
    } else if (conversion.status === "ready" || (
      conversion.status === "failed" && conversion.stages?.conversion === "completed"
    )) {
      const resume = actions.createEl("button", { text: "继续保存（不重新转换）" });
      resume.addEventListener("click", () => {
        void this.runButtonAction(resume, async () => {
          const record = await this.api().retryConversion(conversion.conversion_id);
          this.plugin.watchDocumentConversion(record.conversion_id);
        }, true, "已继续保存转换结果，无需重新转换");
      });
    } else if (conversion.status === "failed") {
      for (const parser of this.availableImportParsers()) {
        const retry = actions.createEl("button", { text: `用 ${parser} 重试` });
        retry.addEventListener("click", () => {
          void this.runButtonAction(retry, async () => {
            const record = await this.api().retryConversion(conversion.conversion_id, parser);
            this.plugin.watchDocumentConversion(record.conversion_id);
          }, true, "转换已重新排队");
        });
      }
    }
  }

  private availableImportParsers(): readonly "mineru"[] {
    return ["mineru"];
  }

  private async renderLearning(container: HTMLElement): Promise<void> {
    const data = await this.vaultReader.learning();
    const operations = this.semanticOperationsByTarget();
    const allLearningNotes = [
      ...data.pending_guides,
      ...data.ready_guides,
      ...data.completed_guides,
    ];
    const relationTitles = new Map<string, string>([
      ...data.courses.map((item) => [dashboardPath(item.path), item.title] as const),
      ...data.projects.map((item) => [dashboardPath(item.path), item.title] as const),
    ]);
    const scopeCounts = data.scope_entry_counts ?? dashboardLearningScopeCounts(allLearningNotes);
    const selectedCourse = this.learningContext === "course" && this.learningRelationPath
      ? data.courses.find((item) => dashboardPath(item.path) === dashboardPath(this.learningRelationPath))
      : undefined;
    const selectedProject = this.learningContext === "project" && this.learningRelationPath
      ? data.projects.find((item) => dashboardPath(item.path) === dashboardPath(this.learningRelationPath))
      : undefined;
    if (this.learningRelationPath && !selectedCourse && !selectedProject) {
      this.learningRelationPath = "";
      this.plugin.updateDashboardPageUiState("learning", { filters: { relation: null } });
    }
    const relationPath = selectedCourse?.path ?? selectedProject?.path;
    const scopeTitle = selectedCourse?.title ?? selectedProject?.title ?? learningScopeLabel(this.learningContext);
    const groups = {
      active: {
        label: "可学习",
        notes: filterDashboardLearningScope(
          data.ready_guides,
          this.learningContext,
          relationPath,
        ),
        empty: "还没有准备好的学习笔记，可以先添加资料。",
      },
      pending: {
        label: "待生成",
        notes: filterDashboardLearningScope(
          data.pending_guides,
          this.learningContext,
          relationPath,
        ),
        empty: "没有等待生成的学习材料。",
      },
      completed: {
        label: "已完成",
        notes: filterDashboardLearningScope(
          data.completed_guides,
          this.learningContext,
          relationPath,
        ),
        empty: "还没有完成的学习材料。",
      },
    } as const;
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const importMaterial = actions.createEl("button", {
      text: "导入学习资料",
      cls: "mod-cta okf-dashboard__primary-action",
    });
    importMaterial.addEventListener("click", () => this.plugin.openDocumentImport([], {
      ...(selectedCourse ? { course: selectedCourse.path.split("/")[2] } : {}),
      ...(selectedProject ? { project: selectedProject.path.split("/")[1] } : {}),
    }, "learning"));
    this.renderDocumentDropZone(container, {
      ...(selectedCourse ? { course: selectedCourse.path.split("/")[2] } : {}),
      ...(selectedProject ? { project: selectedProject.path.split("/")[1] } : {}),
    }, "learning");
    const classNote = actions.createEl("button", {
      text: "新建课堂笔记",
      cls: "okf-dashboard__secondary-action",
    });
    classNote.addEventListener("click", () => selectedCourse
      ? this.plugin.promptLessonForCourse(selectedCourse.path)
      : this.plugin.promptLesson());
    const course = actions.createEl("button", { text: "新建课程", cls: "okf-dashboard__ghost-action" });
    course.addEventListener("click", () => this.plugin.promptCourse());
    const nativeView = actions.createEl("button", { text: "完整学习目录", cls: "okf-dashboard__ghost-action" });
    nativeView.addEventListener("click", () => void this.openPath("system/views/Learning.md"));

    const workspace = container.createDiv({ cls: "okf-learning-workspace" });
    const side = workspace.createEl("aside", { cls: "okf-learning-contexts" });
    const contexts = this.dashboardSection(
      side,
      "学习范围",
      "按课程、项目或独立学习筛选材料。",
      "okf-learning-context-filter",
    );
    const contextList = contexts.createDiv({ cls: "okf-learning-context-list" });
    for (const option of [
      { value: "all" as const, label: "全部材料" },
      { value: "independent" as const, label: "独立学习" },
      { value: "course" as const, label: "课程相关" },
      { value: "project" as const, label: "项目相关" },
    ]) {
      const count = scopeCounts[option.value];
      const selectedContext = this.learningContext === option.value
        && (!this.learningRelationPath || !["course", "project"].includes(option.value));
      const button = contextList.createEl("button", {
        cls: `okf-learning-context${selectedContext ? " is-active" : ""}`,
        attr: { type: "button", "aria-pressed": String(selectedContext) },
      });
      button.createSpan({ text: option.label });
      button.createEl("strong", { text: String(count) });
      button.addEventListener("click", () => this.setLearningScope(option.value));
    }

    if (this.learningContext === "course") {
      this.renderLearningCourseScopes(side, data.courses, allLearningNotes, selectedCourse?.path);
    } else if (this.learningContext === "project") {
      this.renderLearningProjectScopes(side, data.projects, allLearningNotes, selectedProject?.path);
    }

    const current = this.dashboardSection(
      workspace,
      "学习材料",
      `当前范围：${scopeTitle}。选择要继续学习或准备的笔记。`,
      "okf-learning-section okf-learning-queue",
    );
    if (selectedCourse) this.renderSelectedCourse(current, selectedCourse);
    else if (selectedProject) this.renderSelectedProject(current, selectedProject);
    const tabs = current.createDiv({ cls: "okf-dashboard__segments", attr: { role: "tablist" } });
    for (const [id, group] of Object.entries(groups) as [keyof typeof groups, typeof groups[keyof typeof groups]][]) {
      const selected = id === this.learningTab;
      const button = tabs.createEl("button", {
        text: `${group.label} ${group.notes.length}`,
        cls: selected ? "is-active" : "",
        attr: { type: "button", role: "tab", "aria-selected": String(selected) },
      });
      button.addEventListener("click", () => {
        this.learningTab = id;
        this.plugin.updateDashboardPageUiState("learning", { tab: id });
        void this.render(true);
      });
    }
    const selected = groups[this.learningTab];
    const selectedList = current.createDiv({ cls: "okf-learning-tab-panel" });
    this.renderLearningNotes(
      selectedList,
      selected.notes,
      this.learningContext === "all"
        ? selected.empty
        : `${scopeTitle}当前没有处于“${selected.label}”状态的学习材料。`,
      operations,
      relationTitles,
    );
  }

  private setLearningScope(context: LearningContextFilter, relationPath = ""): void {
    this.learningContext = context;
    this.learningRelationPath = relationPath.replace(/^\/+|\/+$/gu, "");
    this.plugin.updateDashboardPageUiState("learning", {
      filters: {
        context,
        relation: this.learningRelationPath || null,
      },
    });
    void this.render(true);
  }

  private renderLearningCourseScopes(
    parent: HTMLElement,
    courses: Awaited<ReturnType<VaultDashboardReader["learning"]>>["courses"],
    notes: readonly NoteSummary[],
    selectedPath?: string,
  ): void {
    const section = this.learningEntityBrowser(
      parent,
      `选择课程 · ${courses.length}`,
      "选择一门课程；材料数与课堂笔记数分开显示。",
      selectedPath
        ? `当前课程：${courses.find((item) => dashboardPath(item.path) === dashboardPath(selectedPath))?.title ?? "已选择"}`
        : "选择选择课程",
    );
    if (!courses.length) {
      section.createDiv({ cls: "okf-dashboard__empty", text: "还没有课程。" });
      return;
    }
    const list = section.createDiv({ cls: "okf-learning-entity-list" });
    this.learningScopeEntity(
      list,
      "全部课程相关材料",
      `${courses.length} Course`,
      [dashboardLearningScopeMetric(notes, "course")],
      !selectedPath,
      () => this.setLearningScope("course"),
    );
    for (const item of courses) {
      this.learningScopeEntity(
        list,
        item.title,
        courseStatusLabel(item.course_status),
        [
          ...dashboardCourseMetrics(item),
          dashboardLearningScopeMetric(notes, "course", item.path),
        ],
        dashboardPath(selectedPath ?? "") === dashboardPath(item.path),
        () => this.setLearningScope("course", item.path),
        () => void this.openPath(item.path),
      );
    }
  }

  private renderLearningProjectScopes(
    parent: HTMLElement,
    projects: Awaited<ReturnType<VaultDashboardReader["learning"]>>["projects"],
    notes: readonly NoteSummary[],
    selectedPath?: string,
  ): void {
    const section = this.learningEntityBrowser(
      parent,
      `选择项目 · ${projects.length}`,
      "这里只统计实际关联的学习材料。",
      selectedPath
        ? `当前项目：${projects.find((item) => dashboardPath(item.path) === dashboardPath(selectedPath))?.title ?? "已选择"}`
        : "选择选择项目",
    );
    if (!projects.length) {
      section.createDiv({ cls: "okf-dashboard__empty", text: "还没有项目。" });
      return;
    }
    const list = section.createDiv({ cls: "okf-learning-entity-list" });
    this.learningScopeEntity(
      list,
      "全部项目相关材料",
      `${projects.length} Project`,
      [dashboardLearningScopeMetric(notes, "project")],
      !selectedPath,
      () => this.setLearningScope("project"),
    );
    for (const item of projects) {
      this.learningScopeEntity(
        list,
        item.title,
        projectStatusLabel(projectLifecycleStatus(item)),
        [
          ...dashboardProjectMetrics(item),
          dashboardLearningScopeMetric(notes, "project", item.path),
        ],
        dashboardPath(selectedPath ?? "") === dashboardPath(item.path),
        () => this.setLearningScope("project", item.path),
        () => void this.openPath(item.path),
      );
    }
  }

  private learningScopeEntity(
    parent: HTMLElement,
    title: string,
    meta: string,
    metrics: readonly DashboardObjectMetric[],
    selected: boolean,
    onSelect: () => void,
    onOpen?: () => void,
  ): void {
    const row = parent.createDiv({
      cls: `okf-learning-entity${selected ? " is-active" : ""}${onOpen ? "" : " is-scope-total"}`,
    });
    const select = row.createEl("button", {
      cls: "okf-learning-entity__select",
      attr: { type: "button", "aria-pressed": String(selected) },
    });
    const copy = select.createSpan({ cls: "okf-learning-entity__copy" });
    copy.createSpan({ cls: "okf-learning-entity__title", text: title });
    copy.createSpan({ cls: "okf-learning-entity__meta", text: meta });
    this.renderMetrics(copy, metrics);
    select.addEventListener("click", onSelect);
    if (onOpen) {
      const open = row.createEl("button", {
        text: "打开",
        cls: "okf-dashboard__ghost-action okf-learning-entity__open",
        attr: { type: "button", "aria-label": `打开 ${title}` },
      });
      open.addEventListener("click", onOpen);
    }
  }

  private learningEntityBrowser(
    parent: HTMLElement,
    title: string,
    description: string,
    compactTitle: string,
  ): HTMLElement {
    const details = parent.createEl("details", {
      cls: "okf-dashboard__section okf-learning-entity-browser",
    });
    details.createEl("summary", { text: compactTitle });
    const body = details.createDiv({ cls: "okf-learning-entity-browser__body" });
    const heading = body.createDiv({ cls: "okf-dashboard__section-heading" });
    heading.createEl("h3", { text: title });
    heading.createDiv({ cls: "okf-dashboard__muted", text: description });
    return body;
  }

  private renderDocumentContextButton(
    parent: HTMLElement,
    relation: Pick<DocumentImportOptions, "course" | "project">,
  ): void {
    const button = parent.createEl("button", {
      text: "添加资料 · 可拖入文件夹",
      cls: "okf-dashboard__ghost-action okf-document-drop",
      attr: { type: "button" },
    });
    button.addEventListener("click", () => this.plugin.openDocumentImport([], relation, "context"));
    bindDocumentDropTarget(button,
      (files) => this.plugin.openDocumentImport(files, relation, "context"),
      (error) => new Notice(error instanceof Error ? error.message : "无法读取拖入的文件夹", 8_000));
  }

  private renderSelectedCourse(
    parent: HTMLElement,
    course: CourseSummary,
  ): void {
    const row = parent.createEl("article", {
      cls: "okf-work-item okf-work-item--context okf-course-work-item",
    });
    const main = row.createDiv({ cls: "okf-work-item__main" });
    const identity = main.createDiv({ cls: "okf-work-item__identity" });
    const title = identity.createEl("button", {
      text: course.title,
      cls: "okf-dashboard__row-title",
      attr: { type: "button" },
    });
    title.addEventListener("click", () => void this.openPath(course.path));
    identity.createSpan({
      cls: "okf-work-item__status",
      text: courseStatusLabel(course.course_status),
    });
    main.createDiv({
      cls: "okf-work-item__summary",
      text: [
        course.current_progress ? `当前进度：${compactText(course.current_progress, 120)}` : "尚未记录课程进度",
        course.latest_lesson ? `最近课堂笔记：${course.latest_lesson.title}` : "",
      ].filter(Boolean).join(" · "),
    });
    this.renderMetrics(main, dashboardCourseMetrics(course), {
      "pending-captures": course.pending_captures,
      "study-guides": course.related_learning ?? [],
      sources: course.related_sources,
      lessons: course.lessons ?? [],
    });

    const actions = row.createDiv({ cls: "okf-work-item__actions" });
    const primary = actions.createEl("button", {
      text: "新建课堂笔记",
      cls: "okf-dashboard__secondary-action okf-work-item__primary-action",
      attr: { type: "button" },
    });
    primary.addEventListener("click", () => this.plugin.promptLessonForCourse(course.path));
    const courseSlug = course.path.split("/")[2];
    if (courseSlug) this.renderDocumentContextButton(actions, { course: courseSlug });
    const trigger = actions.createEl("button", {
      text: "其他操作 ▾",
      cls: "okf-dashboard__ghost-action okf-work-item__operation-trigger",
      attr: { type: "button", "aria-label": `${course.title} 的其他操作` },
    });
    const slug = course.path.split("/")[2];
    const panelActions: AnchoredActionPanelAction[] = [
      {
        id: "capture",
        title: "记录课程想法",
        description: "保存到待处理，并自动关联这门课程",
        onSelect: () => this.plugin.promptCapture({ course: course.path }),
      },
      ...(slug ? [{
        id: "import",
        title: "添加资料",
        description: "导入文档并自动关联这门课程",
        onSelect: () => this.plugin.openDocumentImport([], { course: slug }, "context"),
      } satisfies AnchoredActionPanelAction] : []),
      {
        id: "open",
        title: "打开课程主页",
        description: "打开笔记进行查看和编辑",
        onSelect: () => this.openPath(course.path),
      },
    ];
    this.attachActionPanel(trigger, {
      label: `其他操作 · ${course.title}`,
      renderHeader: (container) => this.renderPanelHeader(
        container,
        course.title,
        courseStatusLabel(course.course_status),
      ),
      actions: panelActions,
    });
  }

  private renderSelectedProject(
    parent: HTMLElement,
    project: ProjectSummary,
  ): void {
    this.renderProjectWorkItem(parent, project, true);
  }

  private renderProjectWorkItem(
    parent: HTMLElement,
    project: ProjectSummary,
    context = false,
    tasks: readonly VaultTask[] = [],
  ): void {
    const status = projectLifecycleStatus(project);
    const row = parent.createEl("article", {
      cls: `okf-work-item okf-project-row${context ? " okf-work-item--context" : ""}`,
    });
    row.setAttr("data-status", status);
    const main = row.createDiv({ cls: "okf-work-item__main" });
    const identity = main.createDiv({ cls: "okf-work-item__identity" });
    const title = identity.createEl("button", {
      text: project.title,
      cls: "okf-dashboard__row-title",
      attr: { type: "button", "aria-label": `打开 ${project.title}` },
    });
    title.addEventListener("click", () => void this.openPath(project.path));
    identity.createSpan({
      cls: `okf-work-item__status is-${status}`,
      text: projectStatusLabel(status),
    });
    main.createDiv({
      cls: "okf-work-item__summary",
      text: [
        project.next_action ? `下一步：${compactText(project.next_action, 120)}` : "尚未设置下一步",
        relativeMoment(project.modified_at),
      ].filter(Boolean).join(" · "),
    });
    this.renderMetrics(main, dashboardProjectMetrics(project), {
      "pending-captures": project.pending_captures,
      "study-guides": project.related_learning,
      sources: project.related_materials,
    });
    if (tasks.length) {
      const taskList = main.createDiv({ cls: "okf-project-row__tasks" });
      taskList.createDiv({ cls: "okf-dashboard__muted", text: `待办 · ${tasks.length}` });
      for (const task of tasks.slice(0, 3)) this.renderFormalTaskRow(taskList, task);
    }

    const actions = row.createDiv({ cls: "okf-work-item__actions" });
    const primary = actions.createEl("button", {
      text: status === "active" ? "记录进展" : status === "paused" ? "恢复推进" : "重新开启",
      cls: "okf-dashboard__secondary-action okf-work-item__primary-action",
      attr: { type: "button" },
    });
    if (status === "active") {
      primary.addEventListener("click", () => this.plugin.promptProjectProgress(project.path));
    } else {
      primary.addEventListener("click", () => {
        void this.changeProjectStatus(project.path, "active");
      });
    }
    const projectSlug = project.path.split("/")[1];
    if (projectSlug) this.renderDocumentContextButton(actions, { project: projectSlug });
    const trigger = actions.createEl("button", {
      text: "其他操作 ▾",
      cls: "okf-dashboard__ghost-action okf-work-item__operation-trigger",
      attr: {
        type: "button",
        "aria-label": `${project.title} 的其他操作`,
      },
    });
    this.attachProjectActionPanel(trigger, project, status);
  }

  private attachProjectActionPanel(
    trigger: HTMLButtonElement,
    project: ProjectSummary,
    status: ProjectLifecycleStatus,
  ): void {
    const slug = project.path.split("/")[1];
    const projectDirectory = project.path.split("/").slice(0, -1).join("/");
    const logPath = project.log_path || `${projectDirectory}/log.md`;
    const actions: AnchoredActionPanelAction[] = [
      {
        id: "capture",
        title: PROJECT_ACTION_PANEL_LABELS[0],
        description: "保存到待处理，并自动关联这个项目",
        onSelect: () => this.plugin.promptCapture({ project: project.path }),
      },
      ...(slug ? [{
        id: "import",
        title: PROJECT_ACTION_PANEL_LABELS[1],
        description: "导入资料并自动关联这个项目",
        onSelect: () => this.plugin.openDocumentImport([], { project: slug }, "context"),
      } satisfies AnchoredActionPanelAction] : []),
      {
        id: "log",
        title: PROJECT_ACTION_PANEL_LABELS[2],
        description: "打开项目日志进行查看和编辑",
        onSelect: () => this.openPath(logPath),
      },
      {
        id: "decision",
        title: PROJECT_ACTION_PANEL_LABELS[3],
        description: "记录这个项目的重要决定及其依据",
        onSelect: () => this.plugin.promptProjectDecision(project.path),
      },
      {
        id: "claudian",
        title: PROJECT_ACTION_PANEL_LABELS[4],
        description: "读取项目主页和日志，梳理状态、阻塞与下一步",
        onSelect: () => this.copyPrompt(
          "请读取附带的项目主页和日志。若我在本消息中提供了新的已发生进展，" +
            "请按项目记录 Skill 将其写入日志，并仅在当前状态确实变化时更新项目主页；" +
            "区分已确认事实、决定和建议。若没有提供新进展，先概括现状并询问要记录什么，不要追加重复日志。",
          {
            contextPaths: [project.path, logPath],
            actionMode: "write",
            skill: "capture-project-progress",
          },
        ),
      },
    ];
    this.attachActionPanel(trigger, {
      label: `其他操作 · ${project.title}`,
      renderHeader: (container) => this.renderPanelHeader(
        container,
        project.title,
        projectStatusLabel(status),
      ),
      actions,
      renderFooter: (container, context) => {
        const copy = container.ownerDocument.createElement("span");
        copy.className = "okf-action-panel__footer-label";
        copy.textContent = `项目状态：${projectStatusLabel(status)}`;
        container.appendChild(copy);
        const controls = container.ownerDocument.createElement("div");
        controls.className = "okf-action-panel__footer-actions";
        container.appendChild(controls);
        for (const item of projectStatusActions(status)) {
          const button = container.ownerDocument.createElement("button");
          button.type = "button";
          button.className = "okf-dashboard__ghost-action";
          button.textContent = item.label;
          button.addEventListener("click", () => {
            context.close();
            void this.changeProjectStatus(project.path, item.status);
          });
          controls.appendChild(button);
        }
      },
    });
  }

  private renderPanelHeader(container: HTMLElement, title: string, status: string): void {
    const copy = container.ownerDocument.createElement("div");
    copy.className = "okf-action-panel__header-copy";
    const heading = container.ownerDocument.createElement("strong");
    heading.textContent = title;
    copy.appendChild(heading);
    const badge = container.ownerDocument.createElement("span");
    badge.className = "okf-action-panel__status";
    badge.textContent = status;
    copy.appendChild(badge);
    container.appendChild(copy);
  }

  private async changeProjectStatus(
    path: string,
    status: ProjectLifecycleStatus,
  ): Promise<void> {
    try {
      await this.plugin.setProjectStatus(path, status);
      new Notice(`项目已更新为${projectStatusLabel(status)}`);
      await this.render(true);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "无法更新项目状态", 10_000);
    }
  }

  private renderLearningNotes(
    parent: HTMLElement,
    notes: NoteSummary[],
    empty: string,
    operations = new Map<string, SemanticOperationRecord>(),
    relationTitles: ReadonlyMap<string, string> = new Map<string, string>(),
  ): void {
    if (!notes.length) {
      parent.createDiv({ cls: "okf-dashboard__empty", text: empty });
      return;
    }
    const list = parent.createDiv({ cls: "okf-dashboard__compact-list okf-learning-note-list" });
    for (const note of notes) {
      const operation = this.semanticOperationForNote(note, operations);
      const card = list.createEl("article", {
        cls: "okf-work-item okf-learning-note okf-learning-work-item",
      });
      const main = card.createDiv({ cls: "okf-work-item__main" });
      const identity = main.createDiv({ cls: "okf-work-item__identity" });
      const open = identity.createEl("button", {
        text: note.title,
        cls: "okf-dashboard__row-title",
        attr: { type: "button" },
      });
      open.addEventListener("click", () => void this.openPath(note.path));
      identity.createSpan({
        cls: `okf-work-item__status is-${learningWorkItemStatus(note, operation)}`,
        text: learningWorkItemStatusLabel(note, operation),
      });
      main.createDiv({
        cls: "okf-work-item__summary",
        text: [
          learningContextLabel(note, relationTitles),
          relativeMoment(note.modified_at),
        ]
          .filter(Boolean)
          .join(" · "),
      });
      this.renderMetrics(main, [{
        key: "sources",
        label: "资料",
        count: note.note_type === "Source" ? 1 : (note.source_paths?.length ?? 0),
      }]);
      const action = dashboardLearningRowAction(note);
      if (action === "study-guide") {
        this.learningQueueActions(card, note, operation);
      } else if (action === "pending-source") {
        this.pendingGenerationActions(card, note, operation, true);
      }
    }
  }

  private learningQueueActions(
    parent: HTMLElement,
    note: NoteSummary,
    operation?: SemanticOperationRecord,
  ): void {
    const active = operation && isSemanticOperationActive(operation.status);
    const cluster = parent.createDiv({ cls: "okf-work-item__actions" });
    const action = cluster.createEl("button", {
      cls: "okf-work-item__primary-action",
      attr: { type: "button" },
    });
    if (active) {
      action.setText(semanticStageLabel(operation));
      action.addClass("okf-dashboard__ghost-action");
      action.disabled = true;
    } else if (note.studied_at) {
      action.setText("打开");
      action.addClass("okf-dashboard__secondary-action");
      action.addEventListener("click", () => void this.openPath(note.path));
    } else if (note.material_ready) {
      action.setText("打开");
      action.addClass("okf-dashboard__secondary-action");
      action.addEventListener("click", () => void this.openPath(note.path));
    } else if (operation && isSemanticOperationRetryable(operation.status)) {
      action.setText("重新生成");
      action.addClass("mod-cta", "okf-dashboard__primary-action");
      action.addEventListener("click", () => {
        void this.runButtonAction(action, async () => {
          const retried = await this.api().retrySemanticOperation(operation.operation_id);
          this.plugin.watchSemanticOperation(retried.operation_id);
        }, true, "已重新加入后台任务");
      });
    } else if (operation?.status === "completed") {
      action.setText("正在刷新");
      action.addClass("okf-dashboard__ghost-action");
      action.disabled = true;
    } else {
      action.setText("生成");
      action.addClass("mod-cta", "okf-dashboard__primary-action");
      action.addEventListener("click", () => {
        void this.runButtonAction(action, async () => {
          const created = await this.api().createSemanticOperation(
            "generate-study-guide",
            note.path,
            { sources: await this.learningSources(note.path) },
          );
          this.plugin.watchSemanticOperation(created.operation_id);
          new Notice(
            created.status === "completed"
              ? "辅助学习材料已生成，可打开学习笔记"
              : "已加入后台生成任务；完成后会通知你",
            10_000,
          );
        }, true);
      });
    }

    if (
      (active && ["publishing", "indexing"].includes(operation.stage ?? "")) ||
      (operation?.status === "completed" && !note.material_ready)
    ) return;
    const panelActions: AnchoredActionPanelAction[] = [];
    if (active) {
      panelActions.push({
        id: "cancel",
        title: "取消后台生成",
        description: "停止生成；已开始保存的内容可能无法取消",
        tone: "danger",
        onSelect: () => this.cancelSemanticOperation(operation.operation_id),
      });
    } else {
      panelActions.push({
        id: "claudian-write",
        title: note.material_ready ? "用 AI 完善" : "补充要求后生成",
        description: note.material_ready
          ? "携带学习笔记和来源继续编辑"
          : "在 Claudian 中补充要求后再开始生成",
        onSelect: async () => {
          const sources = await this.learningSources(note.path);
          await this.copyPrompt(
          note.material_ready
            ? "请完整读取附带的 Study Guide，把我在本消息中补充的结论、纠错、例子或具体修改要求融入相关章节，" +
              "保留原有人工内容。若本消息没有提供需要融入的内容，先询问我希望完善什么，不要改写笔记。"
            : "请读取附带的目标 Study Guide 和明确来源，按资料生成第一版可连续阅读的学习材料，并写入目标笔记。" +
              "我在本消息中补充的要求一并执行；没有补充要求时直接按资料处理。" +
              "完成后说明写入路径、实际读取的来源和重要缺口。",
          {
            contextPaths: [...new Set([note.path, ...sources])],
            actionMode: "write",
            skill: note.material_ready ? "update-study-guide" : "prepare-study-guide",
          },
          );
        },
      });
      if (note.material_ready) {
        panelActions.push({
          id: "claudian-read",
          title: "与 AI 讨论",
          description: "结合这篇学习笔记继续提问和学习",
          onSelect: () => this.copyPrompt(
            "请先读取附带的学习笔记，再根据我在本消息中提出的问题，按需读取相关知识笔记并帮助我理解。" +
              "区分笔记记载、补充解释和未核实的内容。若我尚未提出具体问题，先问我想讨论哪部分。",
            {
              contextPaths: [note.path],
              actionMode: "read",
            },
          ),
        });
      }
      if (canCompleteDashboardStudy(note, operation)) {
        panelActions.push({
          id: "study-status",
          title: note.studied_at ? "取消完成" : "标记完成",
          description: note.studied_at ? "恢复到可学习状态" : "记录这份材料已经学完",
          onSelect: async () => {
            await this.plugin.setStudyCompleted(note.path, !note.studied_at);
            await this.render(true);
          },
        });
      }
      if (note.studied_at) {
        panelActions.push({
          id: "wiki",
          title: "整理为知识笔记",
          description: "把已完成的学习成果整理为长期知识",
          onSelect: () => this.copyPrompt(
            "请读取附带的 Study Guide，提炼其中可独立使用的概念、机制或判断；" +
              "核对相关的既有知识笔记后，创建或更新合适的笔记，并维护必要的来源与链接。" +
              "不要把“已标记学完”推断为我认同或掌握了其中每个结论。",
            {
              contextPaths: [note.path],
              actionMode: "write",
              skill: "distill-wiki",
            },
          ),
        });
      }
    }
    if (!panelActions.length) return;
    const trigger = cluster.createEl("button", {
      text: "其他操作 ▾",
      cls: "okf-dashboard__ghost-action okf-work-item__operation-trigger",
      attr: { type: "button", "aria-label": `${note.title} 的其他操作` },
    });
    this.attachActionPanel(trigger, {
      label: `其他操作 · ${note.title}`,
      renderHeader: (container) => this.renderPanelHeader(
        container,
        note.title,
        learningWorkItemStatusLabel(note, operation),
      ),
      actions: panelActions,
    });
  }

  private async renderProjects(container: HTMLElement): Promise<void> {
    const [data, tasks] = await Promise.all([
      this.vaultReader.projects(),
      this.collectFormalTasks(),
    ]);
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const create = actions.createEl("button", {
      text: "新建项目",
      cls: "okf-dashboard__secondary-action",
    });
    create.addEventListener("click", () => this.plugin.promptProject());
    const catalog = actions.createEl("button", {
      text: "完整项目目录",
      cls: "okf-dashboard__ghost-action",
    });
    catalog.addEventListener("click", () => void this.openPath("system/views/Projects.md"));

    const tabs = container.createDiv({
      cls: "okf-dashboard__segments okf-dashboard__stage-tabs",
      attr: { role: "tablist", "aria-label": "项目状态" },
    });
    const groups = {
      active: data.projects.filter((project) => !project.project_status || project.project_status === "active"),
      paused: data.projects.filter((project) => project.project_status === "paused"),
      completed: data.projects.filter((project) => project.project_status === "completed"),
    };
    for (const option of [
      { value: "active" as const, label: "进行中" },
      { value: "paused" as const, label: "已暂停" },
      { value: "completed" as const, label: "已完成" },
    ]) {
      const selected = this.projectsTab === option.value;
      const button = tabs.createEl("button", {
        text: `${option.label} ${groups[option.value].length}`,
        cls: selected ? "is-active" : "",
        attr: { type: "button", role: "tab", "aria-selected": String(selected) },
      });
      button.addEventListener("click", () => {
        this.projectsTab = option.value;
        this.plugin.updateDashboardPageUiState("projects", { tab: option.value });
        void this.render(true);
      });
    }

    const selected = groups[this.projectsTab];
    if (!selected.length) {
      container.createDiv({
        cls: "okf-dashboard__empty okf-dashboard__empty--panel",
        text: this.projectsTab === "active" ? "当前没有进行中的项目。" : "这个状态下没有项目。",
      });
      return;
    }
    const list = container.createDiv({ cls: "okf-dashboard__compact-list okf-project-list" });
    for (const project of selected) {
      const root = project.path.split("/").slice(0, -1).join("/") + "/";
      const projectTasks = tasks.filter((task) =>
        task.formal && !task.checked && task.path.startsWith(root),
      );
      this.renderProjectWorkItem(list, project, false, projectTasks);
    }
  }

  private async renderKnowledge(container: HTMLElement): Promise<void> {
    const data = await this.vaultReader.knowledge();
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const create = actions.createEl("button", {
      text: "从材料生成知识笔记",
      cls: "okf-dashboard__secondary-action",
    });
    create.addEventListener("click", () => this.plugin.promptWikiFromSources());
    const catalog = actions.createEl("button", {
      text: "完整知识目录",
      cls: "okf-dashboard__ghost-action",
    });
    catalog.addEventListener("click", () => void this.openPath("system/views/Knowledge.md"));

    const search = container.createEl("input", {
      cls: "okf-dashboard__knowledge-search",
      attr: {
        type: "search",
        placeholder: "搜索知识笔记、知识导航、标签和主题…",
        "aria-label": "搜索知识库",
      },
    });
    search.value = this.knowledgeQuery;
    const filters = container.createDiv({
      cls: "okf-dashboard__segments okf-dashboard__knowledge-filters",
      attr: { role: "tablist", "aria-label": "知识库筛选" },
    });
    const options = [
      { value: "all" as const, label: "全部", count: data.notes.length + data.pending_wiki.length },
      { value: "pending" as const, label: "待生成", count: data.pending_wiki.length },
      { value: "wiki" as const, label: "知识笔记", count: data.notes.filter((note) => note.note_type === "Wiki").length },
      { value: "map" as const, label: "知识导航", count: data.notes.filter((note) => note.note_type === "Wiki Map").length },
      { value: "unverified" as const, label: "待核验 AI 内容", count: data.notes.filter((note) => note.ai_unverified).length },
      { value: "stale" as const, label: "需要复核", count: data.notes.filter((note) => note.stale).length },
      { value: "deprecated" as const, label: "已弃用", count: data.notes.filter((note) => note.status === "deprecated").length },
    ];
    const list = container.createDiv({ cls: "okf-dashboard__compact-list okf-knowledge-list" });
    const operations = this.semanticOperationsByTarget();
    const renderList = (): void => {
      list.empty();
      const query = this.knowledgeQuery.trim().toLocaleLowerCase();
      const pending = data.pending_wiki.filter((note) =>
        (this.knowledgeFilter === "all" || this.knowledgeFilter === "pending") &&
        (!query || [note.title, note.path, note.course, note.project, ...(note.topics ?? [])]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)),
      );
      const visible = [...data.notes]
        .filter((note) => {
          const matchesQuery = !query || [note.title, note.path, ...(note.topics ?? [])]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query);
          const matchesFilter = this.knowledgeFilter === "all" ||
            (this.knowledgeFilter === "wiki" && note.note_type === "Wiki") ||
            (this.knowledgeFilter === "map" && note.note_type === "Wiki Map") ||
            (this.knowledgeFilter === "unverified" && note.ai_unverified === true) ||
            (this.knowledgeFilter === "stale" && note.stale) ||
            (this.knowledgeFilter === "deprecated" && note.status === "deprecated");
          return matchesQuery && matchesFilter;
        })
        .sort((left, right) =>
          Number(right.note_type === "Wiki Map") - Number(left.note_type === "Wiki Map") ||
          (right.modified_at ?? "").localeCompare(left.modified_at ?? "") ||
          left.title.localeCompare(right.title),
        );
      if (!visible.length && !pending.length) {
        list.createDiv({ cls: "okf-dashboard__empty", text: "没有符合当前条件的知识笔记。" });
        return;
      }
      for (const note of pending) {
        const row = list.createDiv({
          cls: "okf-dashboard__compact-row okf-dashboard__compact-row--stacked",
        });
        const title = row.createEl("button", {
          text: note.title,
          cls: "okf-dashboard__row-title",
          attr: { type: "button" },
        });
        title.addEventListener("click", () => void this.openPath(note.path));
        row.createDiv({
          cls: "okf-dashboard__row-meta",
          text: `待生成知识笔记 · ${learningContextLabel(note, new Map())}`,
        });
        this.pendingGenerationActions(row, note, this.semanticOperationForNote(note, operations));
      }
      for (const note of visible) {
        const badges = [
          note.ai_unverified ? "待核验 AI 内容" : undefined,
          note.stale ? "需要复核" : undefined,
          note.status === "deprecated" ? "已弃用" : undefined,
        ].filter((value): value is string => Boolean(value));
        const meta = [
          noteTypeLabel(note.note_type),
          ...((note.topics ?? []).slice(0, 3)),
          relativeMoment(note.modified_at),
        ].filter(Boolean).join(" · ");
        const row = this.compactRow(
          list,
          note.title,
          meta,
          note.ai_unverified ? "打开核验" : "打开",
          () => void this.openPath(note.path),
          badges[0],
        );
        row.dataset.noteType = note.note_type;
        if (badges.length > 1) {
          const badgeContainer = row.createDiv({ cls: "okf-dashboard__badges" });
          for (const badge of badges.slice(1)) badgeContainer.createSpan({ cls: "okf-dashboard__badge", text: badge });
        }
      }
    };
    for (const option of options) {
      const button = filters.createEl("button", {
        text: `${option.label} ${option.count}`,
        cls: this.knowledgeFilter === option.value ? "is-active" : "",
        attr: { type: "button", role: "tab", "aria-selected": String(this.knowledgeFilter === option.value) },
      });
      button.addEventListener("click", () => {
        this.knowledgeFilter = option.value;
        this.plugin.updateDashboardPageUiState("knowledge", { filters: { view: option.value } });
        for (const sibling of filters.querySelectorAll<HTMLButtonElement>("button")) {
          sibling.removeClass("is-active");
          sibling.setAttr("aria-selected", String(sibling === button));
        }
        button.addClass("is-active");
        renderList();
      });
    }
    search.addEventListener("input", () => {
      this.knowledgeQuery = search.value;
      this.plugin.updateDashboardPageUiState("knowledge", { filters: { query: search.value } });
      renderList();
    });
    renderList();
  }

  private async renderLife(container: HTMLElement): Promise<void> {
    const payload = await this.vaultReader.life();
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const today = actions.createEl("button", {
      text: "继续写今日日记",
      cls: "mod-cta okf-dashboard__primary-action",
    });
    today.addEventListener("click", () => {
      today.disabled = true;
      void this.plugin.createDaily()
        .then((result) => this.openPath(result.path))
        .catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : "无法创建今日日记", 10_000);
        })
        .finally(() => {
          today.disabled = false;
        });
    });
    const jot = actions.createEl("button", { text: "打开随手记录", cls: "okf-dashboard__secondary-action" });
    jot.addEventListener("click", () => this.plugin.promptDailyCapture());
    const reflection = actions.createEl("button", { text: "新建反思", cls: "okf-dashboard__ghost-action" });
    reflection.addEventListener("click", () => this.plugin.promptReflection());
    const review = actions.createEl("button", { text: "新建复盘", cls: "okf-dashboard__ghost-action" });
    review.addEventListener("click", () => this.plugin.promptReview());
    const calendar = actions.createEl("button", { text: "打开日历", cls: "okf-dashboard__ghost-action" });
    calendar.addEventListener("click", () => this.plugin.openChineseCalendar());

    const dailyNotes = payload.notes.filter((note) => note.path.startsWith("life/daily/"));
    const reflections = payload.notes.filter((note) => note.path.startsWith("life/reflections/"));
    const reviews = payload.notes.filter((note) => note.path.startsWith("life/reviews/"));

    const lifeLayout = container.createDiv({ cls: "okf-life-layout" });
    const dailySection = this.dashboardSection(
      lifeLayout,
      "最近日记",
      "查看最近日记，或打开日历查找其他日期。",
      "okf-life-section okf-life-section--daily",
    );
    const recentDaily = [...dailyNotes]
      .sort((left, right) => right.path.localeCompare(left.path))
      .slice(0, 10);
    this.renderLifeNoteCards(dailySection, recentDaily, "还没有日记。", true);

    const lifeSide = lifeLayout.createDiv({ cls: "okf-life-layout__side" });
    const reflectionSection = this.dashboardSection(
      lifeSide,
      "反思",
      "值得单独成篇的观察、困惑和思考。",
      "okf-life-section",
    );
    this.renderLifeNoteCards(reflectionSection, reflections.slice(0, 6), "还没有独立反思。", true);

    if (reviews.length) {
      const reviewSection = this.dashboardSection(
        container,
        "复盘",
        "按周期回看节奏、趋势和方向。",
        "okf-life-section okf-dashboard__section--low-priority",
      );
      for (const [root, label] of [
        ["life/reviews/weekly/", "每周"],
        ["life/reviews/monthly/", "每月"],
        ["life/reviews/yearly/", "每年"],
      ] as const) {
        const selected = reviews.filter((note) => note.path.startsWith(root));
        if (!selected.length) continue;
        const group = reviewSection.createDiv({ cls: "okf-life-review-group" });
        group.createEl("h4", { text: `${label} · ${selected.length}` });
        this.renderLifeNoteCards(group, selected.slice(0, 6), "", true);
      }
    }
  }

  private renderLifeNoteCards(
    parent: HTMLElement,
    notes: NoteSummary[],
    empty: string,
    _compact = false,
  ): void {
    if (!notes.length) {
      parent.createDiv({ cls: "okf-dashboard__empty", text: empty });
      return;
    }
    const cards = parent.createDiv({ cls: "okf-dashboard__compact-list okf-life-note-list" });
    for (const note of notes) {
      this.compactRow(
        cards,
        note.title,
        [noteTypeLabel(note.note_type), relativeMoment(note.modified_at)].filter(Boolean).join(" · "),
        "打开",
        () => void this.openPath(note.path),
      );
    }
  }

  private inboxActions(parent: HTMLElement, note: NoteSummary): void {
    const entry = parent.createDiv({ cls: "okf-dashboard__actions" });
    const organize = entry.createEl("button", {
      text: "整理…",
      cls: "okf-dashboard__secondary-action",
      attr: { type: "button", "aria-expanded": "false" },
    });
    const panel = parent.createDiv({ cls: "okf-dashboard__decision-panel is-hidden" });
    const recommendation = panel.createDiv({
      cls: "okf-dashboard__muted",
      text: "选择它最终要进入的位置。",
    });
    const actions = panel.createDiv({ cls: "okf-dashboard__actions" });
    organize.addEventListener("click", () => {
      const visible = panel.hasClass("is-hidden");
      panel.toggleClass("is-hidden", !visible);
      organize.setAttr("aria-expanded", String(visible));
    });
    const routes: readonly [string, "reflection" | "study-guide" | "wiki"][] = [
      ["转为反思", "reflection"],
      ["进入学习", "study-guide"],
      ["转为知识笔记", "wiki"],
    ];
    for (const [label, route] of routes) {
      const button = actions.createEl("button", {
        text: label,
        attr: { "data-route": route },
      });
      button.addEventListener("click", () => {
        void this.runButtonAction(
          button,
          () => this.api().organizeCapture(note.path, route),
          true,
        );
      });
    }
    const project = actions.createEl("button", {
      text: "项目记录",
      attr: { "data-route": "project-log" },
    });
    project.addEventListener("click", () => this.plugin.promptCaptureProject(note.path));
    const classNote = actions.createEl("button", {
      text: "课堂笔记",
      attr: { "data-route": "lesson" },
    });
    classNote.addEventListener("click", () => this.plugin.promptCaptureLesson(note.path));
    const discard = actions.createEl("button", { text: "丢弃" });
    discard.addClass("okf-dashboard__danger-action");
    discard.addEventListener("click", () => {
      void this.runButtonAction(discard, () => this.api().discardCapture(note.path), true);
    });
    const suggest = panel.createEl("button", {
      text: "按规则建议去向",
      cls: "okf-dashboard__ghost-action",
    });
    suggest.addEventListener("click", () => {
      suggest.disabled = true;
      recommendation.setText("正在按规则分析这条记录…");
      void this.api().recommendCapture(note.path).then((result) => {
        recommendation.setText("建议：" + captureDestinationLabel(result.destination) + "；" + result.reason);
        for (const button of actions.querySelectorAll<HTMLButtonElement>("[data-route]")) {
          button.toggleClass("mod-cta", button.dataset.route === result.destination);
        }
      }).catch(() => recommendation.setText("建议暂时无法读取，你仍可手动选择。"))
        .finally(() => {
          suggest.disabled = false;
        });
    });
  }

  private async renderSystem(container: HTMLElement): Promise<void> {
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const refresh = actions.createEl("button", {
      text: "刷新诊断",
      cls: "okf-dashboard__secondary-action",
    });
    const settings = actions.createEl("button", {
      text: "插件设置",
      cls: "okf-dashboard__ghost-action",
    });
    settings.addEventListener("click", () => this.plugin.openPluginSettings());
    const header = container.createDiv({ cls: "okf-dashboard__system-summary" });
    const content = container.createDiv();
    if (this.systemCache) {
      this.renderSystemSnapshot(content, this.systemCache, null, "loading");
      header.setText(
        `Dashboard ${DASHBOARD_VERSION} · CLI ${this.systemCache.version} · 上次检查 ${formatLocalTimestamp(this.systemCache.checked_at)}`,
      );
    } else {
      header.setText(`Dashboard ${DASHBOARD_VERSION} · 正在后台读取系统快照…`);
      content.createDiv({ cls: "okf-dashboard__empty", text: "本地笔记功能不受系统诊断影响。" });
    }
    const load = async (refreshServices = false): Promise<void> => {
      refresh.disabled = true;
      const [status, latest] = await Promise.allSettled([
        this.api().systemStatus(refreshServices),
        this.api().latestChange(),
      ]);
      if (!container.isConnected) return;
      if (status.status === "fulfilled") {
        this.systemCache = status.value;
        content.empty();
        this.renderSystemSnapshot(
          content,
          status.value,
          latest.status === "fulfilled" ? latest.value : null,
          latest.status === "fulfilled" ? "confirmed" : "unavailable",
        );
        header.setText(
          `Dashboard ${DASHBOARD_VERSION} · CLI ${status.value.version} · 检查于 ${formatLocalTimestamp(status.value.checked_at)}`,
        );
      } else {
        header.setText(
          this.systemCache
            ? `系统刷新失败，继续显示 ${formatLocalTimestamp(this.systemCache.checked_at)} 的快照`
            : "系统诊断暂时不可用；本地笔记功能仍可正常使用",
        );
      }
      refresh.disabled = false;
    };
    refresh.addEventListener("click", () => void load(true));
    void load();
  }

  private renderCodexIntegrationStatus(container: HTMLElement): void {
    const available = this.plugin.isCodexConsoleAvailable();
    const card = container.createDiv({
      cls: "okf-dashboard__system-row",
      attr: { "data-system-status": available ? "ok" : "warning" },
    });
    const identity = card.createDiv({ cls: "okf-dashboard__system-identity" });
    identity.createEl("h3", { text: "Claudian" });
    identity.createSpan({
      cls: `okf-dashboard__status-badge${available ? " is-ok" : " is-warning"}`,
      text: available ? "可用" : "未加载",
    });
    card.createDiv({
      cls: "okf-dashboard__system-detail",
      text: available
        ? "Claudian 已连接，可结合相关笔记发起任务。"
        : "启用 Claudian 插件并重新加载 Obsidian 后即可使用。",
    });
    if (available) {
      const open = card.createEl("button", {
        text: "打开",
        cls: "okf-dashboard__secondary-action okf-dashboard__system-action",
      });
      open.addEventListener("click", () => {
        void this.plugin.openCodexConsole().catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : "无法打开 Claudian", 10_000);
        });
      });
    }
  }

  private renderSystemSnapshot(
    container: HTMLElement,
    status: SystemStatus,
    latest: { checkpoint: string; message: string; files: string[] } | null,
    latestStatus: "loading" | "confirmed" | "unavailable" = "confirmed",
  ): void {
    if (!status.actionable.length) {
      container.createDiv({
        cls: "okf-dashboard__health-summary is-healthy",
        text: "当前没有需要你处理的问题。",
      });
    } else {
      const attention = this.dashboardSection(
        container,
        "需要处理",
        `${status.actionable.length} 项异常或警告。`,
        "okf-system-actionable",
      );
      const items = attention.createDiv({ cls: "okf-dashboard__compact-list" });
      for (const item of status.actionable) {
        if (item.item_id === "conversions" && item.status === "failed") {
          this.renderFailedConversions(items);
        } else if (item.item_id === "semantic-operations" && item.status === "failed") {
          this.renderFailedSemanticOperations(items);
        } else if (item.item_id === "governance" && item.status === "warning") {
          const placeholder = items.createDiv({ cls: "okf-dashboard__compact-row okf-dashboard__compact-row--stacked" });
          placeholder.createEl("strong", { text: "笔记与链接检查" });
          const state = placeholder.createDiv({ cls: "okf-dashboard__muted", text: "正在加载详情…" });
          void this.renderGovernanceIssues(placeholder)
            .then(() => state.remove())
            .catch(() => state.setText("检查详情暂时无法读取，可稍后单独刷新。"));
        } else {
          this.systemCard(items, item);
        }
      }
    }

    const details = container.createEl("details", {
      cls: "okf-dashboard__diagnostics okf-dashboard__section--low-priority",
    });
    details.createEl("summary", { text: "服务与诊断详情" });
    const items = details.createDiv({ cls: "okf-dashboard__compact-list" });
    for (const item of status.items) {
      if (status.actionable.some((candidate) => candidate.item_id === item.item_id)) continue;
      this.systemCard(items, item);
    }
    this.renderCodexIntegrationStatus(details);

    const advanced = container.createEl("details", {
      cls: "okf-dashboard__diagnostics okf-dashboard__section--low-priority",
    });
    advanced.createEl("summary", { text: "高级维护与撤销" });
    if (latest) {
      const change = advanced.createDiv({ cls: "okf-dashboard__compact-panel" });
      change.createEl("h4", { text: "最近一次可撤销修改" });
      change.createDiv({ text: latest.message });
      const files = change.createDiv({ cls: "okf-dashboard__actions" });
      for (const file of latest.files) {
        const open = files.createEl("button", { text: "查看 " + file, cls: "okf-dashboard__ghost-action" });
        open.addEventListener("click", () => void this.openPath(file));
      }
    }
    if (latestStatus !== "confirmed") {
      advanced.createDiv({
        cls: latestStatus === "unavailable" ? "okf-dashboard__error" : "okf-dashboard__muted",
        text: latestStatus === "unavailable"
          ? "无法确认当前最新修改；为避免撤销错误内容，本次不提供撤销操作。"
          : "正在确认当前可撤销项…",
      });
    }
    const undo = advanced.createEl("button", {
      text: "撤销最近一次 AI / 自动修改…",
      cls: "okf-dashboard__danger-action",
    });
    undo.disabled = latestStatus !== "confirmed" || !latest;
    undo.addEventListener("click", () => {
      void this.runButtonAction(undo, () => this.api().undo(), false, "已撤销最近一次修改");
    });
  }

  private systemCard(parent: HTMLElement, item: SystemItem): void {
    const card = parent.createDiv({
      cls: "okf-dashboard__system-row",
      attr: { "data-system-status": item.status },
    });
    const identity = card.createDiv({ cls: "okf-dashboard__system-identity" });
    identity.createEl("h3", { text: item.label });
    identity.createSpan({
      cls: `okf-dashboard__status-badge ${systemStatusClass(item.status)}`,
      text: systemStatusLabel(item.status),
    });
    card.createDiv({ cls: "okf-dashboard__system-detail", text: item.detail });
    if (item.item_id === "index" && item.action) {
      const action = card.createEl("button", {
        text: "重建索引",
        cls: "okf-dashboard__secondary-action okf-dashboard__system-action",
      });
      action.addEventListener("click", () => {
        void this.runButtonAction(action, () => this.api().rebuildIndex(), true);
      });
    } else if (item.item_id === "feeds" && item.action === "立即同步") {
      const action = card.createEl("button", {
        text: "立即同步",
        cls: "okf-dashboard__secondary-action okf-dashboard__system-action",
      });
      action.addEventListener("click", () => {
        void this.runButtonAction(
          action,
          () => this.syncFeedsAndRefresh(),
          false,
          "订阅已同步",
        );
      });
    } else if (item.action) {
      card.createDiv({ cls: "okf-dashboard__muted okf-dashboard__system-action", text: item.action });
    }
  }

  private renderFailedConversions(parent: HTMLElement): void {
    const failures = this.plugin.conversionSnapshot().filter(
      (conversion) => conversion.status === "failed",
    );
    if (!failures.length) {
      parent.createDiv({ cls: "okf-dashboard__empty", text: "失败转换详情正在同步。" });
      return;
    }
    for (const failure of failures) {
      const card = parent.createDiv({ cls: "okf-dashboard__card" });
      card.createEl("h3", { text: failure.source_filename || failure.conversion_id });
      if (failure.stages?.conversion === "completed") {
        card.createDiv({
          cls: "okf-dashboard__muted",
          text: "Markdown 转换和质检已经完成；失败发生在归档或版本记录阶段。",
        });
      }
      if (failure.error) card.createDiv({ text: failure.error });
      for (const attempt of failure.parser_attempts ?? []) {
        card.createDiv({
          cls: "okf-dashboard__muted",
          text: `${attempt.parser} · ${attempt.status} · ${attempt.duration_ms} ms${attempt.error ? ` · ${attempt.error}` : ""}`,
        });
      }
      const actions = card.createDiv({ cls: "okf-dashboard__actions" });
      if (failure.stages?.conversion === "completed") {
        const resume = actions.createEl("button", { text: "继续保存（不重新转换）" });
        resume.addEventListener("click", () => {
          resume.disabled = true;
          void this.api()
            .retryConversion(failure.conversion_id)
            .then((record) => {
              this.plugin.watchDocumentConversion(record.conversion_id);
              new Notice("已继续保存转换结果，无需重新转换");
              return this.render();
            })
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : "继续保存失败");
            })
            .finally(() => {
              resume.disabled = false;
            });
        });
      }
      for (const parser of this.availableImportParsers()) {
        const retry = actions.createEl("button", { text: "用 " + parser + " 重试" });
        retry.addEventListener("click", () => {
          retry.disabled = true;
          void this.api()
            .retryConversion(failure.conversion_id, parser)
            .then((record) => {
              this.plugin.watchDocumentConversion(record.conversion_id);
              new Notice("转换已重新排队");
              return this.render();
            })
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : "重试失败");
            })
            .finally(() => {
              retry.disabled = false;
            });
        });
      }
    }
  }

  private renderActiveConversions(parent: HTMLElement): void {
    const active = this.plugin.conversionSnapshot().filter((conversion) =>
      ["queued", "converting", "waiting-for-mineru"].includes(conversion.status),
    );
    if (!active.length) return;
    const section = this.dashboardSection(
      parent,
      "正在导入的资料",
      "上传已经完成；转换在后台继续，不会阻塞工作台。",
    );
    const cards = section.createDiv({ cls: "okf-dashboard__cards" });
    for (const conversion of active) {
      const card = cards.createDiv({ cls: "okf-dashboard__card" });
      card.createEl("h3", { text: conversion.source_filename || conversion.conversion_id });
      card.createDiv({
        cls: "okf-dashboard__muted",
        text:
          conversion.status === "waiting-for-mineru"
            ? "等待 MinerU；后台会自动重试"
            : conversion.status === "converting"
              ? `正在使用 ${conversion.parser} 转换`
              : "已排队",
      });
    }
  }

  private renderFailedSemanticOperations(parent: HTMLElement): void {
    const failures = this.plugin.semanticOperationsSnapshot().filter(
      (operation) => operation.status === "failed",
    );
    if (!failures.length) {
      parent.createDiv({ cls: "okf-dashboard__empty", text: "失败任务详情正在同步。" });
      return;
    }
    for (const failure of failures) {
      const card = parent.createDiv({ cls: "okf-dashboard__card" });
      card.createEl("h3", { text: failure.target });
      card.createDiv({ cls: "okf-dashboard__muted", text: failure.kind });
      if (failure.error) card.createDiv({ text: failure.error });
      const retry = card.createEl("button", { text: "从失败步骤重试" });
      retry.addEventListener("click", () => {
        void this.runButtonAction(
          retry,
          async () => {
            const retried = await this.api().retrySemanticOperation(failure.operation_id);
            this.plugin.watchSemanticOperation(retried.operation_id);
          },
          true,
          "已重新加入后台任务",
        );
      });
    }
  }

  private async renderGovernanceIssues(parent: HTMLElement): Promise<void> {
    const report = await this.api().governanceReport();
    const card = parent.createDiv({ cls: "okf-dashboard__card okf-dashboard__card--wide" });
    card.createEl("h3", { text: `笔记与链接检查 · ${report.issue_count}` });
    for (const issue of report.issues.slice(0, 20)) {
      const row = card.createDiv({ cls: "okf-dashboard__summary-link" });
      const open = row.createEl("button", { text: issue.path });
      open.addEventListener("click", () => void this.openPath(issue.path));
      row.createDiv({ cls: "okf-dashboard__muted", text: `${issue.code} · ${issue.detail}` });
    }
  }

  private async copyPrompt(
    prompt: string,
    options: Omit<CodexHandoffRequest, "prompt"> = {},
  ): Promise<void> {
    try {
      await this.plugin.openCodexPrompt(prompt, options);
    } catch (error) {
      new Notice(
        `无法打开 Claudian：${error instanceof Error ? error.message : "Claudian 面板不可用"}`,
        10_000,
      );
    }
  }

  private async learningSources(notePath: string): Promise<string[]> {
    return resolveDashboardLearningSources(this.app, notePath);
  }

  private semanticOperationsByTarget(): Map<string, SemanticOperationRecord> {
    const byTarget = new Map<string, SemanticOperationRecord>();
    for (const operation of this.plugin.semanticOperationsSnapshot()) {
      const target = dashboardPath(operation.target);
      if (!byTarget.has(target)) byTarget.set(target, operation);
      for (const source of operation.sources) {
        const path = dashboardPath(source);
        const generic = `${path}|${operation.kind}`;
        const contextual = semanticSourceOperationKey(
          path,
          operation.kind,
          operation.course,
          operation.project,
        );
        if (!byTarget.has(contextual)) byTarget.set(contextual, operation);
        if (!byTarget.has(generic)) byTarget.set(generic, operation);
      }
    }
    return byTarget;
  }

  private semanticOperationForNote(
    note: NoteSummary,
    operations: ReadonlyMap<string, SemanticOperationRecord>,
  ): SemanticOperationRecord | undefined {
    const path = dashboardPath(note.path);
    if (note.note_type !== "Source") return operations.get(path);
    if (note.purpose === "wiki") {
      return operations.get(semanticSourceOperationKey(
        path,
        "generate-wiki",
        note.course,
        note.project,
      )) ?? operations.get(`${path}|generate-wiki`);
    }
    if (note.purpose === "study") {
      return operations.get(semanticSourceOperationKey(
        path,
        "generate-study-guide",
        note.course,
        note.project,
      )) ?? operations.get(`${path}|generate-study-guide`) ??
        operations.get(semanticSourceOperationKey(
          path,
          "refresh-study-guide",
          note.course,
          note.project,
        )) ?? operations.get(`${path}|refresh-study-guide`);
    }
    return undefined;
  }

  private async runButtonAction(
    button: HTMLButtonElement,
    action: () => Promise<unknown>,
    refresh = false,
    success?: string,
  ): Promise<void> {
    const previousLabel = button.textContent ?? "";
    button.disabled = true;
    button.setAttr("aria-busy", "true");
    button.setText("正在处理…");
    try {
      await this.plugin.ensureLocalServiceAvailable();
      await action();
      if (success) new Notice(success);
      if (refresh) await this.render();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "操作失败", 10_000);
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.setText(previousLabel);
    }
  }

  private async cancelSemanticOperation(operationId: string): Promise<void> {
    await this.plugin.ensureLocalServiceAvailable();
    await this.api().cancelSemanticOperation(operationId);
    new Notice("已请求停止后台任务");
    await this.render(true);
  }

  private async openDaily(data: { daily: { path: string; exists: boolean } }): Promise<void> {
    if (data.daily.exists) {
      await this.openPath(data.daily.path);
      return;
    }
    const result = await this.plugin.createDaily();
    await this.openPath(result.path);
  }

  private async openPath(path: string): Promise<void> {
    await this.plugin.openVaultPath(path);
  }
}

/** A real Obsidian pane for a requested page absent from the Apex layout. */
export class OkfDashboardItemView extends ItemView {
  private section: Section;
  private workbenchPath: string | undefined;
  private surface: OkfDashboardView | undefined;

  public constructor(
    private readonly hostLeaf: WorkspaceLeaf,
    private readonly plugin: OkfBrainPlugin,
  ) {
    super(hostLeaf);
    this.section = plugin.getDashboardUiState().activeSection;
  }

  public getViewType(): string { return OKF_DASHBOARD_VIEW; }
  public getDisplayText(): string { return `工作台 · ${PAGE_COPY[this.section].title}`; }
  public getIcon(): string { return "brain-circuit"; }
  public getState(): Record<string, string> {
    return this.workbenchPath
      ? { section: this.section, workbenchPath: this.workbenchPath }
      : { section: this.section };
  }

  public async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const candidate = state && typeof state === "object"
      ? (state as Record<string, unknown>).section
      : undefined;
    if (typeof candidate !== "string" || !Object.hasOwn(PAGE_COPY, candidate)) return;
    const section = candidate as Section;
    const workbenchPath = typeof (state as Record<string, unknown>).workbenchPath === "string"
      ? (state as Record<string, string>).workbenchPath
      : undefined;
    if (section === this.section && workbenchPath === this.workbenchPath) return;
    this.section = section;
    this.workbenchPath = workbenchPath;
    if (this.surface) {
      await this.surface.onClose();
      this.surface = undefined;
      await this.mountSurface();
    }
  }

  public async onOpen(): Promise<void> {
    await this.mountSurface();
  }

  public async onClose(): Promise<void> {
    const surface = this.surface;
    this.surface = undefined;
    await surface?.onClose();
  }

  private async mountSurface(): Promise<void> {
    this.contentEl.empty();
    const container = this.contentEl.createDiv();
    const surface = new OkfDashboardView(this.hostLeaf, this.plugin, {
      container,
      initialSection: this.section,
      focused: true,
      workbenchPath: this.workbenchPath,
    });
    this.surface = surface;
    await surface.onOpen();
  }
}

function stripMarkdown(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/gu, "").replace(/[#*_\x60]/gu, "").trim();
}

function compactText(value: string, limit = 120): string {
  const text = stripMarkdown(value).replace(/\s+/gu, " ");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function relationName(path: string): string {
  const parts = path.replace(/^\/+|\/+$/gu, "").split("/");
  const file = (parts.at(-1) ?? path).replace(/\.md$/iu, "");
  if (["course", "project"].includes(file.toLocaleLowerCase()) && parts.length > 1) {
    return parts.at(-2) ?? file;
  }
  return file;
}

function dashboardPath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").toLocaleLowerCase();
}

function semanticSourceOperationKey(
  path: string,
  kind: SemanticOperationRecord["kind"],
  course: string | null | undefined,
  project: string | null | undefined,
): string {
  return [path, kind, dashboardPath(course ?? ""), dashboardPath(project ?? "")].join("|");
}

function learningScopeLabel(scope: LearningContextFilter): string {
  if (scope === "course") return "全部课程相关材料";
  if (scope === "project") return "全部项目相关材料";
  if (scope === "independent") return "独立学习";
  return "全部材料";
}

function learningContextLabel(
  note: NoteSummary,
  relationTitles: ReadonlyMap<string, string> = new Map<string, string>(),
): string {
  return dashboardLearningContexts(note).map((context) => {
    if (context === "course") {
      const folder = /^learning\/courses\/([^/]+)\//u.exec(note.path)?.[1];
      const course = note.course ?? (folder ? `learning/courses/${folder}/course.md` : undefined);
      return `课程 · ${relationTitles.get(dashboardPath(course ?? "")) ?? relationName(course ?? note.path)}`;
    }
    if (context === "project") {
      return `项目 · ${relationTitles.get(dashboardPath(note.project ?? "")) ?? relationName(note.project ?? "")}`;
    }
    return "独立学习";
  }).join(" · ");
}

export type ProjectLifecycleStatus = "active" | "paused" | "completed";
export interface ProjectStatusAction {
  status: ProjectLifecycleStatus;
  label: string;
}
type LearningWorkItemStatus = "pending" | "generating" | "failed" | "refreshing" | "ready" | "completed";

function projectLifecycleStatus(project: Pick<NoteSummary, "project_status">): ProjectLifecycleStatus {
  if (project.project_status === "paused" || project.project_status === "completed") {
    return project.project_status;
  }
  return "active";
}

function projectStatusLabel(status: ProjectLifecycleStatus): string {
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

function learningWorkItemStatus(
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

function learningWorkItemStatusLabel(
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

function courseStatusLabel(status: string | null | undefined): string {
  if (status === "paused") return "已暂停";
  if (status === "completed") return "已完成";
  return "进行中";
}

export function systemStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    configured: "已配置",
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

function systemStatusClass(status: string): string {
  const normalized = status.toLocaleLowerCase();
  if (["configured", "available", "current", "ok", "healthy"].includes(normalized)) {
    return "is-ok";
  }
  if (["failed", "unavailable"].includes(normalized)) return "is-error";
  return "is-warning";
}

function semanticStageLabel(operation: SemanticOperationRecord): string {
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

function conversionStatusLabel(conversion: ConversionRecord): string {
  if (hasPendingGeneration(conversion)) return conversion.error
    ? "转换已完成，生成入队失败；后台会重试，也可手动重试"
    : "转换已完成，等待生成入队";
  if (conversion.status === "queued") return "已排队";
  if (conversion.status === "converting") return `正在使用 ${conversion.parser} 转换`;
  if (conversion.status === "waiting-for-mineru") return "等待 MinerU；后台会自动重试";
  if (conversion.status === "ready") return "转换已完成，等待保存";
  if (conversion.stages?.conversion === "completed") return "转换已完成，保存需要处理";
  return "转换失败，需要处理";
}

function resourceHost(resource: string | null | undefined): string {
  if (!resource) return "";
  try {
    const url = new URL(resource);
    return ["http:", "https:"].includes(url.protocol) ? url.hostname : "";
  } catch {
    return "";
  }
}

function relativeMoment(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "";
  const moment = Date.parse(value);
  if (!Number.isFinite(moment)) return "";
  const elapsed = Math.max(0, now - moment);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return new Date(moment).toLocaleDateString();
}

function formatLocalTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString("zh-CN", { hour12: false });
}

function aiDailyMetadata(item: FeedDigestItem, suppressSource = false): string {
  const parts = [
    suppressSource ? "" : item.source_name || item.source,
    item.native_section,
    item.published_at,
    item.media_count ? `${item.media_count} 个媒体` : "",
  ].filter((value): value is string => Boolean(value));
  return [...new Set(parts)].join(" · ");
}

export function latestAiDailyEdition(
  digest: FeedDashboardDigest,
  section: AiDailyStream,
): FeedDigestEdition | undefined {
  return digest.ai_daily
    .filter((edition) => edition.section === section)
    .reduce<FeedDigestEdition | undefined>((latest, edition) =>
      !latest || edition.issued_at.localeCompare(latest.issued_at) > 0 ? edition : latest,
    undefined);
}

export function mergeSubscriptionEditions(
  current: readonly FeedDigestEdition[],
  incoming: readonly FeedDigestEdition[],
): FeedDigestEdition[] {
  const merged = [...current];
  const seen = new Set(current.map((edition) => edition.digest_id));
  for (const edition of incoming) {
    if (edition.section !== "learning" || seen.has(edition.digest_id)) continue;
    seen.add(edition.digest_id);
    merged.push(edition);
  }
  return merged;
}

export function mergeSubscriptionSources(
  current: readonly FeedSubscriptionSource[],
  incoming: readonly FeedSubscriptionSource[],
): FeedSubscriptionSource[] {
  const merged = [...current];
  const seen = new Set(current.map((source) => source.source_id));
  for (const source of incoming) {
    if (!source.source_id || seen.has(source.source_id)) continue;
    seen.add(source.source_id);
    merged.push(source);
  }
  return merged;
}

export function feedDecisionLabel(
  decision: FeedDigestItem["decision"],
): string {
  if (!decision) return "";
  return {
    "learn-now": "已选择学习",
    "learn-later": "待生成学习材料",
    "wiki-now": "已选择整理为知识笔记",
    "source-only": "已保存来源",
    ignore: "已忽略",
    later: "旧版稍后处理",
  }[decision];
}

export function feedSyncFailureMessage(results: readonly FeedSyncResult[]): string {
  const failures = results.filter((result) => result.status === "error");
  if (!failures.length) return "";
  const details = failures.map((failure) => {
    const label = failure.feed === "treehole"
      ? "树洞热榜"
      : failure.section === "hotspot" || failure.section === "news" || failure.section === "learning"
        ? aiDailyPreviewStreamTitle(failure.section)
        : failure.section || "每日资讯";
    return `${label}：${failure.detail}`;
  });
  return `部分内容同步失败（其他内容已更新）：${details.join("；")}`;
}

function formatFeedDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (!match) return value;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const prefix = year === new Date().getFullYear() ? "" : `${year}年`;
  return `${prefix}${month}月${day}日`;
}

export function treeholeMetadata(item: FeedDigestItem): string {
  const labels: Record<string, string> = {
    best_rank: "最高排名",
    peak_score: "热度",
    reply_count: "回复",
    favorite_count: "收藏",
    like_count: "点赞",
  };
  const order = ["best_rank", "peak_score", "reply_count", "favorite_count", "like_count"];
  const metrics = order
    .filter((key) => Object.prototype.hasOwnProperty.call(item.metrics, key))
    .map((key) => `${labels[key]} ${item.metrics[key]}`);
  if (item.comment_count) metrics.push(`评论 ${item.comment_count}`);
  if (item.media_count) metrics.push(`媒体 ${item.media_count}`);
  if (item.published_at) metrics.push(item.published_at);
  return metrics.join(" · ");
}

function humanizeFeedQuality(value: string): string {
  return value
    .replace(/observation[_-]gap/giu, "本期存在观测缺口")
    .replace(/partial/giu, "部分内容缺失")
    .replace(/degraded/giu, "采集质量下降")
    .replace(/[_-]+/gu, " ")
    .trim();
}

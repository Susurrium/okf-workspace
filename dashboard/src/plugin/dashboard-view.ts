import { TASK_VIEW_LABELS } from "../tasks/task-presentation.js";
import {
  projectLifecycleStatus,
  projectStatusLabel,
  projectStatusActions,
  learningWorkItemStatus,
  learningWorkItemStatusLabel,
  courseStatusLabel,
  systemStatusLabel,
  systemStatusClass,
  semanticStageLabel,
  conversionMethodLabel,
  conversionStatusLabel,
  type ProjectLifecycleStatus,
} from "../domain/workspace-status.js";
import {
  resourceHost,
  relativeMoment,
  formatLocalTimestamp,
} from "../ui/display-format.js";
import {
  aiDailyMetadata,
  latestAiDailyEdition,
  mergeSubscriptionEditions,
  mergeSubscriptionSources,
  feedDecisionLabel,
  feedSyncFailureMessage,
  formatFeedDate,
  treeholeMetadata,
  humanizeFeedQuality,
} from "../domain/feed-presentation.js";

import { noteTypeLabel, captureDestinationLabel } from "../ui/display-labels.js";
import { ItemView, Notice, TFile, WorkspaceLeaf, parseLinktext, type App, type ViewStateResult } from "obsidian";
import { parse as parseYaml } from "yaml";
import {
  collectVaultTasks,
  invalidatePath,
  toggleTaskInFile,
  indexTasksByDay,
  toIsoDate,
  type VaultTask,
} from "../../apex/src/alltasks-scan.js";

import { LocalApi } from "../api/client.js";
import { renderTaskCatalog as renderTaskCatalogSurface } from "../tasks/task-catalog.js";
import { renderTaskRow } from "../tasks/task-row.js";
import { ObjectDetailsModal } from "../ui/object-details-modal.js";
import { renderSyncedImports } from "./synced-imports-modal.js";
import type {
  ConversionRecord,
  CourseSummary,
  NoteSummary,
  ProjectSummary,
  SemanticOperationRecord,
  TaskItem,
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
import { methodLabels } from "../imports/types.js";
import type { ImportOrigin } from "./document-import-modal.js";
import { DASHBOARD_VERSION } from "../version.js";
import type OkfBrainPlugin from "./main.js";
import {
  DASHBOARD_FEEDS,
  normalizeDashboardUiState,
  type DashboardFeed,
  type DashboardPageUiStatePatch,
  type DashboardSection as StoredDashboardSection,
} from "./dashboard-ui-state.js";
import { readWorkbenchSectionConfig, noteMatchesSectionContext, operationMatchesSectionContext, sectionScopeLabel, sectionSupportsSort,
  type WorkbenchSectionConfig } from "../features/workbench/section-config.js";
import { normalizedVaultPath } from "../domain/note-identity.js";
import { renderNoteRow } from "../../apex/src/note-row.js";
import { renderTaskCheckbox } from "../../apex/src/task-checkbox.js";
import { runUiAction } from "../ui/async-action.js";
import { conversionRecovery, semanticOperationActions, conversionIsRunning, conversionHasFailure } from "../domain/operation-presentation.js";
import { renderMaterialDecision } from "../ui/material-decision.js";
import { originalReference } from "../imports/original-references.js";
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

export type DashboardSection = StoredDashboardSection;
type Section = DashboardSection;

export interface EmbeddedDashboardSurfaceOptions {
  /** Mount the complete OKF surface inside an Apex custom section. */
  container?: HTMLElement;
  /** The page represented by the containing Apex section. */
  initialSection?: DashboardSection;
  /** Apex already owns the outer section navigation and chrome. */
  embedded?: boolean;
  headerActions?: HTMLElement;
  sectionActions?: import("../../apex/src/section-actions.js").SectionActions;
  /** A separate page for sections absent from the current Apex workbench. */
  focused?: boolean;
  /** Apex board to return to when a focused page was opened from a card. */
  workbenchPath?: string;
  config?: Record<string, unknown>;
  instanceKey?: string;
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
  { id: "tasks", label: "任务" },
  { id: "inbox", label: "收集箱" },
  { id: "reading", label: "订阅阅读" },
  { id: "sources", label: "资料" },
  { id: "learning", label: "学习" },
  { id: "projects", label: "项目" },
  { id: "knowledge", label: "知识笔记" },
  { id: "life", label: "日记与复盘" },
  { id: "system", label: "后台与诊断" },
];

const PAGE_COPY: Readonly<Record<Section, { title: string; description: string }>> = {
  today: { title: "今天", description: "现在值得处理、继续和阅读的内容。" },
  tasks: { title: "任务", description: "安排笔记中的任务，查看状态、循环、依赖与历史。" },
  inbox: { title: "收集箱", description: "整理尚未确定去向的记录与资料用途。" },
  reading: { title: "订阅阅读", description: "浏览来源、最新一期与历史，明确选择资料用途。" },
  sources: { title: "资料", description: "查找已保存资料、原件、正文、用途与关联成果。" },
  learning: { title: "学习", description: "继续学习，或准备下一份学习笔记。" },
  projects: { title: "项目", description: "聚焦进行中项目的状态和下一步行动。" },
  knowledge: { title: "知识笔记", description: "搜索、阅读和维护知识笔记与知识导航。" },
  life: { title: "日记与复盘", description: "书写今天，回看日记、反思与周期复盘。" },
  system: { title: "后台与诊断", description: "查看执行进度、恢复失败并检查运行环境。" },
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
  private readonly sectionActions?: import("../../apex/src/section-actions.js").SectionActions;
  private surfaceControls?: HTMLElement;
  private readonly focused: boolean;
  private readonly workbenchPath: string | undefined;
  private readonly initialSection: Section;
  private readonly instanceKey: string | undefined;
  private rawConfig: Record<string, unknown>;
  private config: WorkbenchSectionConfig;
  private readonly pagination = new Map<string, number>();
  private paginationIndex = 0;
  private readonly detailsState = new Map<string, boolean>();
  private section: Section = "today";
  private taskCenterOpen = false;
  private systemTab: "processing" | "diagnostics" = "processing";
  private todayPane: TodayPane = "actions";
  private learningTab: "pending" | "active" | "completed" | "all" = "active";
  private learningQuery = "";
  private learningContext: LearningContextFilter = "all";
  private learningRelationPath = "";
  private inboxTab: "decision" | "progress" = "decision";
  private projectsTab: "active" | "paused" | "completed" | "all" = "active";
  private projectQuery = "";
  private knowledgeFilter: "all" | "pending" | "wiki" | "map" | "unverified" | "stale" | "deprecated" = "all";
  private knowledgeQuery = "";
  private sourceQuery = "";
  private sourcePurpose = "all";
  private taskQuery = "";
  private lifeQuery = "";
  private lifeType = "all";
  private lifeFrom = "";
  private lifeTo = "";
  private knowledgeType = "all";
  private knowledgeStatus = "all";
  private knowledgeMaintenance = "all";
  private inboxIngestedVia: IngestedViaFilter = "all";
  private readonly selectedCaptures = new Set<string>();
  private readonly pageScroll = new Map<Section, number>();
  private readonly feedScroll: Partial<Record<DashboardFeed, number>> = {};
  private readonly feedScrollEdition: Partial<Record<DashboardFeed, string>> = {};
  private readonly feedScrollPersistTimers: Partial<Record<DashboardFeed, number>> = {};
  private readonly dirtyFeedScroll = new Set<DashboardFeed>();
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
  private objectDetails: ObjectDetailsModal | undefined;
  private readonly vaultReader: VaultDashboardReader;
  private systemCache: SystemStatus | undefined;
  private renderVersion = 0;
  private closed = false;
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
    this.sectionActions = options.sectionActions;
    this.focused = options.focused ?? false;
    this.workbenchPath = options.workbenchPath;
    this.instanceKey = options.instanceKey;
    this.rawConfig = { ...options.config };
    this.config = readWorkbenchSectionConfig(this.rawConfig, this.embedded ? "workbench" : "page");
    this.vaultReader = new VaultDashboardReader(this.app);
    const stored = this.plugin.getDashboardUiState();
    const initial = options.initialSection ?? stored.activeSection;
    const incoming = this.rawConfig.viewState ?? (!this.instanceKey || !stored.instances?.[this.instanceKey] ? this.rawConfig.initialView : undefined);
    const page = incoming && typeof incoming === "object" && !Array.isArray(incoming)
      ? normalizeDashboardUiState({ pages: { [initial]: incoming } }).pages[initial]
      : this.instanceKey ? stored.instances?.[this.instanceKey] : undefined;
    const state = { ...stored, pages: { ...stored.pages,
      ...(page ? { [initial]: page } : this.instanceKey && Object.keys(this.rawConfig).length
        ? { [initial]: { scrollTop: 0, filters: {} } } : {}) } };
    for (const [key, value] of Object.entries(state.pages[initial].filters)) {
      if (key.startsWith("details:") && typeof value === "boolean") this.detailsState.set(key.slice(8), value);
      if (key.startsWith("loaded:") && typeof value === "number") this.pagination.set(key.slice(7), value);
    }
    const sort = state.pages[initial].filters.sort;
    if (sort === "title" || sort === "modified") this.config.sort = sort;
    if (initial === "tasks" && typeof state.pages.tasks.filters.taskView === "string") {
      this.rawConfig.taskView = state.pages.tasks.filters.taskView;
      for (const key of ["savedViewId", "savedViewName"]) if (typeof state.pages.tasks.filters[key] === "string") this.rawConfig[key] = state.pages.tasks.filters[key];
      if (typeof state.pages.tasks.filters.taskViewFolders === "string") this.rawConfig.taskViewFolders = JSON.parse(state.pages.tasks.filters.taskViewFolders);
      this.config = readWorkbenchSectionConfig(this.rawConfig, this.embedded ? "workbench" : "page");
    }
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
    const learningTab = page?.tab ?? this.rawConfig.learningTab ?? state.pages.learning.tab;
    if (learningTab === "pending" || learningTab === "active" || learningTab === "completed" || learningTab === "all") {
      this.learningTab = learningTab;
    }
    this.learningQuery = String(state.pages.learning.filters.query ?? "");
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
    const projectsTab = state.pages.projects.tab ?? (this.config.statuses?.length === 1 ? this.config.statuses[0] : undefined);
    if (projectsTab === "active" || projectsTab === "paused" || projectsTab === "completed" || projectsTab === "all") {
      this.projectsTab = projectsTab;
    }
    this.projectQuery = String(state.pages.projects.filters.query ?? "");
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
    const selectedSourceId = page?.filters.sourceId ?? this.rawConfig.readingSourceId ?? state.pages.reading.filters.sourceId;
    if (typeof selectedSourceId === "string" && selectedSourceId) {
      this.selectedSubscriptionSource = { source_id: selectedSourceId,
        source_name: String(state.pages.reading.filters.sourceName ?? selectedSourceId) };
      const overviewScroll = state.pages.reading.filters.overviewScroll;
      if (typeof overviewScroll === "number" && Number.isFinite(overviewScroll)) this.readingOverviewScroll = Math.max(0, overviewScroll);
    }
    if (typeof subscriptionSourceQuery === "string") {
      this.subscriptionSourceQuery = subscriptionSourceQuery.trim();
    }
    const ingestion = state.pages.inbox.filters.ingestedVia;
    const readingView = state.pages.reading.filters.readingView;
    if (!this.rawConfig.scene && (readingView === "subscriptions" || readingView === "daily-updates")) this.config.readingView = readingView;
    this.sourceQuery = String(state.pages.sources.filters.query ?? "");
    this.sourcePurpose = String(state.pages.sources.filters.purpose ?? "all");
    this.taskQuery = String(page?.filters.taskQuery ?? this.rawConfig.taskSearch ?? state.pages.tasks.filters.taskQuery ?? "");
    this.lifeQuery = String(state.pages.life.filters.query ?? "");
    this.lifeType = String(state.pages.life.filters.type ?? "all");
    this.lifeFrom = String(state.pages.life.filters.from ?? "");
    this.lifeTo = String(state.pages.life.filters.to ?? "");
    this.knowledgeType = String(state.pages.knowledge.filters.noteType ?? "all");
    this.knowledgeStatus = String(state.pages.knowledge.filters.contentStatus ?? "all");
    this.knowledgeMaintenance = String(state.pages.knowledge.filters.maintenance ?? "all");
    if (["wiki", "map"].includes(this.knowledgeFilter)) {
      this.knowledgeType = this.knowledgeFilter === "wiki" ? "Wiki" : "Wiki Map";
      this.knowledgeFilter = "all";
    } else if (["unverified", "stale"].includes(this.knowledgeFilter)) {
      this.knowledgeMaintenance = this.knowledgeFilter;
      this.knowledgeFilter = "all";
    } else if (this.knowledgeFilter === "deprecated") {
      this.knowledgeStatus = "deprecated";
      this.knowledgeFilter = "all";
    }
    this.systemTab = (page?.tab ?? this.rawConfig.systemTab ?? state.pages.system.tab) === "diagnostics" ? "diagnostics" : "processing";
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

  private updatePageState(section: Section, patch: DashboardPageUiStatePatch): void {
    this.plugin.updateDashboardPageUiState(section, patch, section === this.initialSection ? this.instanceKey : undefined);
  }

  public navigationConfig(): Record<string, unknown> {
    const state = this.plugin.getDashboardUiState();
    const storedPage = this.instanceKey ? state.instances?.[this.instanceKey] : state.pages[this.section];
    const filters = { ...storedPage?.filters };
    const current = this.section;
    if (sectionSupportsSort(current)) filters.sort = this.config.sort;
    if (current === "learning") Object.assign(filters, { query: this.learningQuery, context: this.learningContext, relation: this.learningRelationPath });
    if (current === "projects") filters.query = this.projectQuery;
    if (current === "sources") Object.assign(filters, { query: this.sourceQuery, purpose: this.sourcePurpose });
    if (current === "knowledge") Object.assign(filters, { query: this.knowledgeQuery, view: this.knowledgeFilter,
      noteType: this.knowledgeType, contentStatus: this.knowledgeStatus, maintenance: this.knowledgeMaintenance });
    if (current === "inbox") filters.ingestedVia = this.inboxIngestedVia;
    if (current === "life") Object.assign(filters, { query: this.lifeQuery, type: this.lifeType, from: this.lifeFrom, to: this.lifeTo });
    if (current === "reading") Object.assign(filters, { query: this.subscriptionSourceQuery,
      sourceId: this.selectedSubscriptionSource?.source_id ?? "", sourceName: this.selectedSubscriptionSource?.source_name ?? "", overviewScroll: this.readingOverviewScroll, readingView: this.config.readingView });
    if (current === "tasks") Object.assign(filters, { taskQuery: this.taskQuery, taskView: this.config.taskView });
    for (const [key, value] of this.pagination) filters[`loaded:${key}`] = value;
    const tab = current === "learning" ? this.learningTab : current === "projects" ? this.projectsTab
      : current === "inbox" ? this.inboxTab : current === "system" ? this.systemTab : current === "today" ? this.todayPane : storedPage?.tab;
    const values: Record<string, unknown> = {};
    if (current === "tasks") {
      for (const key of ["taskStatus", "taskPriority", "taskSort", "taskGroupBy", "taskQueryDraft", "taskShown"]) if (filters[key] !== undefined) values[key] = filters[key];
      if (filters.taskAdvancedQuery !== undefined) values.taskQuery = filters.taskAdvancedQuery;
      values.taskSearch = this.taskQuery;
    }
    return { ...this.rawConfig, ...values,
      ...(sectionSupportsSort(current) ? { sort: this.config.sort } : {}),
      ...(current === "reading" ? { readingView: this.config.readingView, readingSourceId: this.selectedSubscriptionSource?.source_id ?? "" } : {}),
      ...(current === "learning" ? { learningTab: this.learningTab } : {}),
      ...(current === "system" ? { systemTab: this.systemTab } : {}),
      viewState: { filters, tab, scrollTop: this.contentEl.scrollTop ?? 0 } };
  }

  private scopeNotes<T extends NoteSummary>(notes: readonly T[]): T[] {
    const paths = this.rawConfig.notePaths;
    if (paths !== undefined && (!Array.isArray(paths) || paths.some(path => typeof path !== "string"))) throw new Error("目录条目范围必须为笔记路径列表");
    const allowed = paths ? new Set((paths as string[]).map(normalizedVaultPath)) : undefined;
    return notes.filter(note => noteMatchesSectionContext(note, this.config) && (!allowed || ["Course", "Project"].includes(note.note_type) || allowed.has(normalizedVaultPath(note.path))));
  }

  private displayNotes<T extends NoteSummary>(notes: readonly T[]): T[] {
    const sorted = [...notes].sort(this.config.sort === "title"
      ? (left, right) => left.title.localeCompare(right.title, "zh-CN")
      : (left, right) => (right.modified_at ?? "").localeCompare(left.modified_at ?? ""));
    return sorted;
  }

  private scopedProjectRelations(project: ProjectSummary): ProjectSummary {
    if (!this.config.course) return project;
    const matches = (note: NoteSummary) => noteMatchesSectionContext(note, { course: this.config.course, project: project.path });
    return { ...project, pending_captures: project.pending_captures.filter(matches),
      related_learning: project.related_learning.filter(matches), related_materials: project.related_materials.filter(matches) };
  }

  private scopedCourseRelations(course: CourseSummary): CourseSummary {
    if (!this.config.project) return course;
    if (course.guide_count && !course.related_learning || course.lesson_count && !course.lessons) throw new Error('课程投影缺少关联条目，无法计算当前范围');
    const matches = (note: NoteSummary) => noteMatchesSectionContext(note, { course: course.path, project: this.config.project });
    const learning = (course.related_learning ?? []).filter(matches);
    const lessons = (course.lessons ?? []).filter(matches);
    return { ...course, pending_captures: course.pending_captures.filter(matches), related_sources: course.related_sources.filter(matches),
      related_learning: learning, lessons, guide_count: learning.length, lesson_count: lessons.length, latest_lesson: lessons[0] };
  }

  private async validateScope(): Promise<void> {
    for (const path of [this.config.course, this.config.project].filter((value): value is string => Boolean(value))) {
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
        throw new Error(`分区绑定笔记未到达或已删除，已保留范围：${path}`);
      }
    }
  }

  public getDisplayText(): string {
    return "工作台";
  }

  public getIcon(): string {
    return "brain-circuit";
  }

  public async onOpen(): Promise<void> {
    this.closed = false;
    this.readingSourceItemsRequestsCancelled = false;
    this.contentEl.addEventListener("scroll", this.handlePageScroll, { passive: true });
    this.contentEl.addEventListener("pointerdown", this.markDashboardInteraction, { passive: true });
    this.contentEl.addEventListener("keydown", this.markDashboardInteraction);
    await this.render();
  }

  public async onClose(): Promise<void> {
    this.closed = true;
    this.renderVersion += 1;
    this.objectDetails?.close();
    this.objectDetails = undefined;
    this.surfaceControls?.remove();
    this.surfaceControls = undefined;
    this.captureDetailsState();
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
      if (scrollTop !== undefined && this.dirtyFeedScroll.has(kind)) {
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
    this.updatePageState(this.section, { scrollTop });
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
      this.updatePageState(this.section, { scrollTop: root.scrollTop });
    }
    const previousScroll = this.pageScroll.get(this.section) ?? 0;
    this.captureDetailsState();
    this.destroyActionPanels();
    root.empty();
    this.surfaceControls?.remove();
    this.surfaceControls = undefined;
    root.addClass("okf-dashboard");
    root.toggleClass("okf-dashboard--embedded", this.embedded);
    root.toggleClass("okf-dashboard--focused", this.focused);
    this.paginationIndex = 0;
    if (!this.embedded) {
      const topbar = root.createDiv({ cls: "okf-dashboard__topbar" });
      if (this.focused) {
        const back = topbar.createEl("button", {
          text: this.plugin.canReturnToPreviousDashboardPage?.(this.contentEl) ? "返回上一页" : "返回工作台",
          cls: "okf-dashboard__ghost-action",
          attr: { type: "button" },
        });
        back.addEventListener("click", () => void this.plugin.returnToPreviousDashboardPage(this.workbenchPath, this.contentEl));
        if (this.plugin.canReturnToPreviousDashboardPage?.(this.contentEl)) topbar.createEl("button", { text: "工作台", attr: { type: "button" } })
          .addEventListener("click", () => void this.plugin.returnToOkfWorkbench(this.workbenchPath));
        const pages = topbar.createEl("select", { attr: { "aria-label": "工作区功能" } });
        for (const item of NAVIGATION) pages.createEl("option", { text: item.label, attr: { value: item.id } });
        pages.value = this.section;
        pages.addEventListener("change", () => this.openSection(pages.value as Section));
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
      const create = utilities.createEl("button", {
        text: "快捷操作",
        cls: "okf-dashboard__ghost-action",
        attr: { type: "button", "aria-label": "快捷操作" },
      });
      create.addEventListener("click", () => this.plugin.promptActionMenu());
      this.renderBackgroundTasks(utilities);
    }
    const body = root.createDiv({ cls: "okf-dashboard__body" });
    if (!this.embedded) {
      const pageHeader = body.createDiv({ cls: "okf-dashboard__page-header" });
      const pageCopy = this.section === "reading" && this.config.readingView === "daily-updates"
        ? { title: "每日更新", description: "浏览中国热点、AI 资讯和树洞热榜的最新内容。" }
        : PAGE_COPY[this.section];
      const heading = pageHeader.createDiv();
      heading.createEl("h2", { text: pageCopy.title });
      heading.createDiv({ cls: "okf-dashboard__muted", text: pageCopy.description });
      if (this.focused) {
        const add = pageHeader.createEl("button", {
          text: "添加到当前工作台",
          cls: "okf-dashboard__secondary-action",
          attr: { type: "button" },
        });
        add.addEventListener("click", () => {
          void this.plugin.addOkfSectionToActiveWorkbench(this.section, this.workbenchPath, this.navigationConfig())
            .catch((error: unknown) => new Notice(error instanceof Error ? error.message : "添加卡片失败"));
        });
      }
    }
    const loading = body.createDiv({ cls: "okf-dashboard__loading", text: "正在读取本地笔记…" });
    try {
      await this.validateScope();
      this.renderSurfaceControls(body);
      if (this.section === "tasks" || this.section === "today" && this.config.taskView !== "overview") await this.renderTaskCatalog(body);
      else if (this.section === "today") await this.renderToday(body);
      else if (this.section === "inbox") await this.renderInbox(body);
      else if (this.section === "reading") await this.renderReading(body);
      else if (this.section === "sources") await this.renderSources(body);
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
        for (const details of root.querySelectorAll<HTMLDetailsElement>("details")) {
          const key = details.dataset.stateKey;
          if (key && this.detailsState.has(key)) details.open = this.detailsState.get(key)!;
        }
        root.scrollTop = previousScroll;
        this.lastRenderAt = Date.now();
      }
    }
  }

  private captureDetailsState(): void {
    const filters: Record<string, boolean> = {};
    for (const details of this.contentEl.querySelectorAll<HTMLDetailsElement>("details")) {
      const key = details.dataset.stateKey;
      if (!key) continue;
      this.detailsState.set(key, details.open);
      filters[`details:${key}`] = details.open;
    }
    if (Object.keys(filters).length) this.updatePageState(this.section, { filters });
  }

  private renderSurfaceControls(parent: HTMLElement): void {
    const controls = parent.createDiv({ cls: "okf-surface-controls" });
    this.surfaceControls = controls;
    const restrictions = [this.config.statuses ? `项目状态：${this.config.statuses.map(value => projectStatusLabel(value as ProjectLifecycleStatus)).join("、") || "未选择"}` : "",
      Array.isArray(this.rawConfig.folders) ? `文件夹：${this.rawConfig.folders.join("、")}` : "",
      Array.isArray(this.rawConfig.excludeFolders) ? `排除：${this.rawConfig.excludeFolders.join("、")}` : "",
      Array.isArray(this.rawConfig.notePaths) ? `指定对象：${this.rawConfig.notePaths.length} 项` : ""].filter(Boolean);
    if (this.config.course || this.config.project || restrictions.length) {
      const label = [this.config.course || this.config.project ? sectionScopeLabel(this.config, this.relationTitlesForNote(this.config)) : "", ...restrictions].filter(Boolean).join(" · ");
      controls.createSpan({ cls: "okf-dashboard__muted", text: label,
        attr: { title: label } });
      if (!this.embedded) for (const key of ["course", "project", "statuses", "folders", "excludeFolders", "notePaths"] as const) {
        if (this.rawConfig[key] === undefined) continue;
        const names = { course: "课程", project: "项目", statuses: "项目状态", folders: "文件夹", excludeFolders: "排除文件夹", notePaths: "指定对象" };
        controls.createEl("button", { text: `取消${names[key]}范围`, attr: { type: "button" } }).addEventListener("click", () => {
          delete this.rawConfig[key];
          const sort = this.config.sort;
          this.config = readWorkbenchSectionConfig(this.rawConfig, "page");
          this.config.sort = sort;
          if (key === "course" || key === "project") {
            this.learningContext = "all";
            this.learningRelationPath = "";
            this.updatePageState(this.section, { filters: { context: "all", relation: "" } });
          }
          void this.render(true);
        });
      }
    }
    if (sectionSupportsSort(this.section)) {
      const field = controls.createEl("label", { cls: "okf-section-controls__sort" });
      field.createSpan({ text: "排序" });
      const select = field.createEl("select", { attr: { "aria-label": "目录排序" } });
      select.createEl("option", { text: "最近更新", attr: { value: "modified" } });
      select.createEl("option", { text: "标题", attr: { value: "title" } });
      select.value = this.config.sort;
      select.addEventListener("change", () => {
        this.config.sort = select.value as WorkbenchSectionConfig["sort"];
        this.updatePageState(this.section, { filters: { sort: select.value } });
        void this.render(true);
      });
    }
    if (this.embedded && this.sectionActions) {
      this.sectionActions.set({ id: "open", label: "在新标签页打开当前视图", icon: "external-link", run: () => this.expandCurrentSection() });
      if (this.section !== "system") this.sectionActions.set({ id: "refresh", label: "刷新视图", icon: "refresh-cw", run: () => this.render(true) });
    } else if (this.embedded) {
      const expand = controls.createEl("button", { text: "在新标签页打开", attr: { type: "button" } });
      expand.addEventListener("click", () => this.expandCurrentSection());
    }
    if (!this.sectionActions && this.section !== "system") {
      const refresh = controls.createEl("button", { text: "刷新", attr: { type: "button" } });
      refresh.addEventListener("click", () => void this.render(true));
    }
  }

  private relationTitlesForNote(note: { course?: string | null; project?: string | null }): Map<string, string> {
    const titles = new Map<string, string>();
    for (const path of [note.course, note.project]) {
      if (!path) continue;
      const normalized = dashboardPath(path);
      const file = this.app.vault.getAbstractFileByPath(normalized);
      if (!(file instanceof TFile)) continue;
      const title = this.app.metadataCache?.getFileCache(file)?.frontmatter?.title;
      if (typeof title === "string" && title.trim()) titles.set(normalized, title.trim());
    }
    return titles;
  }

  private expandCurrentSection(section: Section = this.section): void {
    const state = this.plugin.getDashboardUiState();
    const page = this.instanceKey ? state.instances?.[this.instanceKey] : state.pages[this.section];
    const key = this.instanceKey ? (this.embedded ? `${this.instanceKey}:expanded` : this.instanceKey) : undefined;
    if (key && page) this.plugin.updateDashboardPageUiState(section, { ...page, scrollTop: 0 }, key);
    void this.plugin.navigateToOkfSection(section, this.contentEl, this.workbenchPath,
      this.navigationConfig(), key);
  }

  private pageItems<T>(parent: HTMLElement, items: readonly T[], renderItem: (parent: HTMLElement, item: T) => void,
    _expandSection: Section | false = this.section): void {
    const key = `${this.section}:${this.paginationIndex++}`;
    let shown = Math.max(this.config.limit, this.pagination.get(key) ?? 0);
    const renderRows = (from: number, to: number): void => {
      for (const item of items.slice(from, to)) renderItem(parent, item);
    };
    renderRows(0, shown);
    if (items.length <= shown) return;
    const more = parent.createEl("button", { text: "加载更多",
      cls: "okf-dashboard__ghost-action", attr: { type: "button" } });
    more.addEventListener("click", () => {
      more.remove();
      renderRows(shown, shown + this.config.limit);
      shown += this.config.limit;
      this.pagination.set(key, shown);
      this.updatePageState(this.section, { filters: { [`loaded:${key}`]: shown } });
      if (shown < items.length) parent.appendChild(more);
    });
  }

  private renderBackgroundTasks(parent: HTMLElement, forceOpen = false): void {
    const inScope = (item: { course?: string | null; project?: string | null }): boolean => operationMatchesSectionContext(item, this.config);
    const operations = [...this.plugin.semanticOperationsSnapshot()].filter(inScope);
    const conversions = [...this.plugin.conversionSnapshot()].filter(inScope);
    const active = operations.filter((operation) => isSemanticOperationActive(operation.status));
    const interrupted = operations.filter((operation) => operation.status === "orphaned");
    const activeConversions = conversions.filter((conversion) =>
      ["queued", "converting", "waiting-for-mineru", "waiting-for-parser", "ready"].includes(conversion.status)
      || hasPendingGeneration(conversion),
    );
    const recentCutoff = Date.now() - 30 * 60_000;
    const recent = operations
      .filter((operation) =>
        ["completed", "failed", "cancelled"].includes(operation.status) &&
        (forceOpen || operation.status === "failed" || Date.parse(operation.updated_at) >= recentCutoff),
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, forceOpen ? operations.length : 2);
    const recentConversions = conversions
      .filter((conversion) =>
        ["imported", "failed"].includes(conversion.status) &&
        !hasPendingGeneration(conversion) &&
        (forceOpen || conversion.status === "failed" || Date.parse(conversion.updated_at ?? "") >= recentCutoff),
      )
      .slice(0, forceOpen ? conversions.length : 2);
    if (
      !active.length &&
      !interrupted.length &&
      !recent.length &&
      !activeConversions.length &&
      !recentConversions.length
    ) {
      if (forceOpen) parent.createDiv({ cls: "okf-dashboard__empty", text: "当前没有后台操作记录。" });
      return;
    }
    const running = active.length + activeConversions.filter(conversionIsRunning).length;
    const pendingSave = activeConversions.filter(item => item.status === "ready" || hasPendingGeneration(item)).length;
    const failed = operations.filter((item) => ["failed", "orphaned"].includes(item.status)).length +
      conversions.filter(conversionHasFailure).length;
    const toggle = parent.createEl("button", {
      cls: `okf-dashboard__task-toggle${running ? " is-running" : ""}${failed ? " is-error" : ""}`,
      text: failed ? `处理异常 ${failed}` : running ? `后台处理 ${running}` : pendingSave ? `待保存或入队 ${pendingSave}` : "最近处理",
      attr: {
        type: "button",
        "aria-expanded": String(this.taskCenterOpen),
      },
    });
    toggle.addEventListener("click", () => {
      this.taskCenterOpen = !this.taskCenterOpen;
      void this.render(true);
    });
    if (forceOpen) toggle.remove();
    if (!this.taskCenterOpen && !forceOpen) return;
    const center = parent.createEl("section", { cls: forceOpen ? "okf-dashboard__operation-list" : "okf-dashboard__task-center is-open" });
    const close = center.createEl("button", { cls: "okf-dashboard__task-close", text: "收起" });
    close.addEventListener("click", () => {
      this.taskCenterOpen = false;
      void this.render(true);
    });
    if (forceOpen) close.remove();
    const heading = center.createDiv({ cls: "okf-dashboard__section-heading" });
    heading.createEl("h3", { text: "后台处理" });
    heading.createDiv({
      cls: "okf-dashboard__muted",
      text: running
        ? `${running} 个任务正在处理；切换页面不会中断`
        : failed
          ? `${failed} 个任务需要处理`
          : pendingSave ? `${pendingSave} 项等待保存或生成入队` : "最近完成",
    });
    const list = center.createDiv({ cls: "okf-dashboard__cards" });
    this.pageItems(list, [...active, ...interrupted, ...recent], (parent, operation) => {
      const card = parent.createDiv({ cls: "okf-dashboard__card" });
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
      card.createEl("button", { text: "处理详情", attr: { type: "button" } }).addEventListener("click", () => this.openProcessingDetails(operation));
      if (operation.actual_reads.length) {
        const reads = card.createEl("details");
        reads.dataset.stateKey = `operation:${operation.operation_id}:reads`;
        reads.createEl("summary", { text: "实际读取来源" });
        for (const path of operation.actual_reads) reads.createEl("button", { text: path, attr: { type: "button" } })
          .addEventListener("click", () => void this.openPath(path));
      }
      if (
        operation.status === "completed" ||
        this.app.vault.getAbstractFileByPath(operation.target) instanceof TFile
      ) {
        const open = card.createEl("button", {
          text: operation.status === "completed" ? "打开结果" : "打开已有目标笔记",
        });
        open.addEventListener("click", () => void this.openPath(operation.target));
      }
      if (semanticOperationActions(operation).cancel) {
        const cancel = card.createEl("button", { text: "取消后台任务" });
        cancel.addEventListener("click", () => {
          void this.runButtonAction(
            cancel,
            () => this.api().cancelSemanticOperation(operation.operation_id),
            true,
            "已请求停止后台任务",
          );
        });
      } else if (semanticOperationActions(operation).retry) {
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
    }, "system");
    this.pageItems(list, [...activeConversions, ...recentConversions], (parent, conversion) => {
      const card = parent.createDiv({ cls: "okf-dashboard__card" });
      card.createEl("strong", { text: `文档导入 · ${conversion.source_filename}` });
      card.createEl("button", { text: "处理详情", attr: { type: "button" } }).addEventListener("click", () => this.openProcessingDetails(conversion));
      const readyToPublish = conversionRecovery(conversion) === "publish";
      const label = hasPendingGeneration(conversion)
        ? conversionStatusLabel(conversion)
        : conversion.status === "queued"
          ? "已排队"
          : conversion.status === "converting"
            ? `正在使用 ${conversionMethodLabel(conversion)} 转换`
            : conversion.status === "waiting-for-mineru"
              ? "等待 MinerU"
              : conversion.status === "waiting-for-parser"
                ? "等待转换服务"
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
      const diagnostics = card.createEl("details");
      diagnostics.dataset.stateKey = `conversion:${conversion.conversion_id}`;
      diagnostics.createEl("summary", { text: "执行详情" });
      for (const [stage, status] of Object.entries(conversion.stages ?? {})) diagnostics.createDiv({ text: `${stage} · ${status}` });
      for (const attempt of conversion.parser_attempts ?? []) diagnostics.createDiv({ text:
        `${attempt.method ? methodLabels[attempt.method] : attempt.parser} · ${attempt.status} · ${attempt.duration_ms} ms${attempt.error ? ` · ${attempt.error}` : ""}` });
      const target = conversion.outputs.source_text ?? conversion.outputs.source;
      if (target) {
        const open = card.createEl("button", { text: conversion.outputs.source_text ? "打开转换正文" : "打开资料卡" });
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
      if (conversion.status !== "converting") this.renderConversionMethodActions(card, conversion);
    }, "system");
  }

  private renderDocumentDropZone(
    parent: HTMLElement,
    relation: Pick<DocumentImportOptions, "course" | "project">,
    origin: ImportOrigin,
  ): void {
    const zone = parent.createDiv({
      cls: "okf-document-drop okf-dashboard__document-drop",
      text: "导入资料",
      attr: { role: "button", tabindex: "0", "aria-label": this.plugin.isMobile ? "选择资料" : "导入文件或文件夹" },
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
    zone.setAttribute("title", "可点击选择，或拖入文件和文件夹");
  }

  private async renderToday(container: HTMLElement): Promise<void> {
    const [data, inbox, vaultTasks] = await Promise.all([
      this.vaultReader.today(),
      this.vaultReader.inbox(),
      this.collectFormalTasks(),
    ]);
    if (this.closed || !container.isConnected) return;
    data.tasks = data.tasks.filter((task) => this.taskMatchesContext(task));
    data.active_projects = this.scopeNotes(data.active_projects);
    data.active_courses = this.scopeNotes(data.active_courses);
    data.recent_study = this.scopeNotes(data.recent_study);
    data.stale_knowledge = this.scopeNotes(data.stale_knowledge);
    if (this.config.course || this.config.project) {
      if (!data.pending_study || !data.pending_wiki) throw new Error("当前概览缺少用途条目，无法计算绑定范围的数量");
      data.pending_study_count = this.scopeNotes(data.pending_study).length;
      data.pending_wiki_count = this.scopeNotes(data.pending_wiki).length;
    }
    inbox.captures = this.scopeNotes(inbox.captures);
    inbox.pending_imports = this.scopeNotes(inbox.pending_imports);
    const actions = container.createDiv({ cls: "okf-dashboard__hero-actions okf-dashboard__today-actions" });
    const daily = actions.createEl("button", {
      text: data.daily.exists ? "继续写今日日记" : "创建今日日记",
      cls: "mod-cta okf-dashboard__primary-action",
    });
    daily.addEventListener("click", () => void this.openDaily(data));
    const jot = actions.createEl("button", { text: "快速记录", cls: "okf-dashboard__secondary-action" });
    jot.addEventListener("click", () => this.plugin.promptCapture(this.config));
    actions.createEl("button", { text: "新建今日任务", cls: "okf-dashboard__secondary-action", attr: { type: "button" } })
      .addEventListener("click", () => this.plugin.promptNewTask({ ...this.rawConfig, taskView: "today" }));
    this.renderDocumentDropZone(actions, this.importContext(), "today");

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
        this.updatePageState("today", { tab: option.value });
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
      "行动",
      "先继续正在推进的内容，再处理需要判断的事项。",
      "okf-today-action-section",
      { heading: this.config.showDailyUpdates, framed: false },
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
      operations: this.plugin.semanticOperationsSnapshot().filter(item => operationMatchesSectionContext(item, this.config)),
      conversions: this.plugin.conversionSnapshot().filter(item => operationMatchesSectionContext(item, this.config)),
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
      for (const item of continueItems.slice(0, 3)) {
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
      "需要关注",
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
    this.attentionItem(attention, "待整理记录", attentionCounts.inbox_decisions, () => {
      this.inboxTab = "decision";
      this.updatePageState("inbox", { tab: "decision" });
      this.openSection("inbox");
    });
    this.attentionItem(attention, "待生成学习笔记", attentionCounts.pending_study, () => {
      this.learningTab = "pending";
      this.learningContext = "all";
      this.learningRelationPath = "";
      this.updatePageState("learning", {
        tab: "pending",
        filters: { context: "all", relation: null },
      });
      this.openSection("learning");
    });
    this.attentionItem(attention, "待生成知识笔记", attentionCounts.pending_wiki, () => {
      this.knowledgeFilter = "pending";
      this.updatePageState("knowledge", { filters: { view: "pending" } });
      this.openSection("knowledge");
    });
    this.attentionItem(attention, "知识待复核", data.stale_knowledge.length, () => {
      this.knowledgeFilter = "stale";
      this.updatePageState("knowledge", { filters: { view: "stale" } });
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
    const waiting = this.plugin.conversionSnapshot().filter(item => operationMatchesSectionContext(item, this.config) &&
      !conversionHasFailure(item) && (item.status === "ready" || hasPendingGeneration(item))).length;
    this.attentionItem(attention, "待保存或生成入队", waiting, () => this.openSection("system"));
    if (!attention.querySelectorAll<HTMLElement>(".okf-dashboard__attention-item").length) pending.remove();

    const overdue = (data.overdue_tasks ?? []).filter((task) => this.taskMatchesContext(task));
    {
      const previewCount = this.rawConfig.limit === undefined && this.rawConfig.pageSize === undefined ? 5 : this.config.limit;
      const tasks = this.dashboardSection(
        actionGrid,
        "今日任务",
        `${data.tasks.length} 项今日任务${data.tasks.length > previewCount ? `；这里显示前 ${previewCount} 项` : ""}。`,
        "okf-today-tasks",
      );
      const list = tasks.createDiv({ cls: "okf-dashboard__compact-list okf-formal-task-list" });
      if (!data.tasks.length) list.createDiv({ text: "目前没有日期与今天有关的未完成任务。", cls: "okf-dashboard__empty" });
      const taskIndex = new Map(vaultTasks.map((task) => [`${task.path}:${task.line + 1}`, task]));
      for (const item of data.tasks.slice(0, previewCount)) {
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
      {
        const more = tasks.createEl("button", { text: "查看全部今日任务", cls: "okf-dashboard__ghost-action" });
        more.addEventListener("click", () => void this.plugin.navigateToOkfSection("tasks", this.contentEl,
          this.workbenchPath, { course: this.config.course, project: this.config.project, taskView: "today" }));
      }
      if (overdue.length) {
        tasks.createEl("h4", { text: `逾期任务 · ${overdue.length} 项未完成` });
        for (const item of overdue.slice(0, 2)) {
          const task = taskIndex.get(`${item.path}:${item.line}`);
          if (task) this.renderFormalTaskRow(tasks, task);
        }
        tasks.createEl("button", { text: "查看逾期任务", attr: { type: "button" } }).addEventListener("click", () =>
          void this.plugin.navigateToOkfSection("tasks", this.contentEl, this.workbenchPath, { course: this.config.course, project: this.config.project, taskView: "overdue" }));
      }
    }

    const actionColumnCount = actionGrid.querySelectorAll<HTMLElement>(".okf-dashboard__section").length;
    actionGrid.addClass(`has-${actionColumnCount}-columns`);
    if (!actionColumnCount) {
      actionGrid.createDiv({ cls: "okf-dashboard__empty", text: "今天没有需要继续或处理的行动。" });
    }

    if (!this.config.showDailyUpdates) {
      paneTabs.remove();
      readingPane.remove();
      actionPane.addClass("is-mobile-active");
    }
    if (this.plugin.isMobile) return;
    if (this.config.showDailyUpdates) this.renderDailyFeeds(readingPane);

    void this.api()
      .systemStatus()
      .then((system) => {
        const actionable = system.actionable.filter(item => item.status !== "not-configured");
        if (!actionable.length || !systemWarningSlot.isConnected) return;
        systemWarningSlot.removeClass("is-empty");
        const warning = systemWarningSlot.createDiv({ cls: "okf-dashboard__inline-alert" });
        warning.createEl("strong", { text: `系统 · ${actionable.length} 项需要处理` });
        warning.createSpan({ text: " " + actionable[0]?.detail });
        const open = warning.createEl("button", { text: "查看", cls: "okf-dashboard__ghost-action" });
        open.addEventListener("click", () => this.openSection("system"));
      })
      .catch(() => undefined);
  }

  private importContext(): Pick<DocumentImportOptions, "course" | "project"> {
    return materialContextFromNote({ course: this.config.course, project: this.config.project });
  }

  private taskMatchesContext(task: TaskItem): boolean {
    return (!this.config.course || normalizedVaultPath(task.course) === normalizedVaultPath(this.config.course)) &&
      (!this.config.project || normalizedVaultPath(task.project) === normalizedVaultPath(this.config.project));
  }

  private async renderTaskCatalog(container: HTMLElement): Promise<void> {
    const [items, all] = await Promise.all([this.vaultReader.tasks(true, false, false), this.collectFormalTasks(false)]);
    if (this.closed || !container.isConnected) return;
    const folderPaths = (key: string): string[] => {
      const value = this.rawConfig[key];
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some(path => typeof path !== 'string')) throw new Error('任务文件夹筛选格式无效');
      return value.map(path => String(path).replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, ''));
    };
    const included = folderPaths('folders');
    const viewFolders = folderPaths('taskViewFolders');
    const excluded = folderPaths('excludeFolders');
    const under = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);
    const scope = items.filter(item => this.taskMatchesContext(item)
      && (!included.length || included.some(folder => under(item.path, folder)))
      && (!viewFolders.length || viewFolders.some(folder => under(item.path, folder)))
      && !excluded.some(folder => under(item.path, folder)));
    const summaries = new Map(scope.map(item => [`${item.path}:${item.line - 1}`, item]));
    const tasks = all.filter(task => summaries.has(`${task.path}:${task.line}`)).map(task => ({ ...task,
      course: summaries.get(`${task.path}:${task.line}`)?.course ?? undefined, project: summaries.get(`${task.path}:${task.line}`)?.project ?? undefined }));
    renderTaskCatalogSurface(container, { tasks, config: this.navigationConfig(),
      workbenches: this.app.vault.getMarkdownFiles().filter(file => this.app.metadataCache?.getFileCache(file)?.frontmatter?.dashboard === true)
        .map(file => ({ path: file.path, open: () => { void this.openPath(file.path); } })),
      limit: this.config.limit, path: this.workbenchPath, search: this.taskQuery,
      saved: this.plugin.taskQueryViews?.() ?? [], renderRow: (parent, task) => this.renderFormalTaskRow(parent, task),
      create: () => this.plugin.promptNewTask(this.rawConfig),
      navigate: config => {
        for (const kind of ["course", "project"] as const) {
          if (this.config[kind] && config[kind] && normalizedVaultPath(String(config[kind])) !== normalizedVaultPath(this.config[kind])) {
            new Notice("保存视图与当前关联范围冲突，请先明确修改分区范围");
            return;
          }
        }
        const next = { ...config };
        if (this.rawConfig.folders && config.folders) next.taskViewFolders = config.folders;
        for (const key of ["course", "project", "folders", "excludeFolders"]) if (this.rawConfig[key] !== undefined) next[key] = this.rawConfig[key];
        if (Array.isArray(config.excludeFolders) && Array.isArray(this.rawConfig.excludeFolders)) next.excludeFolders = [...new Set([...this.rawConfig.excludeFolders, ...config.excludeFolders])];
        delete next.viewState;
        if (next.resetTaskQuery) {
          this.updatePageState("tasks", { filters: { taskAdvancedQuery: "", taskQueryDraft: "" } });
          delete next.resetTaskQuery;
        }
        this.rawConfig = next;
        this.config = readWorkbenchSectionConfig(next, this.embedded ? "workbench" : "page");
        this.taskQuery = String(next.taskSearch ?? "");
        this.updatePageState("tasks", { filters: { taskView: this.config.taskView, taskQuery: this.taskQuery,
          savedViewId: String(next.savedViewId ?? ""), savedViewName: String(next.savedViewName ?? ""), taskViewFolders: JSON.stringify(next.taskViewFolders ?? []), taskShown: String(this.config.limit),
          taskAdvancedQuery: String(next.taskQuery ?? ""), taskQueryDraft: String(next.taskQueryDraft ?? next.taskQuery ?? ""),
          taskStatus: String(next.taskStatus ?? "all"), taskPriority: String(next.taskPriority ?? "all"),
          taskSort: String(next.taskSort ?? ""), taskGroupBy: String(next.taskGroupBy ?? "none") } });
        void this.render(true);
      },
      remember: search => { this.taskQuery = search; this.updatePageState("tasks", { filters: { taskQuery: search } }); },
      rememberSettings: filters => this.updatePageState("tasks", { filters }),
      save: (query, config, id) => this.plugin.saveTaskQueryView(query, config, id), manage: () => this.plugin.manageTaskQueryViews(),
      notify: message => new Notice(message) });
  }

  private collapsedExcerpt(parent: HTMLElement, excerpt: string, title?: string): void {
    const visible = excerpt.trim();
    if (!visible || visible === title?.trim()) return;
    parent.createDiv({ text: compactText(visible, 180), cls: "okf-inbox-preview" });
    if (visible.length <= 180) return;
    const details = parent.createEl("details", { cls: "okf-dashboard__excerpt" });
    details.createEl("summary", { text: "预览内容" });
    details.createDiv({ text: visible });
  }

  private dashboardSection(
    parent: HTMLElement,
    title: string,
    description: string,
    className = "",
    presentation: { heading?: boolean; framed?: boolean } = {},
  ): HTMLElement {
    const section = parent.createEl("section", {
      cls: `${presentation.framed === false ? "okf-dashboard__content-group" : "okf-dashboard__section"} ${className}`.trim(),
      attr: { "aria-label": title },
    });
    if (presentation.heading !== false) {
      const heading = section.createDiv({ cls: "okf-dashboard__section-heading" });
      heading.createEl("h3", { text: title });
      heading.createDiv({ cls: "okf-dashboard__muted", text: description });
    }
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
    return renderNoteRow(parent, { title, metadata: meta, actionLabel: actionLabel === "打开" ? undefined : actionLabel, onOpen: action, badge,
      className: "okf-dashboard__compact-row", classes: { main: "okf-dashboard__row-main", title: "okf-dashboard__row-title",
        metadata: "okf-dashboard__row-meta", badge: "okf-dashboard__badge", action: "okf-dashboard__ghost-action" } });
  }

  private renderFormalTaskRow(parent: HTMLElement, task: VaultTask): void {
    const edit = () => void this.plugin.promptTaskDetails(task).catch(error => new Notice(String(error)));
    const source = () => void this.plugin.openTaskSource(task, this.contentEl).catch(error => new Notice(String(error)));
    let row: HTMLElement;
    row = renderTaskRow(parent, { app: this.app, component: this.plugin, task, allTasks: this.plugin.taskRuntimeTasks?.() ?? [],
      toggle: async checked => {
      const wrote = await toggleTaskInFile(this.app, task, checked);
      if (wrote) { invalidatePath(task.path); row.remove(); this.plugin.refreshDashboardViews(); }
      return wrote;
      }, details: task.formal ? edit : source, source, dates: () => this.plugin.promptTaskDates(task),
      menu: trigger => this.attachActionPanel(trigger as HTMLButtonElement, { label: "任务操作", actions: [
        ...(task.formal ? [{ id: "edit-task", title: "编辑详情", description: "状态、循环、依赖与关联", onSelect: edit }] : []),
        { id: "source", title: "定位来源", description: task.path, onSelect: source },
        { id: "dates", title: "安排日期", description: "分别编辑计划、截止、提醒和跨日安排", onSelect: () => this.plugin.promptTaskDates(task) },
        { id: "move", title: "移动任务与子项", description: "保留身份、关联及引用", onSelect: () => this.plugin.promptMoveTask(task) },
        { id: "daily-reference", title: "加入当日日记（引用）", description: "链接原任务，继续操作同一项", onSelect: () => this.plugin.addTaskToDaily(task) },
        { id: "daily-copy", title: "复制为独立日记任务", description: "创建独立身份，保留完整子树", onSelect: () => this.plugin.addTaskToDaily(task, true) },
      ] }), notify: message => new Notice(message, 5000) });
  }

  private collectFormalTasks(applyGlobalQuery = true): Promise<VaultTask[]> {
    const vault = (this.app as App & { vault?: { getMarkdownFiles?: unknown } }).vault;
    if (!vault || typeof vault.getMarkdownFiles !== "function") return Promise.resolve([]);
    return collectVaultTasks(this.app, [], undefined, applyGlobalQuery);
  }

  private openSection(section: Section): void {
    if (this.embedded || this.focused) {
      const config = this.config.course || this.config.project
        ? { course: this.config.course, project: this.config.project } : undefined;
      void (config ? this.plugin.navigateToOkfSection(section, this.contentEl, this.workbenchPath, config)
        : this.plugin.navigateToOkfSection(section, this.contentEl, this.workbenchPath))
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
    this.updatePageState(this.section, { scrollTop: currentScroll });
    this.section = section;
    this.plugin.updateDashboardUiState({ activeSection: section });
    void this.render();
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
      this.updatePageState(this.section, { scrollTop });
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
    if (this.plugin.isMobile) {
      options = { ...options, actions: options.actions.filter((action) =>
        !/^(?:claudian|wiki|cancel|generate)/u.test(action.id ?? "")) };
    }
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
    scope: { course?: string; project?: string } = this.config,
  ): void {
    const strip = parent.createEl("span", {
      cls: "okf-work-item__metrics",
      attr: { "aria-label": "关联内容统计" },
    });
    for (const metric of metrics) {
      const notes = related[metric.key] ?? [];
      const element = strip.createEl(notes.length ? "button" : "span", {
        cls: `okf-work-item__metric${metric.count === 0 ? " is-zero" : ""}`,
        text: `${metric.label} ${metric.count}`,
        attr: { "data-metric": metric.key, ...(notes.length ? { type: "button", "aria-label": `查看${metric.label} ${metric.count} 条` } : {}) },
      });
      if (!notes.length) continue;
      element.addEventListener("click", () => {
        const section: Section = metric.key === "pending-captures" ? "inbox" : metric.key === "sources" ? "sources" : "learning";
        void this.plugin.navigateToOkfSection(section, this.contentEl, this.workbenchPath, { course: scope.course, project: scope.project,
          catalogueLabel: metric.label, catalogueKey: metric.key, learningTab: "all", inboxTab: "decision" });
      });
    }
    if (metrics.some(metric => related[metric.key]?.length)) strip.createEl("button", { text: "预览关联", cls: "okf-metric-preview", attr: { type: "button" } })
      .addEventListener("click", () => this.showObjectDetails("关联内容", (container, close) => {
        for (const metric of metrics) {
          const notes = related[metric.key] ?? [];
          if (!notes.length) continue;
          container.createEl("h4", { text: `${metric.label} · ${notes.length}` });
          for (const note of notes) this.compactRow(container, note.title, note.path, "打开", () => void this.openPath(note.path).then(close));
        }
      }));
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
      "各来源的最近一期；可继续加载条目，打开本期汇总阅读全文并选择用途。",
      "okf-dashboard__reading",
      { heading: this.section === "today", framed: false },
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
    const surfaces = definitions.filter((definition) => !this.config.feedStreams ||
      this.config.feedStreams.includes(definition.section ?? "treehole")).map((definition) => {
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
    if (this.rawConfig.scene !== "daily-updates") {
      const tabs = container.createDiv({ cls: "okf-dashboard__segments", attr: { role: "tablist", "aria-label": "订阅内容" } });
      for (const [value, label] of [["subscriptions", "来源与历史"], ["daily-updates", "每日更新"]] as const) {
        tabs.createEl("button", { text: label, cls: this.config.readingView === value ? "is-active" : "", attr: { type: "button", role: "tab", "aria-selected": String(this.config.readingView === value) } })
          .addEventListener("click", () => {
            this.config.readingView = value;
            this.updatePageState("reading", { filters: { readingView: value } });
            void this.render(true);
          });
      }
    }
    if (this.config.readingView === "daily-updates") {
      if (this.plugin.isMobile) {
        await this.renderMobileFeedLinks(container);
      } else this.renderDailyFeeds(container);
      return;
    }
    if (this.plugin.isMobile) {
      container.createDiv({ text: "订阅由电脑更新，这里可以打开已同步的汇总。" });
      await this.renderMobileFeedLinks(container);
      return;
    }
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
    const shown = Math.max(this.config.sourcePageSize, this.pagination.get("reading:sources") ?? 0);
    const visibleSources = this.subscriptionSources.slice(0, shown);
    for (const source of visibleSources) {
      this.renderSubscriptionSourceCard(grid, source);
    }

    const footer = container.createDiv({ cls: "okf-reading-source-footer" });
    if (this.subscriptionSources.length > visibleSources.length) {
      footer.createEl("button", { text: "加载更多来源", attr: { type: "button" } }).addEventListener("click", () => {
        this.pagination.set("reading:sources", shown + this.config.sourcePageSize);
        this.updatePageState("reading", { filters: { "loaded:reading:sources": shown + this.config.sourcePageSize } });
        void this.render(true);
      });
      return;
    }
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
            limit: this.config.sourcePageSize,
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
          this.pagination.set("reading:sources", shown + this.config.sourcePageSize);
          this.updatePageState("reading", { filters: { "loaded:reading:sources": shown + this.config.sourcePageSize } });
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

  private async renderMobileFeedLinks(container: HTMLElement): Promise<void> {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith("feeds/"))
      .sort((left, right) => right.stat.mtime - left.stat.mtime);
    this.pageItems(container, files, (parent, file) => {
      parent.createEl("button", { text: file.basename, cls: "okf-dashboard__ghost-action" })
        .addEventListener("click", () => void this.openPath(file.path));
    });
    if (!files.length) container.createDiv({ text: "暂时没有同步过来的订阅汇总。" });
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
        limit: current.items.length,
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
    this.updatePageState("reading", { filters: { sourceId: source.source_id, sourceName: source.source_name,
      overviewScroll: this.readingOverviewScroll } });
    this.resetSubscriptionDetail(source.source_id);
    this.pageScroll.set("reading", 0);
    this.updatePageState("reading", { scrollTop: 0 });
    void this.render();
  }

  private closeSubscriptionSource(): void {
    this.selectedSubscriptionSource = undefined;
    this.updatePageState("reading", { filters: { sourceId: null, sourceName: null } });
    this.pageScroll.set("reading", this.readingOverviewScroll);
    this.updatePageState("reading", { scrollTop: this.readingOverviewScroll });
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
      this.updatePageState("reading", {
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
      limit: this.config.sourcePageSize,
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
      this.dirtyFeedScroll.add(feed);
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
    const effectiveLimit = options.limit ?? (mode === "compact" ? this.config.itemsPerEdition : undefined);
    const visibleItems = effectiveLimit === undefined
      ? edition.items
      : edition.items.slice(0, Math.max(0, effectiveLimit));
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
    if (effectiveLimit !== undefined && edition.items.length > effectiveLimit) {
      section.createEl("button", { text: `加载更多条目 · 共 ${edition.item_count} 条`, attr: { type: "button" } }).addEventListener("click", () => {
        section.remove();
        this.renderFeedDigestEdition(parent, kind, edition, { ...options, limit: effectiveLimit + this.config.itemsPerEdition });
      });
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
    if (this.closed || !container.isConnected) return;
    projection.captures = this.scopeNotes(projection.captures);
    projection.pending_imports = this.scopeNotes(projection.pending_imports);
    const queue = this.inboxWorkQueue(projection);
    if (this.rawConfig.inboxTab === "decision") this.inboxTab = "decision";
    queue.decision.sort((left, right) => this.config.sort === "title" ? left.note.title.localeCompare(right.note.title, "zh-CN")
      : (right.note.modified_at ?? "").localeCompare(left.note.modified_at ?? ""));
    const openCapturePaths = new Set(projection.captures.map((note) => note.path));
    for (const path of this.selectedCaptures) {
      if (!openCapturePaths.has(path)) this.selectedCaptures.delete(path);
    }

    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const capture = actions.createEl("button", {
      text: "快速记录到待处理",
      cls: "mod-cta okf-dashboard__primary-action",
    });
    capture.addEventListener("click", () => this.plugin.promptCapture(this.config));
    this.renderDocumentDropZone(actions, this.importContext(), "inbox");
    const processing = actions.createEl("button", { text: "导入记录与后台处理", attr: { type: "button" } });
    processing.addEventListener("click", () => this.openSection("system"));

    const stageTabs = container.createDiv({
      cls: "okf-dashboard__segments okf-dashboard__stage-tabs",
      attr: { role: "tablist", "aria-label": "待处理页面" },
    });
    const progressCount = queue.conversion.length;
    for (const option of [
      { value: "decision" as const, label: "待判断", count: queue.decision.length },
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
        this.updatePageState("inbox", { tab: option.value });
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
        this.updatePageState("inbox", {
          filters: { ingestedVia: option.value },
        });
        void this.render(true);
      });
    }

    if (this.inboxTab === "decision") {
      const visible = filterInboxItems(queue.decision, this.inboxIngestedVia);
      let discardSelected: HTMLButtonElement | undefined;
      let selectionToolbar: HTMLElement | undefined;
      const updateSelection = (): void => {
        if (!discardSelected) return;
        discardSelected.setText(`移到回收站 (${this.selectedCaptures.size})`);
        discardSelected.toggleClass("is-hidden", !this.selectedCaptures.size);
        selectionToolbar?.toggleClass("is-hidden", !this.selectedCaptures.size);
      };
      if (!this.plugin.isMobile && visible.some((item) => item.note.note_type === "Capture")) {
        const toolbar = container.createDiv({ cls: "okf-dashboard__selection-toolbar is-hidden" });
        selectionToolbar = toolbar;
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
          text: "当前没有文件转换进度。学习材料生成可在学习页面查看；全部执行记录在后台处理页面查看。",
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
    this.pageItems(cards, items, (parent, item) => {
      const card = parent.createDiv({ cls: "okf-dashboard__compact-row okf-dashboard__compact-row--stacked okf-inbox-decision-card" });
      if (!this.plugin.isMobile && item.note.note_type === "Capture") {
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
      const main = card.createDiv({ cls: "okf-inbox-decision-card__main" });
      this.inboxNoteIdentity(main, item.note, item.ingested_via);
      this.collapsedExcerpt(main, item.note.excerpt, item.note.title);
      if (item.note.note_type === "Capture" && item.ingested_via === "web-clip") {
        this.webCaptureActions(main, item.note);
      } else if (item.note.note_type === "Capture") {
        this.inboxActions(main, item.note);
      } else {
        this.pendingSourceActions(main, item.note);
      }
    });
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
    if (note.course || note.project) card.createDiv({ cls: "okf-dashboard__row-meta", text: learningContextLabel(note, this.relationTitlesForNote(note)) });
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
    if (this.plugin.isMobile) return;
    const actions = parent.createDiv({ cls: "okf-dashboard__actions okf-dashboard__decision-entry" });
    const status = actions.createDiv({ cls: "okf-dashboard__muted", text: "由你判断学习意愿和长期价值。" });
    const choices = actions.createDiv({ cls: "okf-dashboard__decision-choices" });
    renderMaterialDecision(choices, status, { yesLabel: "我想学习", noLabel: "我不准备学习", choose: (action, button) => {
      if (action === "ignore") void this.runButtonAction(button, () => this.api().discardCapture(note.path), true);
      else this.plugin.promptPublishWebCapture(note.path, action);
    } });
  }

  private pendingSourceActions(parent: HTMLElement, note: NoteSummary): void {
    if (this.plugin.isMobile) {
      parent.createDiv({ text: "资料已同步；归类和生成可在电脑继续。" });
      return;
    }
    const actions = parent.createDiv({ cls: "okf-dashboard__actions" });
    const learn = actions.createEl("button", { text: "用于学习" });
    learn.addEventListener("click", () => this.plugin.promptRoutePendingSource(note.path, "learn", materialContextFromNote(note)));
    const wiki = actions.createEl("button", { text: "生成知识笔记" });
    wiki.addEventListener("click", () => this.plugin.promptRoutePendingSource(note.path, "wiki", materialContextFromNote(note)));
    const sourceOnly = actions.createEl("button", { text: "只保存资料" });
    sourceOnly.addEventListener("click", () => this.plugin.promptRoutePendingSource(note.path, "source", materialContextFromNote(note)));
  }

  private pendingGenerationActions(
    parent: HTMLElement,
    note: NoteSummary,
    operation?: SemanticOperationRecord,
    includeOperations = false,
  ): void {
    if (this.plugin.isMobile) return;
    const actions = parent.createDiv({ cls: "okf-work-item__actions" });
    if (note.note_type === "Source" && !note.text_path && !operation) {
      actions.createDiv({ cls: "okf-dashboard__muted", text: "原件已保存，需要明确转换正文后准备材料。" });
      if (!originalReference(note.resource)) {
        actions.createEl("button", { text: "打开资料卡补充来源", attr: { type: "button" } })
          .addEventListener("click", () => void this.openPath(note.path));
        return;
      }
      const convert = actions.createEl("button", { text: "转换并准备材料", attr: { type: "button" } });
      convert.addEventListener("click", () => void runUiAction(convert,
        () => this.plugin.processSourceOriginal(note.path, materialContextFromNote(note), true, note.purpose === "wiki" ? "wiki" : "learn"),
        message => new Notice(message)));
      return;
    }
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
            (note.purpose === "wiki" ? "请读取附带的资料与正文，按明确用途整理为长期知识笔记。"
              : "请读取附带的资料与正文，按明确课程和项目关系准备可连续阅读的学习材料。") +
              "我在本消息中补充的要求一并执行；没有补充要求时直接按资料处理。" +
              "完成后说明写入路径、实际读取的来源和重要缺口。",
            {
              contextPaths: [...new Set([note.path, ...sources])],
              actionMode: "write",
              skill: note.purpose === "wiki" ? "distill-wiki" : "prepare-study-guide",
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
    actions.createEl("button", { text: "处理详情", attr: { type: "button" } }).addEventListener("click", () => this.openProcessingDetails(conversion));
    const target = conversion.outputs.source_text ?? conversion.outputs.source;
    if (target) {
      const open = actions.createEl("button", { text: conversion.outputs.source_text ? "打开转换正文" : "打开资料卡" });
      open.addEventListener("click", () => void this.openPath(target));
    }
    if (conversionRecovery(conversion) === "generation") {
      const retry = actions.createEl("button", { text: "重试生成入队" });
      retry.addEventListener("click", () => {
        void this.runButtonAction(retry, async () => {
          const record = await this.api().retryConversion(conversion.conversion_id);
          this.plugin.watchDocumentConversion(record.conversion_id);
        }, true, "正在重试生成入队，无需重新转换");
      });
    } else if (conversionRecovery(conversion) === "publish") {
      const resume = actions.createEl("button", { text: "继续保存（不重新转换）" });
      resume.addEventListener("click", () => {
        void this.runButtonAction(resume, async () => {
          const record = await this.api().retryConversion(conversion.conversion_id);
          this.plugin.watchDocumentConversion(record.conversion_id);
        }, true, "已继续保存转换结果，无需重新转换");
      });
    }
    if (conversion.status !== "converting") this.renderConversionMethodActions(actions, conversion);
  }

  private renderConversionMethodActions(parent: HTMLElement, conversion: ConversionRecord): void {
    if (conversion.stages?.conversion === "completed") {
      parent.createEl("button", { text: "查看本次转换结果" }).addEventListener("click", () => {
        void this.plugin.showDocumentConversionResult(conversion);
      });
    }
    if (conversionRecovery(conversion) === "convert") {
      const retry = parent.createEl("button", { text: "原方式重试" });
      retry.addEventListener("click", () => {
        void this.runButtonAction(retry, async () => {
          const record = await this.api().retryConversion(conversion.conversion_id);
          this.plugin.watchDocumentConversion(record.conversion_id);
        }, true, "已按原方式重新排队");
      });
    }
    const change = parent.createEl("button", { text: "更换方式重新转换…" });
    change.addEventListener("click", () => this.plugin.promptDocumentReconversion(conversion));
  }

  private async renderLearning(container: HTMLElement): Promise<void> {
    const data = await this.vaultReader.learning();
    if (this.closed || !container.isConnected) return;
    data.pending_guides = this.displayNotes(this.scopeNotes(data.pending_guides));
    data.ready_guides = this.displayNotes(this.scopeNotes(data.ready_guides));
    data.completed_guides = this.displayNotes(this.scopeNotes(data.completed_guides));
    data.courses = this.displayNotes(this.scopeNotes(data.courses)).map(course => this.scopedCourseRelations(course));
    data.projects = this.displayNotes(this.scopeNotes(data.projects)).map(project => this.scopedProjectRelations(project));
    if (this.config.course) {
      this.learningContext = "course";
      this.learningRelationPath = this.config.course;
    } else if (this.config.project) {
      this.learningContext = "project";
      this.learningRelationPath = this.config.project;
    }
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
    const scopeCounts = dashboardLearningScopeCounts(allLearningNotes);
    const selectedCourse = this.learningContext === "course" && this.learningRelationPath
      ? data.courses.find((item) => dashboardPath(item.path) === dashboardPath(this.learningRelationPath))
      : undefined;
    const selectedProject = this.learningContext === "project" && this.learningRelationPath
      ? data.projects.find((item) => dashboardPath(item.path) === dashboardPath(this.learningRelationPath))
      : undefined;
    if (this.learningRelationPath && !selectedCourse && !selectedProject) {
      throw new Error(`所选学习关系未到达或已删除，已保留筛选：${this.learningRelationPath}`);
    }
    const relationPath = selectedCourse?.path ?? selectedProject?.path;
    const scopeTitle = selectedCourse?.title ?? selectedProject?.title ?? learningScopeLabel(this.learningContext);
    if (this.rawConfig.catalogueKey === "lessons") {
      container.createEl("h3", { text: `${scopeTitle} · 课堂笔记` });
      const paths = new Set((this.rawConfig.notePaths as string[] | undefined) ?? []);
      const lessons = data.courses.flatMap(course => course.lessons ?? []).filter(note => !paths.size || paths.has(note.path));
      this.pageItems(container, lessons, (parent, note) => this.compactRow(parent, note.title, "课堂笔记", "打开", () => void this.openPath(note.path)));
      return;
    }
    const groups = {
      all: { label: "全部", notes: filterDashboardLearningScope(allLearningNotes, this.learningContext, relationPath), empty: "当前范围没有学习材料。" },
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
        label: "待准备",
        notes: filterDashboardLearningScope(
          data.pending_guides,
          this.learningContext,
          relationPath,
        ),
        empty: "没有等待生成的学习材料。",
      },
      completed: {
        label: "已学完",
        notes: filterDashboardLearningScope(
          data.completed_guides,
          this.learningContext,
          relationPath,
        ),
        empty: "还没有完成的学习材料。",
      },
    } as const;
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    this.renderDocumentDropZone(container, {
      ...this.importContext(),
      ...(selectedCourse ? { course: selectedCourse.path.split("/")[2] } : {}),
      ...(selectedProject ? { project: selectedProject.path.split("/")[1] } : {}),
    }, "learning");
    if (selectedCourse || this.learningContext === "course") {
    const classNote = actions.createEl("button", {
      text: "新建课堂笔记",
      cls: "okf-dashboard__secondary-action",
    });
    classNote.addEventListener("click", () => selectedCourse
      ? this.plugin.promptLessonForCourse(selectedCourse.path)
      : this.plugin.promptLesson());
    }
    const course = actions.createEl("button", { text: "新建课程", cls: "okf-dashboard__ghost-action" });
    course.addEventListener("click", () => this.plugin.promptCourse());

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
        this.updatePageState("learning", { tab: id });
        void this.render(true);
      });
    }
    const selected = groups[this.learningTab];
    const search = current.createEl("input", { attr: { type: "search", "aria-label": "搜索学习材料", placeholder: "搜索学习材料…" } });
    search.value = this.learningQuery;
    const selectedList = current.createDiv({ cls: "okf-learning-tab-panel" });
    const render = () => {
      selectedList.empty();
      const query = this.learningQuery.trim().toLocaleLowerCase();
      this.renderLearningNotes(selectedList, selected.notes.filter(note => !query || `${note.title} ${note.path}`.toLocaleLowerCase().includes(query)),
        query ? "没有匹配的学习材料。" : this.learningContext === "all" ? selected.empty : `${scopeTitle}当前没有处于“${selected.label}”状态的学习材料。`, operations, relationTitles);
    };
    search.addEventListener("input", () => { this.learningQuery = search.value; this.updatePageState("learning", { filters: { query: search.value } }); render(); });
    render();
  }

  private setLearningScope(context: LearningContextFilter, relationPath = ""): void {
    this.learningContext = context;
    this.learningRelationPath = relationPath.replace(/^\/+|\/+$/gu, "");
    this.updatePageState("learning", {
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
        : "选择课程",
    );
    if (!courses.length) {
      section.createDiv({ cls: "okf-dashboard__empty", text: "还没有课程。" });
      return;
    }
    const list = section.createDiv({ cls: "okf-learning-entity-list" });
    this.learningScopeEntity(
      list,
      "全部课程相关材料",
      `${courses.length} 门课程`,
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
        : "选择项目",
    );
    if (!projects.length) {
      section.createDiv({ cls: "okf-dashboard__empty", text: "还没有项目。" });
      return;
    }
    const list = section.createDiv({ cls: "okf-learning-entity-list" });
    this.learningScopeEntity(
      list,
      "全部项目相关材料",
      `${projects.length} 个项目`,
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
    details.dataset.stateKey = `learning-browser:${this.learningContext}`;
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
    relation = { ...this.importContext(), ...relation };
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
    title.addEventListener("click", () => this.openCourseDetails(course));
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
    }, { ...this.config, course: course.path });

    const actions = row.createDiv({ cls: "okf-work-item__actions" });
    const primary = actions.createEl("button", {
      text: "新建课堂笔记",
      cls: "okf-dashboard__secondary-action okf-work-item__primary-action",
      attr: { type: "button" },
    });
    primary.addEventListener("click", () => this.plugin.promptLessonForCourse(course.path));
    actions.createEl("button", { text: "新建课程任务", attr: { type: "button" } }).addEventListener("click", () =>
      this.plugin.promptNewTask({ ...this.rawConfig, course: course.path }));
    actions.createEl("button", { text: "查看课程任务", attr: { type: "button" } }).addEventListener("click", () =>
      void this.plugin.navigateToOkfSection("tasks", this.contentEl, this.workbenchPath, { course: course.path, project: this.config.project, taskView: "all" }));
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
    const projectFile = this.app.vault?.getAbstractFileByPath(project.path);
    const links = projectFile instanceof TFile ? this.app.metadataCache?.getFileCache(projectFile)?.links ?? [] : [];
    const linkedTask = tasks.find(task => links.some(link => {
      const target = parseLinktext(link.link);
      return project.next_action.includes(link.original) && target.subpath === `#^${task.blockId}`
        && this.app.metadataCache.getFirstLinkpathDest(target.path, project.path)?.path === task.path;
    }));
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
    title.addEventListener("click", () => this.openProjectDetails(project));
    identity.createSpan({
      cls: `okf-work-item__status is-${status}`,
      text: projectStatusLabel(status),
    });
    main.createDiv({
      cls: "okf-work-item__summary",
      text: [
        linkedTask ? "下一步任务" : project.next_action ? `下一步：${compactText(project.next_action, 120)}` : "尚未设置下一步",
        relativeMoment(project.modified_at),
      ].filter(Boolean).join(" · "),
    });
    if (linkedTask) this.renderFormalTaskRow(main, linkedTask);
    this.renderMetrics(main, dashboardProjectMetrics(project), {
      "pending-captures": project.pending_captures,
      "study-guides": project.related_learning,
      sources: project.related_materials,
    }, { ...this.config, project: project.path });
    if (tasks.length) {
      const taskList = main.createDiv({ cls: "okf-project-row__tasks" });
      taskList.createDiv({ cls: "okf-dashboard__muted", text: `未完成任务 · ${tasks.length}` });
      for (const task of tasks.filter(task => task !== linkedTask).slice(0, 3)) this.renderFormalTaskRow(taskList, task);
      if (tasks.length > 3) {
        taskList.createEl("button", { text: "查看全部项目任务", cls: "okf-dashboard__ghost-action", attr: { type: "button" } })
          .addEventListener("click", () => void this.plugin.navigateToOkfSection("tasks", this.contentEl,
            this.workbenchPath, { course: this.config.course, project: project.path, taskView: "all" }));
      }
    }

    const actions = row.createDiv({ cls: "okf-work-item__actions" });
    const primary = actions.createEl("button", {
      text: context ? "查看项目" : status === "active" ? "记录进展" : status === "paused" ? "恢复推进" : "重新开启",
      cls: "okf-dashboard__secondary-action okf-work-item__primary-action",
      attr: { type: "button" },
    });
    if (context) {
      primary.addEventListener("click", () => void this.plugin.navigateToOkfSection("projects", this.contentEl,
        this.workbenchPath, { course: this.config.course, project: project.path }));
    } else if (status === "active") {
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
      { id: "new-task", title: "新建项目任务", description: "保存具体行动，继承当前关联", onSelect: () => this.plugin.promptNewTask({ ...this.rawConfig, project: project.path }) },
      { id: "tasks", title: "查看项目任务", description: "安排日期，切换状态与历史视图", onSelect: () => this.plugin.navigateToOkfSection("tasks", this.contentEl, this.workbenchPath, { course: this.config.course, project: project.path, taskView: "all" }) },
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
    this.pageItems(list, notes, (parent, note) => {
      const operation = this.semanticOperationForNote(note, operations);
      const card = parent.createEl("article", {
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
    });
  }

  private learningQueueActions(
    parent: HTMLElement,
    note: NoteSummary,
    operation?: SemanticOperationRecord,
  ): void {
    if (this.plugin.isMobile) {
      const actions = parent.createDiv({ cls: "okf-dashboard__actions" });
      actions.createEl("button", { text: "打开" })
        .addEventListener("click", () => void this.openPath(note.path));
      if (canCompleteDashboardStudy(note, operation)) {
        actions.createEl("button", { text: note.studied_at ? "取消完成" : "标记完成" })
          .addEventListener("click", () => {
            void this.plugin.setStudyCompleted(note.path, !note.studied_at).then(() => this.render(true));
          });
      }
      return;
    }
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
    if (this.closed || !container.isConnected) return;
    data.projects = this.displayNotes(this.scopeNotes(data.projects)).map(project => this.scopedProjectRelations(project)).filter((project) =>
      !this.config.statuses || this.config.statuses.includes(projectLifecycleStatus(project)));
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const create = actions.createEl("button", {
      text: "新建项目",
      cls: "okf-dashboard__secondary-action",
    });
    create.addEventListener("click", () => this.plugin.promptProject());
    const search = container.createEl("input", { attr: { type: "search", "aria-label": "搜索项目", placeholder: "搜索项目与下一步…" } });
    search.value = this.projectQuery;

    const tabs = container.createDiv({
      cls: "okf-dashboard__segments okf-dashboard__stage-tabs",
      attr: { role: "tablist", "aria-label": "项目状态" },
    });
    const groups = {
      all: data.projects,
      active: data.projects.filter((project) => !project.project_status || project.project_status === "active"),
      paused: data.projects.filter((project) => project.project_status === "paused"),
      completed: data.projects.filter((project) => project.project_status === "completed"),
    };
    for (const option of [
      { value: "all" as const, label: "全部" },
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
        this.updatePageState("projects", { tab: option.value });
        void this.render(true);
      });
    }

    const list = container.createDiv({ cls: "okf-dashboard__compact-list okf-project-list" });
    const renderList = () => {
    list.empty();
    const query = this.projectQuery.trim().toLocaleLowerCase();
    const selected = groups[this.projectsTab].filter(project => !query || `${project.title} ${project.next_action ?? ""}`.toLocaleLowerCase().includes(query));
    if (!selected.length) {
      list.createDiv({
        cls: "okf-dashboard__empty okf-dashboard__empty--panel",
        text: this.projectsTab === "active" ? "当前没有进行中的项目。" : "这个状态下没有项目。",
      });
      return;
    }
    this.pageItems(list, selected, (parent, project) => {
      const identities = new Set(project.open_tasks.map(task => `${task.path}:${task.line}`));
      const projectTasks = tasks.filter(task => {
        const inheritedProject = task.project ?? this.app.metadataCache?.getFileCache(task.file)?.frontmatter?.project
          ?? (/^projects\/[^/]+\//u.test(task.path) ? `projects/${task.path.split("/")[1]}/project.md` : undefined);
        const summary = project.open_tasks.find(item => item.path === task.path && item.line === task.line + 1);
        const inheritedCourse = task.course ?? this.app.metadataCache?.getFileCache(task.file)?.frontmatter?.course;
        return Boolean(task.formal && !task.checked && (identities.has(`${task.path}:${task.line + 1}`) || normalizedVaultPath(inheritedProject) === normalizedVaultPath(project.path))
          && this.taskMatchesContext(summary ?? { path: task.path, line: task.line + 1, text: task.text,
            course: typeof inheritedCourse === "string" ? inheritedCourse : undefined, project: typeof inheritedProject === "string" ? inheritedProject : undefined }));
      });
      this.renderProjectWorkItem(parent, project, false, projectTasks);
      if (this.config.project) this.renderProjectDetails(parent, project);
    });
    };
    search.addEventListener("input", () => { this.projectQuery = search.value; this.updatePageState("projects", { filters: { query: search.value } }); renderList(); });
    renderList();
  }

  private renderProjectDetails(parent: HTMLElement, project: ProjectSummary): void {
    const details = parent.createEl("details", { cls: "okf-project-details" });
    details.dataset.stateKey = `project:${project.path}`;
    details.createEl("summary", { text: "当前状态、日志、决策与成果" });
    if (project.current_state) details.createDiv({ text: project.current_state });
    if (project.recent_log) details.createDiv({ cls: "okf-dashboard__muted", text: `最近进展：${project.recent_log}` });
    const log = details.createEl("button", { text: "打开项目日志", attr: { type: "button" } });
    log.addEventListener("click", () => void this.openPath(project.log_path));
    for (const [label, paths] of [["决策", project.decisions], ["成果", project.outputs]] as const) {
      if (!paths.length) continue;
      const group = details.createDiv();
      group.createEl("strong", { text: label });
      this.pageItems(group, paths, (container, path) => {
        const open = container.createEl("button", { text: relationName(path), attr: { type: "button" } });
        open.addEventListener("click", () => void this.openPath(path));
      });
    }
  }

  private showObjectDetails(title: string, render: (container: HTMLElement, close: () => void) => void | Promise<void>, pollMs?: number): void {
    this.objectDetails?.close();
    const existing = new Set(this.actionPanels);
    this.objectDetails = new ObjectDetailsModal(this.app, title, render, () => {
      for (const panel of this.actionPanels) if (!existing.has(panel)) { panel.destroy(); this.actionPanels.delete(panel); }
    }, pollMs);
    this.objectDetails.open();
  }

  private openProcessingDetails(record: SemanticOperationRecord | ConversionRecord): void {
    const semantic = "operation_id" in record;
    this.showObjectDetails(semantic ? "后台生成详情" : "文档处理详情", (container, close) => {
      const button = (label: string, action: () => Promise<void>) => {
        const element = container.createEl("button", { text: label, attr: { type: "button" } });
        element.addEventListener("click", () => void runUiAction(element, action, message => new Notice(message)));
      };
      if (semantic) {
        const current = this.plugin.semanticOperationsSnapshot().find(item => item.operation_id === record.operation_id);
        if (!current) throw new Error("尚未读取到这项后台操作，请刷新后台处理页面");
        container.createEl("strong", { text: semanticStageLabel(current) });
        container.createDiv({ text: `目标：${current.target}` });
        if (current.stage_detail) container.createDiv({ text: current.stage_detail });
        if (current.error) container.createDiv({ text: current.error, cls: "okf-dashboard__error" });
        container.createDiv({ text: `更新：${formatLocalTimestamp(current.updated_at)}`, cls: "okf-dashboard__muted" });
        container.createEl("h4", { text: "实际读取的来源" });
        if (!current.actual_reads.length) container.createDiv({ text: "尚未报告实际读取记录。" });
        for (const path of current.actual_reads) button(path, async () => { await this.openPath(path); close(); });
        if (current.status === "completed" || this.app.vault.getAbstractFileByPath(current.target) instanceof TFile) button("打开结果", async () => { await this.openPath(current.target); close(); });
        if (semanticOperationActions(current).cancel) button("取消后台处理", () => this.cancelSemanticOperation(current.operation_id));
        if (semanticOperationActions(current).retry) button("重新生成", async () => { const next = await this.api().retrySemanticOperation(current.operation_id); this.plugin.watchSemanticOperation(next.operation_id); });
      } else {
        const current = this.plugin.conversionSnapshot().find(item => item.conversion_id === record.conversion_id);
        if (!current) throw new Error("尚未读取到这项转换记录，请刷新后台处理页面");
        container.createEl("strong", { text: `${current.source_filename} · ${conversionStatusLabel(current)}` });
        container.createDiv({ text: `方式：${conversionMethodLabel(current)}` });
        if (current.error) container.createDiv({ text: current.error, cls: "okf-dashboard__error" });
        for (const warning of current.warnings ?? []) container.createDiv({ text: warning });
        for (const attempt of current.parser_attempts ?? []) container.createDiv({ text: `${attempt.method ?? attempt.parser} · ${attempt.status} · ${attempt.duration_ms} ms${attempt.error ? ` · ${attempt.error}` : ""}` });
        const names: Record<string, string> = { source: "资料记录", source_text: "资料正文", study_guide: "学习笔记", wiki: "知识笔记" };
        for (const [kind, path] of Object.entries(current.outputs)) if (names[kind] && path) button(`查看${names[kind]}`, async () => { await this.openPath(path); close(); });
        if (current.status !== "converting") this.renderConversionMethodActions(container, current);
        if (conversionRecovery(current) === "publish") button("继续保存转换结果", async () => { const next = await this.api().retryConversion(current.conversion_id); this.plugin.watchDocumentConversion(next.conversion_id); });
      }
    }, 2000);
  }

  private openProjectDetails(project: ProjectSummary): void {
    const path = project.path;
    this.showObjectDetails(project.title, async (container, close) => {
      let project = (await this.vaultReader.projects()).projects.find(item => item.path === path);
      if (!project) throw new Error("项目尚未读取或已经变化，请检查来源");
      project = this.scopedProjectRelations(project);
      container.createDiv({ text: projectStatusLabel(projectLifecycleStatus(project)), cls: "okf-dashboard__badge" });
      if (project.next_action) container.createDiv({ text: `下一步：${project.next_action}`, cls: "okf-detail-next-action" });
      if (project.current_state) container.createDiv({ text: project.current_state, cls: "okf-detail-summary" });
      const actions = container.createDiv({ cls: "okf-dashboard__actions" });
      actions.createEl("button", { text: "记录进展", cls: "mod-cta", attr: { type: "button" } }).addEventListener("click", () => this.plugin.promptProjectProgress(project.path));
      actions.createEl("button", { text: "打开项目主页", attr: { type: "button" } }).addEventListener("click", () => { close(); void this.openPath(project.path); });
      const taskSection = this.dashboardSection(container, "项目任务", "与这个项目关联的未完成任务。");
      const taskActions = taskSection.createDiv({ cls: "okf-dashboard__actions" });
      taskActions.createEl("button", { text: "新建项目任务", attr: { type: "button" } }).addEventListener("click", () => this.plugin.promptNewTask({ ...this.rawConfig, project: project.path }));
      taskActions.createEl("button", { text: "查看全部项目任务", attr: { type: "button" } }).addEventListener("click", () => { close(); void this.plugin.navigateToOkfSection("tasks", this.contentEl, this.workbenchPath, { course: this.config.course, project: project.path, taskView: "all" }); });
      const [tasks, summaries] = await Promise.all([this.collectFormalTasks(), this.vaultReader.tasks(true)]);
      const references = new Set(summaries.filter(task => normalizedVaultPath(task.project) === normalizedVaultPath(project.path)).map(task => `${task.path}:${task.line - 1}`));
      const relatedTasks = tasks.filter(task => task.formal && !task.checked && references.has(`${task.path}:${task.line}`));
      if (!relatedTasks.length) taskSection.createDiv({ text: "目前没有未完成的项目任务。", cls: "okf-dashboard__empty" });
      for (const task of relatedTasks.slice(0, 8)) this.renderFormalTaskRow(taskSection, task);
      this.renderMetrics(container, dashboardProjectMetrics(project), { "pending-captures": project.pending_captures, "study-guides": project.related_learning, sources: project.related_materials }, { project: project.path });
      this.renderProjectDetails(container, project);
      for (const detail of container.querySelectorAll("details.okf-project-details")) (detail as HTMLDetailsElement).open = true;
      this.renderDocumentContextButton(actions, { project: project.path.split("/")[1] });
    });
  }

  private openCourseDetails(initial: CourseSummary): void {
    this.showObjectDetails(initial.title, async (container, close) => {
      let course = (await this.vaultReader.learning()).courses.find(item => item.path === initial.path);
      if (!course) throw new Error("课程尚未读取或已经变化，请检查来源");
      course = this.scopedCourseRelations(course);
      container.createDiv({ text: courseStatusLabel(course.course_status), cls: "okf-dashboard__badge" });
      container.createDiv({ text: course.current_progress || "尚未记录课程进度", cls: "okf-detail-summary" });
      const actions = container.createDiv({ cls: "okf-dashboard__actions" });
      actions.createEl("button", { text: "新建课堂笔记", attr: { type: "button" } }).addEventListener("click", () => this.plugin.promptLessonForCourse(course.path));
      actions.createEl("button", { text: "打开课程主页", attr: { type: "button" } }).addEventListener("click", () => void this.openPath(course.path).then(close));
      this.renderDocumentContextButton(actions, { course: course.path.split("/")[2] });
      this.renderMetrics(container, dashboardCourseMetrics(course), { "pending-captures": course.pending_captures, "study-guides": course.related_learning ?? [], sources: course.related_sources, lessons: course.lessons ?? [] }, { ...this.config, course: course.path });
      const section = this.dashboardSection(container, "课程任务", "与课程关联的未完成任务，保留原始来源。");
      const taskActions = section.createDiv({ cls: "okf-dashboard__actions" });
      taskActions.createEl("button", { text: "新建课程任务", attr: { type: "button" } }).addEventListener("click", () => this.plugin.promptNewTask({ ...this.rawConfig, course: course.path }));
      taskActions.createEl("button", { text: "查看全部课程任务", attr: { type: "button" } }).addEventListener("click", () => { close(); void this.plugin.navigateToOkfSection("tasks", this.contentEl, this.workbenchPath, { course: course.path, project: this.config.project, taskView: "all" }); });
      const tasks = (await this.collectFormalTasks()).filter(task => task.formal && !task.checked && normalizedVaultPath(task.course) === normalizedVaultPath(course.path)
        && (!this.config.project || normalizedVaultPath(task.project) === normalizedVaultPath(this.config.project)));
      if (!tasks.length) section.createDiv({ text: "当前没有未完成的课程任务。", cls: "okf-dashboard__empty" });
      tasks.slice(0, 8).forEach(task => this.renderFormalTaskRow(section, task));
      container.createEl("h4", { text: "课堂笔记" });
      for (const note of (course.lessons ?? []).slice(0, 10)) this.compactRow(container, note.title, "课堂笔记", "打开", () => void this.openPath(note.path).then(close));
    });
  }

  private async renderSources(container: HTMLElement): Promise<void> {
    const data = await this.vaultReader.sources();
    if (this.closed || !container.isConnected) return;
    const sources = this.displayNotes(this.scopeNotes(data.sources));
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    this.renderDocumentDropZone(actions, this.importContext(), "context");
    const submissions = container.createEl("details");
    submissions.dataset.stateKey = "source-submissions";
    submissions.createEl("summary", { text: "导入记录与待登记原件" });
    await renderSyncedImports(this.app, submissions.createDiv(), this.plugin.originalFiles);
    const search = container.createEl("input", { attr: { type: "search", placeholder: "搜索资料、资源与主题…",
      "aria-label": "搜索资料" } });
    search.value = this.sourceQuery;
    const select = container.createEl("select", { attr: { "aria-label": "资料用途" } });
    for (const [value, label] of Object.entries({ all: "全部用途", study: "学习", wiki: "知识", reference: "参考", undecided: "未决定" })) {
      select.createEl("option", { text: label, attr: { value } });
    }
    select.value = this.sourcePurpose;
    const list = container.createDiv({ cls: "okf-dashboard__compact-list okf-source-list" });
    const render = (): void => {
      list.empty();
      const query = this.sourceQuery.trim().toLocaleLowerCase();
      const visible = sources.filter((note) => (!query || [note.title, note.path, note.resource, ...(note.topics ?? [])]
        .filter(Boolean).join(" ").toLocaleLowerCase().includes(query)) &&
        (this.sourcePurpose === "all" || note.uses?.some((use) => use.purpose === this.sourcePurpose) || note.purpose === this.sourcePurpose));
      list.createDiv({ cls: "okf-dashboard__muted", text: `${visible.length} 份资料` });
      if (!visible.length) list.createDiv({ cls: "okf-dashboard__empty", text: "没有符合当前条件的资料。" });
      this.pageItems(list, visible, (parent, source) => this.renderSourceCard(parent, source, data.related));
    };
    search.addEventListener("input", () => { this.sourceQuery = search.value;
      this.updatePageState("sources", { filters: { query: search.value } }); render(); });
    select.addEventListener("change", () => { this.sourcePurpose = select.value;
      this.updatePageState("sources", { filters: { purpose: select.value } }); render(); });
    render();
  }

  private renderSourceCard(parent: HTMLElement, source: NoteSummary, related: readonly NoteSummary[], detailed = false, afterOpen?: () => void): void {
    const card = parent.createEl("article", { cls: "okf-work-item okf-source-card" });
    const title = card.createEl("button", { text: source.title, cls: "okf-dashboard__row-title", attr: { type: "button" } });
    title.addEventListener("click", () => {
      if (detailed) { void this.openPath(source.path).then(afterOpen); return; }
      this.showObjectDetails(source.title, async (container, close) => {
        const latest = await this.vaultReader.sources();
        const current = latest.sources.find(item => item.path === source.path);
        if (!current) throw new Error("资料尚未读取或已经变化，请检查来源");
        this.renderSourceCard(container, current, latest.related, true, close);
        container.createEl("button", { text: "打开资料记录", attr: { type: "button" } }).addEventListener("click", () => void this.openPath(source.path).then(close));
      });
    });
    card.createDiv({ cls: "okf-dashboard__muted", text: [source.kind, resourceHost(source.resource), relativeMoment(source.modified_at)]
      .filter(Boolean).join(" · ") });
    const actions = card.createDiv({ cls: "okf-dashboard__actions" });
    const hasOriginal = Boolean(originalReference(source.resource));
    if (hasOriginal) {
      const original = actions.createEl("button", { text: "打开原件", attr: { type: "button" } });
      original.addEventListener("click", () => { void runUiAction(original, async () => {
        const originals = this.plugin.originalFiles;
        if (!originals) throw new Error("原件访问尚未初始化");
        await originals.openNote(source.path);
        afterOpen?.();
      }, message => new Notice(message)); });
    }
    if (source.text_path) {
      const text = actions.createEl("button", { text: "打开资料正文", attr: { type: "button" } });
      text.addEventListener("click", () => void this.openPath(source.text_path!).then(afterOpen));
    }
    if (detailed && !this.plugin.isMobile) {
      if (hasOriginal) {
        const convert = actions.createEl("button", { text: source.text_path ? "重新转换原件" : "转换正文", attr: { type: "button" } });
        convert.addEventListener("click", () => void runUiAction(convert, async () => {
        if (source.text_path) {
          await this.plugin.ensureLocalServiceAvailable();
          const records = await this.api().conversions();
          const record = records.filter(item => normalizedVaultPath(item.outputs.source) === normalizedVaultPath(source.path))
            .sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? ""))[0];
          if (!record) throw new Error("没有可恢复的转换记录；可打开原件或已有正文");
          this.plugin.promptDocumentReconversion(record);
        } else await this.plugin.processSourceOriginal(source.path, this.importContext());
        }, message => new Notice(message)));
      }
      for (const [label, intent] of [["添加学习用途", "learn"], ["添加知识用途", "wiki"], ["添加参考用途", "source"]] as const) {
        actions.createEl("button", { text: label, attr: { type: "button" } }).addEventListener("click", () =>
          this.plugin.promptRoutePendingSource(source.path, intent,
            this.config.course || this.config.project ? this.importContext() : undefined));
      }
    }
    if (!detailed) {
      card.createDiv({ cls: "okf-source-summary", text: [source.text_path ? "正文可读" : "尚无正文", `用途 ${source.uses?.length ?? (source.purpose ? 1 : 0)}`,
        ...(source.uses ?? []).slice(0, 2).map(use => `${({ study: "学习", wiki: "知识", reference: "参考", undecided: "待判断" } as Record<string, string>)[use.purpose] ?? use.purpose} · ${learningContextLabel({ ...source, ...use }, this.relationTitlesForNote(use))}`)].join(" · ") });
      actions.createEl("button", { text: "查看资料", cls: "okf-dashboard__ghost-action", attr: { type: "button" } }).addEventListener("click", () => title.click());
      return;
    }
    const details = card.createEl("details");
    details.dataset.stateKey = `source:${source.path}`;
    details.open = true;
    details.createEl("summary", { text: `用途与关联成果 · ${source.uses?.length ?? (source.purpose ? 1 : 0)}` });
    const uses = source.uses?.length ? source.uses : source.purpose
      ? [{ purpose: source.purpose, course: source.course, project: source.project }] : [];
    for (const use of uses) {
      const note = { ...source, purpose: use.purpose, course: use.course, project: use.project };
      const row = details.createDiv({ cls: "okf-source-use" });
      const label = ({ study: "学习", wiki: "知识", reference: "参考", undecided: "未决定" } as Record<string, string>)[use.purpose] ?? use.purpose;
      row.createDiv({ text: `${label} · ${learningContextLabel(note, this.relationTitlesForNote(note))}` });
      if (use.purpose === "undecided") this.pendingSourceActions(row, note);
      if (["study", "wiki"].includes(use.purpose)) {
        const matches = related.filter((item) => (item.source_paths ?? []).some((path) => normalizedVaultPath(path) === normalizedVaultPath(source.path)) &&
          normalizedVaultPath(item.course) === normalizedVaultPath(use.course) && normalizedVaultPath(item.project) === normalizedVaultPath(use.project) &&
          (use.purpose === "study" ? item.note_type === "Study Guide" : item.note_type === "Wiki"));
        if (matches.length) {
          this.pageItems(row, matches, (container, item) => this.compactRow(container, item.title,
            noteTypeLabel(item.note_type), "打开", () => void this.openPath(item.path).then(afterOpen)));
        } else if (source.text_path) this.pendingGenerationActions(row, note,
          this.semanticOperationForNote(note, this.semanticOperationsByTarget()), true);
        else this.pendingGenerationActions(row, note, undefined, true);
      }
    }
    const records = card.createEl("details", { cls: "okf-source-processing" });
    records.createEl("summary", { text: "转换与生成记录" });
    const conversions = this.plugin.conversionSnapshot?.().filter(item => normalizedVaultPath(item.outputs.source) === normalizedVaultPath(source.path)) ?? [];
    const operations = this.plugin.semanticOperationsSnapshot().filter(item => item.sources.some(path =>
      normalizedVaultPath(path) === normalizedVaultPath(source.path) || source.text_path && normalizedVaultPath(path) === normalizedVaultPath(source.text_path)));
    for (const record of [...conversions, ...operations]) records.createEl("button", { text: "operation_id" in record ? semanticStageLabel(record) : conversionStatusLabel(record), attr: { type: "button" } })
      .addEventListener("click", () => this.openProcessingDetails(record));
    if (!conversions.length && !operations.length) records.createDiv({ text: "当前尚未读取到关联的处理记录。", cls: "okf-dashboard__muted" });
  }

  private async renderKnowledge(container: HTMLElement): Promise<void> {
    const data = await this.vaultReader.knowledge();
    if (this.closed || !container.isConnected) return;
    data.notes = this.displayNotes(this.scopeNotes(data.notes));
    data.pending_wiki = this.displayNotes(this.scopeNotes(data.pending_wiki));
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const create = actions.createEl("button", {
      text: "从材料生成知识笔记",
      cls: "okf-dashboard__secondary-action",
    });
    create.addEventListener("click", () => this.plugin.promptWikiFromSources());
    const newMap = actions.createEl("button", { text: "新建知识导航", attr: { type: "button" } });
    newMap.addEventListener("click", () => this.plugin.promptNewWikiMap());

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
      { value: "all" as const, label: "知识目录", count: data.notes.length },
      { value: "pending" as const, label: "待生成", count: data.pending_wiki.length },
      { value: "wiki" as const, label: "知识笔记", count: data.notes.filter((note) => note.note_type === "Wiki").length },
      { value: "map" as const, label: "知识导航", count: data.notes.filter((note) => note.note_type === "Wiki Map").length },
      { value: "unverified" as const, label: "待核验 AI 内容", count: data.notes.filter((note) => note.ai_unverified).length },
      { value: "stale" as const, label: "需要复核", count: data.notes.filter((note) => note.stale).length },
      { value: "deprecated" as const, label: "已弃用", count: data.notes.filter((note) => note.status === "deprecated").length },
    ];
    const operations = this.semanticOperationsByTarget();
    const facets = container.createDiv({ cls: "okf-catalog-facets" });
    const list = container.createDiv({ cls: "okf-dashboard__compact-list okf-knowledge-list" });
    const facet = (label: string, key: string, value: string, options: Record<string, string>, apply: (value: string) => void): void => {
      const field = facets.createEl("label", { text: label });
      const select = field.createEl("select", { attr: { "aria-label": label } });
      for (const [id, text] of Object.entries(options)) select.createEl("option", { text, attr: { value: id } });
      select.value = value;
      select.addEventListener("change", () => { apply(select.value);
        this.updatePageState("knowledge", { filters: { [key]: select.value } }); renderList(); });
    };
    const renderList = (): void => {
      list.empty();
      facets.hidden = this.knowledgeFilter === "pending";
      const query = this.knowledgeQuery.trim().toLocaleLowerCase();
      const pending = data.pending_wiki.filter((note) =>
        this.knowledgeFilter === "pending" &&
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
          return matchesQuery && matchesFilter &&
            (this.knowledgeType === "all" || note.note_type === this.knowledgeType) &&
            (this.knowledgeStatus === "all" || note.status === this.knowledgeStatus) &&
            (this.knowledgeMaintenance === "all" ||
              this.knowledgeMaintenance === "unverified" && note.ai_unverified ||
              this.knowledgeMaintenance === "stale" && note.stale);
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
      this.pageItems(list, pending, (parent, note) => {
        const row = parent.createDiv({
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
          text: `待生成知识笔记 · ${learningContextLabel(note, this.relationTitlesForNote(note))}`,
        });
        this.pendingGenerationActions(row, note, this.semanticOperationForNote(note, operations));
      });
      this.pageItems(list, visible, (parent, note) => {
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
          parent,
          note.title,
          meta,
          note.ai_unverified ? "打开核验" : "打开",
          () => void this.openPath(note.path),
          badges[0],
        );
        row.dataset.noteType = note.note_type;
        if (note.note_type === "Wiki Map" && !this.plugin.isMobile) {
          row.createEl("button", { text: "维护导航", attr: { type: "button" } }).addEventListener("click", () => {
            void this.copyPrompt("请读取附带的知识导航和相关真实知识笔记，按本消息中的要求维护导航关系，保留人工内容。",
              { contextPaths: [note.path], actionMode: "write", skill: "maintain-wiki-map" });
          });
        }
        if (badges.length > 1) {
          const badgeContainer = row.createDiv({ cls: "okf-dashboard__badges" });
          for (const badge of badges.slice(1)) badgeContainer.createSpan({ cls: "okf-dashboard__badge", text: badge });
        }
      });
    };
    facet("类型", "noteType", this.knowledgeType, { all: "全部类型", Wiki: "知识笔记", "Wiki Map": "知识导航" },
      value => { this.knowledgeType = value; });
    facet("内容状态", "contentStatus", this.knowledgeStatus,
      { all: "全部状态", stable: "正常", draft: "草稿", deprecated: "弃用" }, value => { this.knowledgeStatus = value; });
    facet("维护", "maintenance", this.knowledgeMaintenance,
      { all: "全部", unverified: "待核验", stale: "需要复核" }, value => { this.knowledgeMaintenance = value; });
    for (const option of options.filter((item) => ["all", "pending"].includes(item.value))) {
      const button = filters.createEl("button", {
        text: `${option.label} ${option.count}`,
        cls: this.knowledgeFilter === option.value ? "is-active" : "",
        attr: { type: "button", role: "tab", "aria-selected": String(this.knowledgeFilter === option.value) },
      });
      button.addEventListener("click", () => {
        this.knowledgeFilter = option.value;
        this.updatePageState("knowledge", { filters: { view: option.value } });
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
      this.updatePageState("knowledge", { filters: { query: search.value } });
      renderList();
    });
    renderList();
  }

  private async renderLife(container: HTMLElement): Promise<void> {
    const payload = await this.vaultReader.life();
    if (this.closed || !container.isConnected) return;
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
    const more = actions.createEl("button", { text: "其他操作 ▾", attr: { type: "button" } });
    this.attachActionPanel(more, { label: "日记与复盘操作", actions: [
      { id: "calendar", title: "打开日历", description: "按日期查找日记", onSelect: () => this.plugin.openChineseCalendar() },
      ...(!this.plugin.isMobile ? [{ id: "organize-daily", title: "整理今日日记", description: "保留原文，整理当前日记", onSelect: () => this.plugin.organizeTodayInCodex() }] : []),
    ] });
    const filters = container.createDiv({ cls: "okf-catalog-facets okf-life-filters" });
    const field = (name: string) => { const label = filters.createEl("label"); label.createSpan({ text: name }); return label; };
    const type = field("类型").createEl("select", { attr: { "aria-label": "日记与复盘类型" } });
    for (const [value, label] of Object.entries({ all: "全部", Daily: "日记", Reflection: "反思", Review: "复盘" })) type.createEl("option", { text: label, attr: { value } });
    type.value = this.lifeType;
    const search = field("搜索").createEl("input", { attr: { type: "search", "aria-label": "搜索日记与复盘", placeholder: "搜索标题与内容…" } });
    search.value = this.lifeQuery;
    const from = field("起始日期").createEl("input", { attr: { type: "date", "aria-label": "起始日期" } }); from.value = this.lifeFrom;
    const to = field("结束日期").createEl("input", { attr: { type: "date", "aria-label": "结束日期" } }); to.value = this.lifeTo;
    container.createDiv({ cls: "okf-dashboard__muted", text: "日记按记录日期筛选；反思与复盘按创建日期筛选。" });
    const output = container.createDiv();
    const renderList = () => {
    output.empty();
    if (this.lifeFrom && this.lifeTo && this.lifeFrom > this.lifeTo) { output.createDiv({ cls: "okf-dashboard__error", text: "起始日期不能晚于结束日期。" }); return; }
    const query = this.lifeQuery.trim().toLocaleLowerCase();
    const notes = payload.notes.filter(note => {
      const date = note.note_type === "Daily" ? /\d{4}-\d{2}-\d{2}/u.exec(note.path)?.[0] : note.created_at?.slice(0, 10);
      return (this.lifeType === "all" || note.note_type === this.lifeType) && (!query || `${note.title} ${note.excerpt}`.toLocaleLowerCase().includes(query))
        && (!this.lifeFrom || Boolean(date && date >= this.lifeFrom)) && (!this.lifeTo || Boolean(date && date <= this.lifeTo));
    });
    const dailyNotes = notes.filter((note) => note.path.startsWith("life/daily/"));
    const reflections = notes.filter((note) => note.path.startsWith("life/reflections/"));
    const reviews = notes.filter((note) => note.path.startsWith("life/reviews/"));
    const lifeLayout = output.createDiv({ cls: "okf-life-layout" });
    const dailySection = this.dashboardSection(
      lifeLayout,
      "日记",
      "查看最近日记，或打开日历查找其他日期。",
      "okf-life-section okf-life-section--daily",
    );
    this.renderLifeNoteCards(dailySection, this.displayNotes(dailyNotes), "还没有日记。", true);

    const lifeSide = lifeLayout.createDiv({ cls: "okf-life-layout__side" });
    const reflectionSection = this.dashboardSection(
      lifeSide,
      "反思",
      "值得单独成篇的观察、困惑和思考。",
      "okf-life-section",
    );
    this.renderLifeNoteCards(reflectionSection, reflections, "还没有独立反思。", true);

    if (reviews.length) {
      const reviewSection = this.dashboardSection(
        output,
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
        this.renderLifeNoteCards(group, selected, "", true);
      }
    }
    };
    const update = () => {
      this.lifeType = type.value; this.lifeQuery = search.value; this.lifeFrom = from.value; this.lifeTo = to.value;
      this.updatePageState("life", { filters: { type: this.lifeType, query: this.lifeQuery, from: this.lifeFrom, to: this.lifeTo } }); renderList();
    };
    type.addEventListener("change", update); search.addEventListener("input", update); from.addEventListener("change", update); to.addEventListener("change", update);
    renderList();
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
    this.pageItems(cards, this.displayNotes(notes), (parent, note) => {
      this.compactRow(
        parent,
        note.title,
        [noteTypeLabel(note.note_type), relativeMoment(note.modified_at)].filter(Boolean).join(" · "),
        "打开",
        () => void this.openPath(note.path),
      );
    });
  }

  private inboxActions(parent: HTMLElement, note: NoteSummary): void {
    if (this.plugin.isMobile) {
      parent.createEl("button", { text: "打开记录" })
        .addEventListener("click", () => void this.openPath(note.path));
      return;
    }
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
    const tabs = container.createDiv({ cls: "okf-dashboard__segments", attr: { role: "tablist" } });
    for (const [value, label] of [["processing", "后台处理"], ["diagnostics", "系统诊断"]] as const) {
      const tab = tabs.createEl("button", { text: label, cls: this.systemTab === value ? "is-active" : "",
        attr: { type: "button", role: "tab", "aria-selected": String(this.systemTab === value) } });
      tab.addEventListener("click", () => { this.systemTab = value;
        this.updatePageState("system", { tab: value }); void this.render(true); });
    }
    if (this.systemTab === "processing") {
      if (!this.plugin.isMobile) this.renderBackgroundTasks(container, true);
      else container.createDiv({ text: "后台执行由电脑处理，这里显示已同步的请求与结果。" });
      await renderSyncedImports(this.app, container.createDiv(), this.plugin.originalFiles);
      return;
    }
    if (this.plugin.isMobile) {
      container.createDiv({ text: "移动端可使用本地工作台和资料提交，后台转换在电脑上线后执行。" });
      container.createEl("button", { text: "插件设置" })
        .addEventListener("click", () => this.plugin.openPluginSettings());
      await renderSyncedImports(this.app, container.createDiv(), this.plugin.originalFiles);
      return;
    }
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
          this.renderProcessingLink(items, "查看失败转换与恢复");
        } else if (item.item_id === "semantic-operations" && item.status === "failed") {
          this.renderProcessingLink(items, "查看失败生成与恢复");
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

  private renderProcessingLink(parent: HTMLElement, label: string): void {
    parent.createEl("button", { text: label, attr: { type: "button" } }).addEventListener("click", () => {
      this.systemTab = "processing";
      this.updatePageState("system", { tab: "processing" });
      void this.render(true);
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
    for (const operation of [...this.plugin.semanticOperationsSnapshot()].filter((item) => item.status !== "superseded")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))) {
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
      ));
    }
    if (note.purpose === "study") {
      return operations.get(semanticSourceOperationKey(
        path,
        "generate-study-guide",
        note.course,
        note.project,
      )) ??
        operations.get(semanticSourceOperationKey(
          path,
          "refresh-study-guide",
          note.course,
          note.project,
        ));
    }
    return undefined;
  }

  private async runButtonAction(
    button: HTMLButtonElement,
    action: () => Promise<unknown>,
    refresh = false,
    success?: string,
  ): Promise<void> {
    await runUiAction(button, async () => {
      await this.plugin.ensureLocalServiceAvailable();
      await action();
      if (refresh) await this.render();
    }, message => new Notice(message, 10_000), success);
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
  public readonly navigationHistory: Record<string, unknown>[] = [];
  private section: Section;
  private workbenchPath: string | undefined;
  private config: Record<string, unknown> | undefined;
  private stateKey: string | undefined;
  private surface: OkfDashboardView | undefined;

  public constructor(
    private readonly hostLeaf: WorkspaceLeaf,
    private readonly plugin: OkfBrainPlugin,
  ) {
    super(hostLeaf);
    this.section = plugin.getDashboardUiState().activeSection;
  }

  public getViewType(): string { return OKF_DASHBOARD_VIEW; }
  public getDisplayText(): string {
    const taskView = this.config?.taskView;
    return `工作台 · ${this.section === "tasks" || this.section === "today" && typeof taskView === "string" && taskView !== "overview"
      ? `任务 · ${taskViewTitle(String(taskView ?? "all"))}` : this.section === "reading" && this.config?.readingView === "daily-updates" ? "每日更新" : PAGE_COPY[this.section].title}`;
  }
  public getIcon(): string { return "brain-circuit"; }
  public rememberNavigation(): void {
    const state = this.getState();
    delete state.navigationHistory;
    this.navigationHistory.push(state);
  }
  public getState(): Record<string, unknown> {
    const state = this.plugin.getDashboardUiState();
    const page = this.stateKey ? state.instances?.[this.stateKey] : state.pages[this.section];
    return { section: this.section, ...(this.workbenchPath ? { workbenchPath: this.workbenchPath } : {}),
      config: this.surface?.navigationConfig() ?? this.config ?? {}, navigationHistory: [...this.navigationHistory], ...(this.stateKey ? { stateKey: this.stateKey } : {}),
      ...(this.surface && page ? { pageUiState: { ...page, scrollTop: this.contentEl.querySelector<HTMLElement>(".okf-dashboard")?.scrollTop ?? page.scrollTop } } : {}) };
  }

  public async setState(state: unknown, _result: ViewStateResult): Promise<void> {
    const candidate = state && typeof state === "object"
      ? (state as Record<string, unknown>).section
      : undefined;
    if (typeof candidate !== "string" || !Object.hasOwn(PAGE_COPY, candidate)) return;
    const history = (state as Record<string, unknown>).navigationHistory;
    if (Array.isArray(history)) this.navigationHistory.splice(0, this.navigationHistory.length,
      ...history.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry))));
    const legacyTaskView = (state as Record<string, unknown>).config as Record<string, unknown> | undefined;
    const section: Section = candidate === "today" && legacyTaskView?.taskView && legacyTaskView.taskView !== "overview" ? "tasks" : candidate as Section;
    const workbenchPath = typeof (state as Record<string, unknown>).workbenchPath === "string"
      ? (state as Record<string, string>).workbenchPath
      : undefined;
    const configValue = (state as Record<string, unknown>).config;
    const config = configValue && typeof configValue === "object" && !Array.isArray(configValue)
      ? configValue as Record<string, unknown> : undefined;
    const stateKey = typeof (state as Record<string, unknown>).stateKey === "string"
      ? (state as Record<string, string>).stateKey : undefined;
    const page = (state as Record<string, unknown>).pageUiState;
    if (section === this.section && workbenchPath === this.workbenchPath &&
      JSON.stringify(config) === JSON.stringify(this.config) && stateKey === this.stateKey && !page) return;
    this.section = section;
    this.workbenchPath = workbenchPath;
    this.config = config;
    this.stateKey = stateKey;
    this.containerEl.querySelector<HTMLElement>(".view-header-title")?.setText(this.getDisplayText());
    if (this.surface) {
      await this.surface.onClose();
      this.surface = undefined;
      if (page && typeof page === "object" && !Array.isArray(page)) this.plugin.updateDashboardPageUiState(section, page as DashboardPageUiStatePatch, stateKey);
      await this.mountSurface();
    } else if (page && typeof page === "object" && !Array.isArray(page)) this.plugin.updateDashboardPageUiState(section, page as DashboardPageUiStatePatch, stateKey);
  }

  public async onOpen(): Promise<void> {
    await this.mountSurface();
  }

  public async refresh(): Promise<void> { await this.surface?.refresh(); }

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
      config: this.config,
      instanceKey: this.stateKey,
    });
    this.surface = surface;
    await surface.onOpen();
  }
}

function taskViewTitle(view: string): string {
  return TASK_VIEW_LABELS[view as keyof typeof TASK_VIEW_LABELS] ?? TASK_VIEW_LABELS.all;
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

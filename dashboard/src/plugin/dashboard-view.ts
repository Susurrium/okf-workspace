import { ItemView, Notice, TFile, WorkspaceLeaf, type App } from "obsidian";

import { LocalApi } from "../api/client.js";
import type {
  ConversionRecord,
  NoteSummary,
  SemanticOperationRecord,
  SystemItem,
  SystemStatus,
} from "../api/types.js";
import {
  buildInboxWorkQueue,
  filterInboxItems,
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
  dashboardLearningScopeCounts,
  filterDashboardLearningScope,
  selectDashboardContinueItems,
  type DashboardLearningContext,
} from "../domain/dashboard-experience.js";
import { aiDailyPreviewStreamTitle } from "../domain/ai-daily-preview.js";
import {
  isSemanticOperationActive,
  isSemanticOperationRetryable,
} from "../domain/semantic-operation-state.js";
import type {
  FeedDashboardDigest,
  FeedDigestEdition,
  FeedDigestItem,
  FeedKind,
} from "../feeds/types.js";
import { DASHBOARD_VERSION } from "../version.js";
import type OkfBrainPlugin from "./main.js";
import type { CodexHandoffRequest } from "./claudian-bridge.js";
import { VaultDashboardReader, type InboxProjection } from "./vault-dashboard.js";

export const OKF_DASHBOARD_VIEW = "okf-workspace-dashboard";
export type DashboardSection =
  | "today"
  | "inbox"
  | "learning"
  | "projects"
  | "knowledge"
  | "life"
  | "system";
type Section = DashboardSection;
type TodayPane = "actions" | "reading";
type LearningContextFilter = "all" | DashboardLearningContext;

const NAVIGATION: readonly { id: Section; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "inbox", label: "Inbox" },
  { id: "learning", label: "Learning" },
  { id: "projects", label: "Projects" },
  { id: "knowledge", label: "Knowledge" },
  { id: "life", label: "Life" },
];

const PAGE_COPY: Readonly<Record<Section, { title: string; description: string }>> = {
  today: { title: "Today", description: "现在值得处理、继续和阅读的内容。" },
  inbox: { title: "Inbox", description: "处理尚未确定去向的输入，并查看文件转换进度。" },
  learning: { title: "Learning", description: "继续学习，或准备下一份 Study Guide。" },
  projects: { title: "Projects", description: "聚焦进行中项目的状态和唯一下一步。" },
  knowledge: { title: "Knowledge", description: "搜索、阅读和维护 Wiki 与 Wiki Map。" },
  life: { title: "Life", description: "书写今天，回看最近的记录与复盘。" },
  system: { title: "System", description: "只处理异常、后台任务和高级维护。" },
};

/** Resolves the concrete Vault files a Study Guide hands to Codex. */
export async function resolveDashboardLearningSources(
  app: App,
  notePath: string,
): Promise<string[]> {
  const note = app.vault.getAbstractFileByPath(notePath);
  if (!(note instanceof TFile)) return [];
  const candidates = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const normalized = value.replace(/^\/+|\/+$/gu, "");
    if (normalized && app.vault.getAbstractFileByPath(normalized) instanceof TFile) {
      candidates.add(normalized);
    }
  };
  const frontmatter = app.metadataCache.getFileCache(note)?.frontmatter;
  const sources = frontmatter?.sources;
  if (Array.isArray(sources)) {
    for (const source of sources) {
      if (source && typeof source === "object") add((source as { resource?: unknown }).resource);
      else add(source);
    }
  }
  for (const sourcePath of [...candidates]) {
    const source = app.vault.getAbstractFileByPath(sourcePath);
    if (!(source instanceof TFile)) continue;
    const sourceFrontmatter = app.metadataCache.getFileCache(source)?.frontmatter;
    add(sourceFrontmatter?.text);
    add(sourceFrontmatter?.extract);
    const markdown = await app.vault.cachedRead(source);
    for (const match of markdown.matchAll(/\]\(\/?(sources\/(?:text|extracts)\/[^)]+\.md)\)/gu)) {
      add(match[1]);
    }
  }
  return [...candidates];
}

export class OkfDashboardView extends ItemView {
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
  private readonly expandedProjectPaths = new Set<string>();
  private readonly pageScroll = new Map<Section, number>();
  private readonly feedScroll: Partial<Record<FeedKind, number>> = {};
  private readonly feedScrollPersistTimers: Partial<Record<FeedKind, number>> = {};
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
  ) {
    super(leaf);
    this.vaultReader = new VaultDashboardReader(this.app);
    const state = this.plugin.getDashboardUiState();
    this.section = state.activeSection;
    for (const [section, page] of Object.entries(state.pages)) {
      this.pageScroll.set(section as Section, page.scrollTop);
    }
    this.feedScroll["ai-daily"] = state.feeds["ai-daily"].scrollTop;
    this.feedScroll.treehole = state.feeds.treehole.scrollTop;
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
    const expandedProjects = state.pages.projects.filters.expanded;
    if (typeof expandedProjects === "string") {
      for (const path of parseStoredPaths(expandedProjects)) this.expandedProjectPaths.add(path);
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
    return "Dashboard";
  }

  public getIcon(): string {
    return "brain-circuit";
  }

  public async onOpen(): Promise<void> {
    this.contentEl.addEventListener("scroll", this.handlePageScroll, { passive: true });
    this.contentEl.addEventListener("pointerdown", this.markDashboardInteraction, { passive: true });
    this.contentEl.addEventListener("keydown", this.markDashboardInteraction);
    await this.render();
  }

  public async onClose(): Promise<void> {
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
    for (const kind of ["ai-daily", "treehole"] as const) {
      const timer = this.feedScrollPersistTimers[kind];
      if (timer !== undefined) window.clearTimeout(timer);
      delete this.feedScrollPersistTimers[kind];
      const scrollTop = this.feedScroll[kind];
      if (scrollTop !== undefined) {
        this.plugin.updateDashboardFeedUiState(kind, { scrollTop });
      }
    }
    const scrollTop = this.contentEl.scrollTop;
    this.pageScroll.set(this.section, scrollTop);
    this.plugin.updateDashboardPageUiState(this.section, { scrollTop });
  }

  public async refresh(): Promise<void> {
    this.scheduleExternalRefresh();
  }

  private api(): LocalApi {
    return new LocalApi(this.plugin.settings.baseUrl, this.plugin.settings.token);
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
    root.empty();
    root.addClass("okf-dashboard");
    const topbar = root.createDiv({ cls: "okf-dashboard__topbar" });
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
    const utilities = topbar.createDiv({ cls: "okf-dashboard__utilities" });
    const search = utilities.createEl("button", {
      text: "搜索",
      cls: "okf-dashboard__ghost-action okf-dashboard__search-action",
      attr: { type: "button", "aria-label": "搜索 Vault" },
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
      text: "System",
      cls: this.section === "system" ? "is-active okf-dashboard__ghost-action" : "okf-dashboard__ghost-action",
      attr: { type: "button", "aria-label": "系统状态与设置" },
    });
    settings.addEventListener("click", () => {
      this.openSection("system");
    });
    const body = root.createDiv({ cls: "okf-dashboard__body" });
    const pageHeader = body.createDiv({ cls: "okf-dashboard__page-header" });
    const pageCopy = PAGE_COPY[this.section];
    const heading = pageHeader.createDiv();
    heading.createEl("h2", { text: pageCopy.title });
    heading.createDiv({ cls: "okf-dashboard__muted", text: pageCopy.description });
    const loading = body.createDiv({ cls: "okf-dashboard__loading", text: "正在读取本地笔记…" });
    try {
      if (this.section === "today") await this.renderToday(body);
      else if (this.section === "inbox") await this.renderInbox(body);
      else if (this.section === "system") await this.renderSystem(body);
      else if (this.section === "life") await this.renderLife(body);
      else if (this.section === "learning") await this.renderLearning(body);
      else if (this.section === "projects") await this.renderProjects(body);
      else await this.renderKnowledge(body);
    } catch (error) {
      if (renderVersion !== this.renderVersion) return;
      const failure = body.createDiv({
        cls: "okf-dashboard__error",
        text: error instanceof Error ? error.message : "Dashboard 加载失败",
      });
      const retry = failure.createEl("button", { text: "重新加载" });
      retry.addEventListener("click", () => void this.render());
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
      ["queued", "converting", "waiting-for-mineru"].includes(conversion.status),
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
      card.createEl("strong", { text: isWiki ? "Wiki 生成" : "学习材料生成" });
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
      const open = card.createEl("button", {
        text: operation.status === "completed" ? "打开结果" : "打开目标笔记",
      });
      open.addEventListener("click", () => void this.openPath(operation.target));
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
      const label =
        conversion.status === "queued"
          ? "已排队"
          : conversion.status === "converting"
            ? `正在使用 ${conversion.parser} 转换`
            : conversion.status === "waiting-for-mineru"
              ? "等待 MinerU"
              : conversion.status === "imported"
                ? "已导入"
                : readyToPublish
                  ? "转换已完成，待继续归档"
                  : "需要处理";
      card.createDiv({ cls: "okf-dashboard__muted", text: label });
      if (conversion.error) {
        card.createDiv({ text: readyToPublish ? `上次归档失败：${conversion.error}` : conversion.error });
      }
      for (const warning of conversion.warnings ?? []) {
        card.createDiv({ cls: "okf-dashboard__muted", text: warning });
      }
      const target =
        conversion.outputs.routed_target ??
        conversion.outputs.source_text ??
        conversion.outputs.source;
      if (target) {
        const open = card.createEl("button", { text: "打开结果" });
        open.addEventListener("click", () => void this.openPath(target));
      }
      if (readyToPublish) {
        const resume = card.createEl("button", { text: "继续归档" });
        resume.addEventListener("click", () => {
          void this.runButtonAction(resume, async () => {
            const record = await this.api().retryConversion(conversion.conversion_id);
            this.plugin.watchDocumentConversion(record.conversion_id);
          }, true, "已继续归档；不会重新转换文档");
        });
      }
    }
  }

  private async renderToday(container: HTMLElement): Promise<void> {
    const data = await this.vaultReader.today();
    const inbox = await this.vaultReader.inbox();
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
    importDocument.addEventListener("click", () => this.plugin.promptDocumentImport());

    const paneTabs = container.createDiv({
      cls: "okf-dashboard__segments okf-today-pane-tabs",
      attr: { role: "tablist", "aria-label": "Today 内容" },
    });
    for (const option of [
      { value: "actions" as const, label: "行动" },
      { value: "reading" as const, label: "今日阅读" },
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
      attr: { "aria-label": "今日阅读" },
    });

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
      actionPane,
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
          ? `Study Guide · ${recentlyOpened ? "最近打开" : "可学习"}`
          : item.kind === "project"
            ? `Project · 下一步：${compactText(project?.next_action || "尚未填写", 90)}`
            : `Course · ${course?.current_progress || `${course?.lesson_count ?? 0} 篇 Lesson`}`;
        this.compactRow(
          list,
          item.note.title,
          meta,
          "打开",
          () => void this.openPath(item.note.path),
        );
      }
    } else {
      continuing.createDiv({ cls: "okf-dashboard__empty", text: "目前没有可继续的学习、课程或项目。" });
    }

    const pending = this.dashboardSection(
      actionPane,
      "待处理",
      "只显示需要你处理或确认的事项。",
      "okf-today-pending",
    );
    const attention = pending.createDiv({
      cls: "okf-dashboard__attention-strip is-vertical",
      attr: { "aria-label": "待处理" },
    });
    this.attentionItem(attention, "Inbox", attentionCounts.inbox_decisions, () => {
      this.inboxTab = "decision";
      this.plugin.updateDashboardPageUiState("inbox", { tab: "decision" });
      this.openSection("inbox");
    });
    this.attentionItem(attention, "待生成 Study Guide", attentionCounts.pending_study, () => {
      this.learningTab = "pending";
      this.learningContext = "all";
      this.learningRelationPath = "";
      this.plugin.updateDashboardPageUiState("learning", {
        tab: "pending",
        filters: { context: "all", relation: null },
      });
      this.openSection("learning");
    });
    this.attentionItem(attention, "待生成 Wiki", attentionCounts.pending_wiki, () => {
      this.knowledgeFilter = "pending";
      this.plugin.updateDashboardPageUiState("knowledge", { filters: { view: "pending" } });
      this.openSection("knowledge");
    });
    this.attentionItem(attention, "后台运行", attentionCounts.background_running, () => {
      this.taskCenterOpen = true;
      void this.render(true);
    });
    this.attentionItem(
      attention,
      "异常",
      attentionCounts.background_failed,
      () => this.openSection("system"),
      true,
    );
    this.attentionItem(attention, "知识待复核", data.stale_knowledge.length, () => {
      this.knowledgeFilter = "stale";
      this.plugin.updateDashboardPageUiState("knowledge", { filters: { view: "stale" } });
      this.openSection("knowledge");
    });
    if (!attention.childElementCount) pending.remove();

    if (data.tasks.length) {
      const tasks = this.dashboardSection(
        actionPane,
        "待办",
        `${data.tasks.length} 项未完成；这里显示前 4 项。`,
        "okf-today-tasks",
      );
      const list = tasks.createDiv({ cls: "okf-dashboard__compact-list" });
      for (const item of data.tasks.slice(0, 4)) {
        this.compactRow(
          list,
          compactText(item.text, 100),
          relationName(item.path),
          "打开",
          () => void this.openPath(item.path),
        );
      }
      if (data.tasks.length > 4) {
        const more = tasks.createEl("button", { text: "查看全部待办", cls: "okf-dashboard__ghost-action" });
        more.addEventListener("click", () => void this.openPath("system/views/Tasks.md"));
      }
    }

    this.renderFeedLoading(readingPane);

    void this.api()
      .systemStatus()
      .then((system) => {
        if (!system.actionable.length || !actionPane.isConnected) return;
        const warning = actionPane.createDiv({ cls: "okf-dashboard__inline-alert" });
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

  private pendingCaptureLinks(parent: HTMLElement, captures: readonly NoteSummary[]): void {
    for (const capture of captures.slice(0, 3)) {
      const open = parent.createEl("button", {
        text: `待整理：${compactText(capture.title, 36)}`,
        cls: "okf-dashboard__ghost-action",
        attr: { type: "button" },
      });
      open.addEventListener("click", () => void this.openPath(capture.path));
    }
    if (captures.length > 3) {
      const inbox = parent.createEl("button", {
        text: `其余 ${captures.length - 3} 条去 Inbox`,
        cls: "okf-dashboard__ghost-action",
        attr: { type: "button" },
      });
      inbox.addEventListener("click", () => {
        this.inboxTab = "decision";
        this.plugin.updateDashboardPageUiState("inbox", { tab: "decision" });
        this.openSection("inbox");
      });
    }
  }

  private openSection(section: Section): void {
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
    const focused = document.activeElement;
    const editing = focused instanceof HTMLElement &&
      this.contentEl.contains(focused) &&
      (focused.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName));
    const recentlyInteracting = Date.now() - this.lastInteractionAt < 1_200;
    const recentlyRendered = Date.now() - this.lastRenderAt < 350;
    const delay = editing || recentlyInteracting ? 1_200 : recentlyRendered ? 350 : 180;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      const active = document.activeElement;
      const stillEditing = active instanceof HTMLElement &&
        this.contentEl.contains(active) &&
        (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
      if (stillEditing || Date.now() - this.lastInteractionAt < 1_200) {
        this.scheduleExternalRefresh();
        return;
      }
      void this.render(true);
    }, delay);
  }

  private renderFeedLoading(parent: HTMLElement): void {
    const reading = this.dashboardSection(
      parent,
      "今日阅读",
      "先快速浏览关键信息；完整内容和人工判断仍在原生 Digest。",
      "okf-dashboard__reading",
    );
    const shelf = reading.createDiv({ cls: "okf-feed-shelf" });
    const aiDaily = shelf.createEl("section", {
      cls: "okf-feed-project okf-feed-project--ai-daily",
    });
    const aiHeader = aiDaily.createDiv({ cls: "okf-feed-project__header" });
    const aiHeading = aiHeader.createDiv({ cls: "okf-feed-project__heading" });
    aiHeading.createEl("h3", { text: "AI Daily" });
    const aiMeta = aiHeading.createDiv({ cls: "okf-dashboard__muted", text: "正在读取最新一期…" });
    const treehole = shelf.createEl("section", {
      cls: "okf-feed-project okf-feed-project--treehole",
    });
    const treeholeHeader = treehole.createDiv({ cls: "okf-feed-project__header" });
    const treeholeHeading = treeholeHeader.createDiv({ cls: "okf-feed-project__heading" });
    treeholeHeading.createEl("h3", { text: "树洞热榜" });
    const treeholeMeta = treeholeHeading.createDiv({ cls: "okf-dashboard__muted", text: "正在读取最新一期…" });
    const aiContent = aiDaily.createDiv({ cls: "okf-feed-project__scroll" });
    const treeholeContent = treehole.createDiv({ cls: "okf-feed-project__scroll" });
    const openDigestWithFeedback = (
      button: HTMLButtonElement,
      kind: FeedKind,
      digestId: string,
    ): void => {
      if (button.disabled) return;
      button.disabled = true;
      void this.plugin.openFeedDigest(kind, digestId)
        .catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : "无法打开 Feed Digest", 10_000);
        })
        .finally(() => {
          button.disabled = false;
        });
    };
    aiContent.dataset.feed = "ai-daily";
    treeholeContent.dataset.feed = "treehole";
    aiContent.scrollTop = this.feedScroll["ai-daily"] ?? 0;
    treeholeContent.scrollTop = this.feedScroll.treehole ?? 0;
    let restoringScroll = false;
    const rememberScroll = (kind: FeedKind, element: HTMLElement): void => {
      if (restoringScroll) return;
      this.lastInteractionAt = Date.now();
      this.feedScroll[kind] = element.scrollTop;
      const pending = this.feedScrollPersistTimers[kind];
      if (pending !== undefined) window.clearTimeout(pending);
      this.feedScrollPersistTimers[kind] = window.setTimeout(() => {
        delete this.feedScrollPersistTimers[kind];
        this.plugin.updateDashboardFeedUiState(kind, {
          scrollTop: this.feedScroll[kind] ?? 0,
        });
      }, 120);
    };
    aiContent.addEventListener("scroll", () => rememberScroll("ai-daily", aiContent), { passive: true });
    treeholeContent.addEventListener("scroll", () => rememberScroll("treehole", treeholeContent), { passive: true });
    let rendered: FeedDashboardDigest | undefined;
    const renderDigest = (digest: FeedDashboardDigest): void => {
      if (!shelf.isConnected) return;
      const aiScrollTop = rendered ? aiContent.scrollTop : (this.feedScroll["ai-daily"] ?? 0);
      const treeholeScrollTop = rendered ? treeholeContent.scrollTop : (this.feedScroll.treehole ?? 0);
      restoringScroll = true;
      rendered = digest;
      aiContent.empty();
      treeholeContent.empty();
      for (const action of shelf.querySelectorAll<HTMLElement>(".okf-feed-project__digest-action")) {
        action.remove();
      }
      if (!digest.ai_daily.length) {
        aiMeta.setText("当前没有可读内容");
        aiContent.createDiv({ cls: "okf-dashboard__empty", text: "暂时没有 AI Daily 内容。" });
      } else {
        const latest = digest.ai_daily[0]!;
        const total = digest.ai_daily.reduce((sum, edition) => sum + edition.item_count, 0);
        aiMeta.setText(`${latest.issued_at} · ${total} 条`);
        const openDigest = aiHeader.createEl("button", {
          text: "打开 Digest",
          cls: "okf-dashboard__ghost-action okf-feed-project__digest-action",
        });
        openDigest.addEventListener("click", () => {
          openDigestWithFeedback(openDigest, "ai-daily", latest.digest_id);
        });
        for (const edition of digest.ai_daily) {
          this.renderFeedDigestEdition(aiContent, "ai-daily", edition);
        }
        aiContent.createDiv({
          cls: "okf-feed-project__footer",
          text: `已显示本期全部 ${total} 条`,
        });
      }
      if (digest.treehole) {
        const treeholeDigest = digest.treehole;
        treeholeMeta.setText(`${treeholeDigest.issued_at} · ${treeholeDigest.item_count} 条`);
        const openDigest = treeholeHeader.createEl("button", {
          text: "打开 Digest",
          cls: "okf-dashboard__ghost-action okf-feed-project__digest-action",
        });
        openDigest.addEventListener("click", () => {
          openDigestWithFeedback(openDigest, "treehole", treeholeDigest.digest_id);
        });
        this.renderFeedDigestEdition(treeholeContent, "treehole", treeholeDigest);
        treeholeContent.createDiv({
          cls: "okf-feed-project__footer",
          text: `已显示本期全部 ${treeholeDigest.item_count} 条`,
        });
      } else {
        treeholeMeta.setText("当前没有可读内容");
        treeholeContent.createDiv({ cls: "okf-dashboard__empty", text: "暂时没有树洞热榜内容。" });
      }
      requestAnimationFrame(() => {
        aiContent.scrollTop = aiScrollTop;
        treeholeContent.scrollTop = treeholeScrollTop;
        this.feedScroll["ai-daily"] = aiScrollTop;
        this.feedScroll.treehole = treeholeScrollTop;
        restoringScroll = false;
      });
    };
    const cached = this.plugin.feedDashboardDigestSnapshot();
    if (cached) {
      renderDigest(cached);
    } else {
      aiContent.createDiv({ cls: "okf-dashboard__muted", text: "正在读取 AI Daily…" });
      treeholeContent.createDiv({ cls: "okf-dashboard__muted", text: "正在读取树洞热榜…" });
    }
    void this.plugin
      .loadFeedDashboardDigest()
      .then((digest) => {
        if (digest !== rendered) renderDigest(digest);
      })
      .catch((error: unknown) => {
        if (rendered) return;
        const message = error instanceof Error ? error.message : "Feed 摘要暂时无法读取";
        aiMeta.setText("暂时无法读取");
        treeholeMeta.setText("暂时无法读取");
        aiContent.empty();
        treeholeContent.empty();
        aiContent.createDiv({ cls: "okf-dashboard__muted", text: message });
        treeholeContent.createDiv({ cls: "okf-dashboard__muted", text: message });
        const retry = aiContent.createEl("button", { text: "重新读取", cls: "okf-dashboard__secondary-action" });
        retry.addEventListener("click", () => {
          shelf.remove();
          this.renderFeedLoading(parent);
        });
      });
  }

  private renderFeedDigestEdition(
    parent: HTMLElement,
    kind: FeedKind,
    edition: FeedDigestEdition,
  ): void {
    const section = parent.createEl("section", { cls: "okf-feed-digest__edition" });
    const title =
      kind === "ai-daily"
        ? edition.section ? aiDailyPreviewStreamTitle(edition.section) : "其他"
        : "本期条目";
    section.createEl("h4", { text: title });
    if (edition.quality && edition.quality !== "ok") {
      section.createDiv({
        cls: "okf-dashboard__feed-warning",
        text: edition.quality_reason
          ? `采集不完整：${humanizeFeedQuality(edition.quality_reason)}`
          : "本期采集可能不完整。",
      });
    }
    const items = section.createDiv({ cls: "okf-feed-digest__items" });
    for (const [index, item] of edition.items.entries()) {
      this.renderFeedDigestItem(items, kind, edition, item, index + 1);
    }
  }

  private renderFeedDigestItem(
    parent: HTMLElement,
    kind: FeedKind,
    edition: FeedDigestEdition,
    item: FeedDigestItem,
    index: number,
  ): void {
    const card = parent.createEl("article", {
      cls: "okf-feed-digest__item",
      attr: {
        role: "link",
        tabindex: "0",
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
    const metadata = kind === "treehole" ? treeholeMetadata(item) : aiDailyMetadata(item);
    if (metadata) card.createDiv({ cls: "okf-dashboard__muted", text: metadata });
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
          const panel = card.closest(".okf-feed-project");
          for (const previous of panel?.querySelectorAll<HTMLElement>(".is-last-read") ?? []) {
            previous.removeClass("is-last-read");
            previous.removeAttribute("aria-current");
          }
          card.addClass("is-last-read");
          card.setAttr("aria-current", "true");
          await this.plugin.rememberFeedReadingPosition(kind, edition.digest_id, item.item_id);
        })
        .catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : "无法打开 Feed 条目", 10_000);
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
      text: "快速记录到 Inbox",
      cls: "mod-cta okf-dashboard__primary-action",
    });
    capture.addEventListener("click", () => this.plugin.promptCapture());
    const importDocument = actions.createEl("button", {
      text: "导入资料",
      cls: "okf-dashboard__secondary-action",
    });
    importDocument.addEventListener("click", () => this.plugin.promptDocumentImport());

    const stageTabs = container.createDiv({
      cls: "okf-dashboard__segments okf-dashboard__stage-tabs",
      attr: { role: "tablist", "aria-label": "Inbox 页面" },
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
      attr: { role: "tablist", "aria-label": "按进入渠道筛选 Inbox" },
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
        discardSelected.setText(`标记不保留 (${this.selectedCaptures.size})`);
        discardSelected.toggleClass("is-hidden", !this.selectedCaptures.size);
      };
      if (visible.some((item) => item.note.note_type === "Capture")) {
        const toolbar = container.createDiv({ cls: "okf-dashboard__selection-toolbar" });
        discardSelected = toolbar.createEl("button", {
          text: "标记不保留 (0)",
          cls: "okf-dashboard__danger-action is-hidden",
        });
        discardSelected.addEventListener("click", () => {
          const paths = [...this.selectedCaptures];
          if (!paths.length || !discardSelected) return;
          void this.runButtonAction(discardSelected, async () => {
            const result = await this.api().batchCaptures("discard", paths);
            this.selectedCaptures.clear();
            new Notice(`已归档 ${result.count} 条记录`);
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
          text: "当前没有文件转换进度。学习材料生成在 Learning 查看，其他后台任务在右上角任务中心查看。",
        });
      }
      if (conversions.length) this.renderInboxConversionStage(container, conversions);
    }

    const processed = projection.processed_captures.filter((note) =>
      this.inboxIngestedVia === "all" ||
        (note.ingested_via ?? "unlabeled") === this.inboxIngestedVia,
    );
    if (processed.length && this.inboxTab === "progress") {
      const archived = this.dashboardSection(
        container,
        "历史兼容项",
        "旧流程留下的已处理 Capture；新流程发布后会自动移出 Inbox。",
        "okf-dashboard__section--low-priority",
      );
      const archiveAll = archived.createEl("button", {
        text: `归档全部 (${processed.length})`,
        cls: "okf-dashboard__ghost-action",
      });
      archiveAll.addEventListener("click", () => {
        void this.runButtonAction(archiveAll, async () => {
          const result = await this.api().batchCaptures(
            "archive-processed",
            processed.map((note) => note.path),
          );
          new Notice(`已归档 ${result.count} 条已处理 Capture`);
        }, true);
      });
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
      "文件已进入本地转换管道；失败项会保留并提供可恢复操作。",
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
      status.setText("现在生成 Study Guide，或保存到 Learning 稍后开始。");
      button("现在生成 Study Guide", () => this.plugin.promptPublishWebCapture(note.path, "learn-now"), "okf-dashboard__secondary-action");
      button("稍后学习", () => this.plugin.promptPublishWebCapture(note.path, "learn-later"));
      button("返回", () => renderPrimary(), "okf-dashboard__ghost-action");
    };
    const renderReference = (): void => {
      choices.empty();
      status.setText("不准备学习时，再判断它是否值得长期保留。");
      button("直接生成 Wiki", () => this.plugin.promptPublishWebCapture(note.path, "wiki-now"), "okf-dashboard__secondary-action");
      button("仅保存原文", () => this.plugin.promptPublishWebCapture(note.path, "source-only"));
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
    const wiki = actions.createEl("button", { text: "生成 Wiki" });
    wiki.addEventListener("click", () => this.plugin.promptRoutePendingSource(note.path, "wiki"));
    const sourceOnly = actions.createEl("button", { text: "只保留来源" });
    sourceOnly.addEventListener("click", () => this.plugin.promptRoutePendingSource(note.path, "source"));
  }

  private pendingGenerationActions(
    parent: HTMLElement,
    note: NoteSummary,
    operation?: SemanticOperationRecord,
  ): void {
    const actions = parent.createDiv({ cls: "okf-dashboard__actions" });
    if (operation && isSemanticOperationActive(operation.status)) {
      const progress = actions.createEl("button", { text: semanticStageLabel(operation) });
      progress.disabled = true;
      return;
    }
    if (operation && isSemanticOperationRetryable(operation.status)) {
      const retry = actions.createEl("button", { text: "重新生成" });
      retry.addEventListener("click", () => {
        void this.runButtonAction(retry, async () => {
          const retried = await this.api().retrySemanticOperation(operation.operation_id);
          this.plugin.watchSemanticOperation(retried.operation_id);
        }, true, "已重新加入后台任务");
      });
      return;
    }
    if (operation?.status === "completed") {
      const completed = actions.createEl("button", { text: "已完成，正在刷新结果" });
      completed.disabled = true;
      return;
    }
    const intent = note.purpose === "wiki" ? "wiki" : "learn";
    const generate = actions.createEl("button", {
      text: intent === "wiki" ? "生成 Wiki" : "生成学习材料",
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

  private renderInboxConversionCard(parent: HTMLElement, conversion: ConversionRecord): void {
    const card = parent.createDiv({ cls: "okf-dashboard__card" });
    card.createEl("h3", { text: conversion.source_filename || conversion.conversion_id });
    const badges = card.createDiv({ cls: "okf-dashboard__badges" });
    this.ingestionBadge(badges, "file-import");
    card.createDiv({ cls: "okf-dashboard__muted", text: conversionStatusLabel(conversion) });
    if (conversion.error) card.createDiv({ text: conversion.error });
    const actions = card.createDiv({ cls: "okf-dashboard__actions" });
    const target = conversion.outputs.routed_target ?? conversion.outputs.source_text ?? conversion.outputs.source;
    if (target) {
      const open = actions.createEl("button", { text: "打开结果" });
      open.addEventListener("click", () => void this.openPath(target));
    }
    if (conversion.status === "waiting-for-mineru") {
      const fallback = actions.createEl("button", { text: "本次改用 MarkItDown" });
      fallback.addEventListener("click", () => {
        void this.runButtonAction(fallback, async () => {
          const record = await this.api().retryConversion(conversion.conversion_id, "markitdown");
          this.plugin.watchDocumentConversion(record.conversion_id);
        }, true, "已改用 MarkItDown 并重新排队");
      });
    }
    if (conversion.status === "ready" || (
      conversion.status === "failed" && conversion.stages?.conversion === "completed"
    )) {
      const resume = actions.createEl("button", { text: "继续归档（不重新转换）" });
      resume.addEventListener("click", () => {
        void this.runButtonAction(resume, async () => {
          const record = await this.api().retryConversion(conversion.conversion_id);
          this.plugin.watchDocumentConversion(record.conversion_id);
        }, true, "已从现有 Markdown 继续归档");
      });
    } else if (conversion.status === "failed") {
      for (const parser of ["mineru", "markitdown"] as const) {
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
    const scopeCounts = dashboardLearningScopeCounts(allLearningNotes);
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
        empty: "当前没有已经准备好的 Study Guide。",
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
    importMaterial.addEventListener("click", () => this.plugin.promptDocumentImport());
    const classNote = actions.createEl("button", {
      text: "新建 Lesson",
      cls: "okf-dashboard__secondary-action",
    });
    classNote.addEventListener("click", () => this.plugin.promptLesson());
    const course = actions.createEl("button", { text: "新建 Course", cls: "okf-dashboard__ghost-action" });
    course.addEventListener("click", () => this.plugin.promptCourse());
    const nativeView = actions.createEl("button", { text: "完整学习目录", cls: "okf-dashboard__ghost-action" });
    nativeView.addEventListener("click", () => void this.openPath("system/views/Learning.md"));

    const workspace = container.createDiv({ cls: "okf-learning-workspace" });
    const side = workspace.createEl("aside", { cls: "okf-learning-contexts" });
    const contexts = this.dashboardSection(
      side,
      "学习范围",
      "全部材料包含下面三类；双关联材料可同时出现在课程和项目筛选中。",
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
      `当前范围：${scopeTitle}。生成、学习和完成是同一组材料的不同状态。`,
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
      `具体 Course · ${courses.length}`,
      "选择一门课程；材料数与 Lesson 数分开显示。",
      selectedPath
        ? `当前 Course：${courses.find((item) => dashboardPath(item.path) === dashboardPath(selectedPath))?.title ?? "已选择"}`
        : "选择具体 Course",
    );
    if (!courses.length) {
      section.createDiv({ cls: "okf-dashboard__empty", text: "还没有 Course。" });
      return;
    }
    const list = section.createDiv({ cls: "okf-learning-entity-list" });
    this.learningScopeEntity(
      list,
      "全部课程相关材料",
      `${courses.length} Course`,
      filterDashboardLearningScope(notes, "course").length,
      !selectedPath,
      () => this.setLearningScope("course"),
    );
    for (const item of courses) {
      const count = filterDashboardLearningScope(notes, "course", item.path).length;
      this.learningScopeEntity(
        list,
        item.title,
        `${item.lesson_count} Lesson`,
        count,
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
      `具体 Project · ${projects.length}`,
      "这里只统计实际关联的学习材料。",
      selectedPath
        ? `当前 Project：${projects.find((item) => dashboardPath(item.path) === dashboardPath(selectedPath))?.title ?? "已选择"}`
        : "选择具体 Project",
    );
    if (!projects.length) {
      section.createDiv({ cls: "okf-dashboard__empty", text: "还没有 Project。" });
      return;
    }
    const list = section.createDiv({ cls: "okf-learning-entity-list" });
    this.learningScopeEntity(
      list,
      "全部项目相关材料",
      `${projects.length} Project`,
      filterDashboardLearningScope(notes, "project").length,
      !selectedPath,
      () => this.setLearningScope("project"),
    );
    for (const item of projects) {
      const count = filterDashboardLearningScope(notes, "project", item.path).length;
      this.learningScopeEntity(
        list,
        item.title,
        item.project_status === "paused"
          ? "Paused"
          : item.project_status === "completed"
            ? "Completed"
            : "Active",
        count,
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
    count: number,
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
    select.createEl("strong", { text: String(count) });
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

  private renderSelectedCourse(
    parent: HTMLElement,
    course: Awaited<ReturnType<VaultDashboardReader["learning"]>>["courses"][number],
  ): void {
    const banner = parent.createDiv({ cls: "okf-learning-scope-banner" });
    const copy = banner.createDiv({ cls: "okf-learning-scope-banner__copy" });
    copy.createEl("strong", { text: course.title });
    copy.createDiv({
      cls: "okf-dashboard__muted",
      text: [
        course.current_progress || "尚未记录课程进度",
        `${course.guide_count} Guide / ${course.lesson_count} Lesson`,
        course.latest_lesson ? `最近 Lesson：${course.latest_lesson.title}` : "",
      ].filter(Boolean).join(" · "),
    });
    const actions = banner.createDiv({ cls: "okf-dashboard__actions" });
    const open = actions.createEl("button", { text: "打开 Course", cls: "okf-dashboard__secondary-action" });
    open.addEventListener("click", () => void this.openPath(course.path));
    const lesson = actions.createEl("button", { text: "新建 Lesson", cls: "okf-dashboard__ghost-action" });
    lesson.addEventListener("click", () => this.plugin.promptLessonForCourse(course.path));
    const capture = actions.createEl("button", { text: "记录课程想法", cls: "okf-dashboard__ghost-action" });
    capture.addEventListener("click", () => this.plugin.promptCapture({ course: course.path }));
    const slug = course.path.split("/")[2];
    if (slug) {
      const add = actions.createEl("button", { text: "添加资料", cls: "okf-dashboard__ghost-action" });
      add.addEventListener("click", () => this.plugin.promptDocumentImport({ course: slug }));
    }
  }

  private renderSelectedProject(
    parent: HTMLElement,
    project: Awaited<ReturnType<VaultDashboardReader["learning"]>>["projects"][number],
  ): void {
    const banner = parent.createDiv({ cls: "okf-learning-scope-banner" });
    const copy = banner.createDiv({ cls: "okf-learning-scope-banner__copy" });
    copy.createEl("strong", { text: project.title });
    copy.createDiv({
      cls: "okf-dashboard__muted",
      text: project.next_action ? `项目下一步：${compactText(project.next_action, 120)}` : "项目尚未填写下一步。",
    });
    const actions = banner.createDiv({ cls: "okf-dashboard__actions" });
    const open = actions.createEl("button", { text: "打开 Project", cls: "okf-dashboard__secondary-action" });
    open.addEventListener("click", () => void this.openPath(project.path));
    const capture = actions.createEl("button", { text: "记录项目想法", cls: "okf-dashboard__ghost-action" });
    capture.addEventListener("click", () => this.plugin.promptCapture({ project: project.path }));
    const slug = project.path.split("/")[1];
    if (slug) {
      const add = actions.createEl("button", { text: "添加资料", cls: "okf-dashboard__ghost-action" });
      add.addEventListener("click", () => this.plugin.promptDocumentImport({ project: slug }));
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
      const card = list.createDiv({ cls: "okf-dashboard__compact-row okf-dashboard__compact-row--stacked okf-learning-note" });
      const main = card.createDiv({ cls: "okf-dashboard__row-main" });
      const open = main.createEl("button", {
        text: note.title,
        cls: "okf-dashboard__row-title",
        attr: { type: "button" },
      });
      open.addEventListener("click", () => void this.openPath(note.path));
      main.createDiv({
        cls: "okf-dashboard__row-meta",
        text: [
          learningContextLabel(note, relationTitles),
          relativeMoment(note.modified_at),
        ]
          .filter(Boolean)
          .join(" · "),
      });
      const operation = this.semanticOperationForNote(note, operations);
      const action = dashboardLearningRowAction(note);
      if (action === "study-guide") {
        this.learningQueueActions(card, note, operation);
      } else if (action === "pending-source") {
        this.pendingGenerationActions(card, note, operation);
      }
    }
  }

  private learningQueueActions(
    parent: HTMLElement,
    note: NoteSummary,
    operation?: SemanticOperationRecord,
  ): void {
    const active = operation && isSemanticOperationActive(operation.status);
    const primary = parent.createDiv({ cls: "okf-dashboard__row-actions okf-learning-note__primary" });
    const action = primary.createEl("button", {
      cls: "okf-dashboard__row-action",
      attr: { type: "button" },
    });
    if (active) {
      action.setText(semanticStageLabel(operation));
      action.disabled = true;
    } else if (note.studied_at) {
      action.setText("打开");
      action.addClass("mod-cta", "okf-dashboard__primary-action");
      action.addEventListener("click", () => void this.openPath(note.path));
    } else if (note.material_ready) {
      action.setText("打开");
      action.addClass("mod-cta", "okf-dashboard__primary-action");
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
              ? "学习材料已经生成完成，可直接打开"
              : "已加入 Codex 后台任务；完成后会通知你",
            10_000,
          );
        }, true);
      });
    }

    if (
      (active && ["publishing", "indexing"].includes(operation.stage ?? "")) ||
      (operation?.status === "completed" && !note.material_ready)
    ) return;
    const details = parent.createEl("details", { cls: "okf-dashboard__row-details" });
    details.createEl("summary", { text: "更多" });
    const more = details.createDiv({ cls: "okf-dashboard__actions" });
    if (active) {
      const cancel = more.createEl("button", { text: "取消后台生成", cls: "okf-dashboard__ghost-action" });
      cancel.addEventListener("click", () => {
        void this.runButtonAction(
          cancel,
          () => this.api().cancelSemanticOperation(operation.operation_id),
          true,
          "已请求停止后台任务",
        );
      });
      return;
    }
    if (active) return;

    const interactive = more.createEl("button", {
      text: note.material_ready ? "用 Codex 完善" : "与 Codex 一起生成",
      cls: "okf-dashboard__ghost-action",
    });
    interactive.addEventListener("click", () => {
      interactive.disabled = true;
      void this.learningSources(note.path)
        .then((sources) => this.copyPrompt(
          note.material_ready
            ? "读取现有辅助学习材料和来源，根据我接下来补充的要求继续完善这篇学习材料。"
            : "读取目标笔记和明确来源，生成第一版辅助学习材料；先让我补充具体要求。",
          {
            contextPaths: [...new Set([note.path, ...sources])],
            actionMode: "write",
            skill: note.material_ready ? "update-study-guide" : "prepare-study-guide",
          },
        ))
        .catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : "无法打开 Codex 面板", 10_000);
        })
        .finally(() => {
          interactive.disabled = false;
        });
    });
    if (note.material_ready) {
      const discuss = more.createEl("button", { text: "用 Codex 讨论", cls: "okf-dashboard__ghost-action" });
      discuss.addEventListener("click", () => {
        void this.copyPrompt("结合这篇 Study Guide 和相关 Wiki 帮助我继续学习和解答问题。", {
          contextPaths: [note.path],
          actionMode: "read",
        });
      });
    }
    if (canCompleteDashboardStudy(note, operation)) {
      const studied = more.createEl("button", {
        text: note.studied_at ? "取消完成" : "标记完成",
        cls: "okf-dashboard__ghost-action",
      });
      studied.addEventListener("click", () => {
        studied.disabled = true;
        void this.plugin.setStudyCompleted(note.path, !note.studied_at)
          .then(() => this.render(true))
          .catch((error: unknown) => {
            new Notice(error instanceof Error ? error.message : "更新失败");
            studied.disabled = false;
          });
      });
    }
    if (note.studied_at) {
      const wiki = more.createEl("button", { text: "沉淀 Wiki", cls: "okf-dashboard__ghost-action" });
      wiki.addEventListener("click", () => {
        void this.copyPrompt("从已经完成的学习成果中生成或更新长期 Wiki，并维护必要的关联。", {
          contextPaths: [note.path],
          actionMode: "write",
          skill: "distill-wiki",
        });
      });
    }
  }

  private async renderProjects(container: HTMLElement): Promise<void> {
    const data = await this.vaultReader.projects();
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const create = actions.createEl("button", {
      text: "新建 Project",
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
      { value: "active" as const, label: "Active" },
      { value: "paused" as const, label: "Paused" },
      { value: "completed" as const, label: "Completed" },
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
        text: this.projectsTab === "active" ? "当前没有进行中的 Project。" : "这个状态下没有 Project。",
      });
      return;
    }
    const list = container.createDiv({ cls: "okf-dashboard__compact-list okf-project-list" });
    for (const project of selected) {
      const linkedLearning = project.related_learning;
      const relatedMaterials = project.related_materials;
      const row = list.createEl("article", {
        cls: "okf-dashboard__compact-row okf-project-row",
      });
      const main = row.createDiv({ cls: "okf-dashboard__row-main" });
      const title = main.createEl("button", {
        text: project.title,
        cls: "okf-dashboard__row-title",
        attr: { type: "button" },
      });
      title.addEventListener("click", () => void this.openPath(project.path));
      main.createDiv({
        cls: "okf-dashboard__row-meta",
        text: [
          project.next_action ? `下一步：${compactText(project.next_action, 120)}` : "尚未设置下一步",
          relativeMoment(project.modified_at),
        ].filter(Boolean).join(" · "),
      });
      const rowActions = row.createDiv({ cls: "okf-dashboard__row-actions" });
      const open = rowActions.createEl("button", {
        text: "打开",
        cls: "mod-cta okf-dashboard__primary-action okf-dashboard__row-action",
        attr: { type: "button" },
      });
      open.addEventListener("click", () => void this.openPath(project.path));
      const capture = rowActions.createEl("button", {
        text: "记录想法",
        cls: "okf-dashboard__secondary-action okf-dashboard__row-action",
        attr: { type: "button" },
      });
      capture.addEventListener("click", () => this.plugin.promptCapture({ project: project.path }));
      const details = row.createEl("details", { cls: "okf-dashboard__row-details" });
      details.open = this.expandedProjectPaths.has(project.path);
      details.addEventListener("toggle", () => {
        if (details.open) this.expandedProjectPaths.add(project.path);
        else this.expandedProjectPaths.delete(project.path);
        this.plugin.updateDashboardPageUiState("projects", {
          filters: { expanded: JSON.stringify([...this.expandedProjectPaths]) },
        });
      });
      details.createEl("summary", {
        text: `更多 · 待整理 ${project.pending_captures.length} · 关联学习 ${linkedLearning.length} · 资料 ${relatedMaterials.length} · Decision ${project.decisions.length} · Output ${project.outputs.length}`,
      });
      if (project.current_state) {
        details.createDiv({
          cls: "okf-dashboard__muted okf-project-row__current-state",
          text: `当前状态：${compactText(project.current_state, 180)}`,
        });
      }
      details.createDiv({
        cls: "okf-dashboard__muted okf-project-row__action-note",
        text: "记录项目想法会保存到 Inbox；快速记录进展只追加日志；整理项目状态会交给 Codex 更新当前状态和下一步。",
      });
      const more = details.createDiv({ cls: "okf-dashboard__actions" });
      this.pendingCaptureLinks(more, project.pending_captures);
      for (const guide of linkedLearning.slice(0, 3)) {
        const study = more.createEl("button", {
          text: `学习：${compactText(guide.title, 36)}`,
          cls: "okf-dashboard__ghost-action",
        });
        study.addEventListener("click", () => void this.openPath(guide.path));
      }
      if (linkedLearning.length > 3) {
        const allLearning = more.createEl("button", {
          text: "查看此 Project 的全部学习材料",
          cls: "okf-dashboard__ghost-action",
        });
        allLearning.addEventListener("click", () => {
          this.learningContext = "project";
          this.learningRelationPath = project.path;
          this.plugin.updateDashboardPageUiState("learning", {
            filters: { context: "project", relation: project.path },
          });
          this.openSection("learning");
        });
      }
      if (this.projectsTab === "active") {
        const progress = more.createEl("button", {
          text: "快速记录进展（追加日志）",
          cls: "okf-dashboard__secondary-action",
        });
        progress.addEventListener("click", () => this.plugin.promptProjectProgress(project.path));
      }
      const log = more.createEl("button", { text: "打开项目日志", cls: "okf-dashboard__ghost-action" });
      log.addEventListener("click", () => void this.openPath(project.log_path));
      const decision = more.createEl("button", { text: "记录关键决定", cls: "okf-dashboard__ghost-action" });
      decision.addEventListener("click", () => this.plugin.promptProjectDecision(project.path));
      const projectDirectory = project.path.split("/").slice(0, -1).join("/");
      const codex = more.createEl("button", { text: "整理项目状态", cls: "okf-dashboard__ghost-action" });
      codex.addEventListener("click", () => {
        void this.copyPrompt("根据已有项目主页和日志，梳理当前状态、关键决定、阻塞和下一步。", {
          contextPaths: [project.path, `${projectDirectory}/log.md`],
          actionMode: "write",
          skill: "capture-project-progress",
        });
      });
      const currentStatus = project.project_status === "paused" || project.project_status === "completed"
        ? project.project_status
        : "active";
      for (const option of projectStatusActions(currentStatus)) {
        const status = more.createEl("button", { text: option.label, cls: "okf-dashboard__ghost-action" });
        status.addEventListener("click", () => {
          status.disabled = true;
          void this.plugin.setProjectStatus(project.path, option.value)
            .then(() => {
              new Notice(option.notice);
              return this.render(true);
            })
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : "更新 Project 状态失败");
              status.disabled = false;
            });
        });
      }
      const slug = project.path.split("/")[1];
      if (slug) {
        const add = more.createEl("button", { text: "添加资料", cls: "okf-dashboard__ghost-action" });
        add.addEventListener("click", () => this.plugin.promptDocumentImport({ project: slug }));
      }
    }
  }

  private async renderKnowledge(container: HTMLElement): Promise<void> {
    const data = await this.vaultReader.knowledge();
    const actions = container.createDiv({ cls: "okf-dashboard__page-actions" });
    const create = actions.createEl("button", {
      text: "从材料生成 Wiki",
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
        placeholder: "搜索 Wiki、Wiki Map、标签和主题…",
        "aria-label": "搜索 Knowledge",
      },
    });
    search.value = this.knowledgeQuery;
    const filters = container.createDiv({
      cls: "okf-dashboard__segments okf-dashboard__knowledge-filters",
      attr: { role: "tablist", "aria-label": "Knowledge 筛选" },
    });
    const options = [
      { value: "all" as const, label: "全部", count: data.notes.length + data.pending_wiki.length },
      { value: "pending" as const, label: "待生成", count: data.pending_wiki.length },
      { value: "wiki" as const, label: "Wiki", count: data.notes.filter((note) => note.note_type === "Wiki").length },
      { value: "map" as const, label: "Wiki Map", count: data.notes.filter((note) => note.note_type === "Wiki Map").length },
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
          text: `待生成 Wiki · ${learningContextLabel(note, new Map())}`,
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
          note.note_type,
          ...((note.topics ?? []).slice(0, 3)),
          relativeMoment(note.modified_at),
        ].filter(Boolean).join(" · ");
        const row = this.compactRow(
          list,
          note.title,
          meta,
          note.ai_unverified ? "查看并核验" : "打开",
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
    const jot = actions.createEl("button", { text: "快速记一笔", cls: "okf-dashboard__secondary-action" });
    jot.addEventListener("click", () => this.plugin.promptDailyCapture());
    const reflection = actions.createEl("button", { text: "新建 Reflection", cls: "okf-dashboard__ghost-action" });
    reflection.addEventListener("click", () => this.plugin.promptReflection());
    const review = actions.createEl("button", { text: "新建 Review", cls: "okf-dashboard__ghost-action" });
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
      "完整日期浏览交给 Chinese Calendar；这里保留最近入口。",
      "okf-life-section okf-life-section--daily",
    );
    const recentDaily = [...dailyNotes]
      .sort((left, right) => right.path.localeCompare(left.path))
      .slice(0, 10);
    this.renderLifeNoteCards(dailySection, recentDaily, "还没有日记。", true);

    const lifeSide = lifeLayout.createDiv({ cls: "okf-life-layout__side" });
    const reflectionSection = this.dashboardSection(
      lifeSide,
      "Reflections",
      "值得单独成篇的观察、困惑和思考。",
      "okf-life-section",
    );
    this.renderLifeNoteCards(reflectionSection, reflections.slice(0, 6), "还没有独立 Reflection。", true);

    if (reviews.length) {
      const reviewSection = this.dashboardSection(
        container,
        "Reviews",
        "按周期回看节奏、趋势和方向。",
        "okf-life-section okf-dashboard__section--low-priority",
      );
      for (const [root, label] of [
        ["life/reviews/weekly/", "Weekly"],
        ["life/reviews/monthly/", "Monthly"],
        ["life/reviews/yearly/", "Yearly"],
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
        [note.note_type, relativeMoment(note.modified_at)].filter(Boolean).join(" · "),
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
      ["转为 Wiki", "wiki"],
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
        recommendation.setText("建议：" + result.destination + "；" + result.reason);
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
        `Dashboard ${DASHBOARD_VERSION} · CLI ${this.systemCache.version} · 上次检查 ${this.systemCache.checked_at}`,
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
          `Dashboard ${DASHBOARD_VERSION} · CLI ${status.value.version} · 检查于 ${status.value.checked_at}`,
        );
      } else {
        header.setText(
          this.systemCache
            ? `系统刷新失败，继续显示 ${this.systemCache.checked_at} 的快照`
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
    const card = container.createDiv({ cls: "okf-dashboard__card" });
    card.createEl("h3", { text: "Codex 面板" });
    card.createDiv({
      cls: "okf-dashboard__muted",
      text: available ? "可用 · Codex 原生会话" : "未加载",
    });
    card.createDiv({
      text: available
        ? "Dashboard 可直接交接任务、上下文文件和本轮权限，不经过 Terminal 或剪贴板。"
        : "启用内嵌 Codex 面板插件并重新加载 Obsidian 后即可使用。",
    });
    if (available) {
      const open = card.createEl("button", { text: "打开 Codex" });
      open.addEventListener("click", () => {
        void this.plugin.openCodexConsole().catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : "无法打开 Codex 面板", 10_000);
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
          placeholder.createEl("strong", { text: "知识与链接治理" });
          const state = placeholder.createDiv({ cls: "okf-dashboard__muted", text: "正在加载详情…" });
          void this.renderGovernanceIssues(placeholder)
            .then(() => state.remove())
            .catch(() => state.setText("治理详情暂时无法读取，可稍后单独刷新。"));
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
      void this.runButtonAction(undo, () => this.api().undo(), false, "已创建撤销提交");
    });
  }

  private systemCard(parent: HTMLElement, item: SystemItem): void {
    const card = parent.createDiv({
      cls: "okf-dashboard__compact-row okf-dashboard__compact-row--stacked",
      attr: { "data-system-status": item.status },
    });
    card.createEl("h3", { text: item.label });
    card.createDiv({ cls: "okf-dashboard__muted", text: item.status });
    card.createDiv({ text: item.detail });
    if (item.item_id === "index" && item.action) {
      const action = card.createEl("button", { text: "重建索引" });
      action.addEventListener("click", () => {
        void this.runButtonAction(action, () => this.api().rebuildIndex(), true);
      });
    } else if (item.item_id === "feeds" && item.action === "立即同步") {
      const action = card.createEl("button", { text: "立即同步" });
      action.addEventListener("click", () => {
        void this.runButtonAction(action, () => this.plugin.syncFeedsNow(), true, "Feed 已同步");
      });
    } else if (item.action) {
      card.createDiv({ cls: "okf-dashboard__muted", text: item.action });
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
        const resume = actions.createEl("button", { text: "继续归档（不重新转换）" });
        resume.addEventListener("click", () => {
          resume.disabled = true;
          void this.api()
            .retryConversion(failure.conversion_id)
            .then((record) => {
              this.plugin.watchDocumentConversion(record.conversion_id);
              new Notice("已从现有 Markdown 继续归档");
              return this.render();
            })
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : "继续归档失败");
            })
            .finally(() => {
              resume.disabled = false;
            });
        });
      }
      for (const parser of ["mineru", "markitdown"] as const) {
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
      "上传已经完成；转换在后台继续，不会阻塞 Dashboard。",
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
      if (conversion.status === "waiting-for-mineru") {
        const fallback = card.createEl("button", { text: "本次改用 MarkItDown" });
        fallback.addEventListener("click", () => {
          void this.runButtonAction(fallback, async () => {
            const record = await this.api().retryConversion(
              conversion.conversion_id,
              "markitdown",
            );
            this.plugin.watchDocumentConversion(record.conversion_id);
            return record;
          }, true, "已改用 MarkItDown 并重新排队");
        });
      }
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
    card.createEl("h3", { text: `知识与链接治理 · ${report.issue_count}` });
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
        `无法打开 Codex：${error instanceof Error ? error.message : "Codex 面板不可用"}`,
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
      return `Course · ${relationTitles.get(dashboardPath(course ?? "")) ?? relationName(course ?? note.path)}`;
    }
    if (context === "project") {
      return `Project · ${relationTitles.get(dashboardPath(note.project ?? "")) ?? relationName(note.project ?? "")}`;
    }
    return "Independent";
  }).join(" · ");
}

function courseStatusLabel(status: string | null | undefined): string {
  if (status === "paused") return "Paused";
  if (status === "completed") return "Completed";
  return "Active";
}

function semanticStageLabel(operation: SemanticOperationRecord): string {
  if (operation.status === "queued") return "已排队，等待 Codex 开始";
  if (operation.status === "orphaned") return "后台生成中断，等待恢复";
  const labels: Record<string, string> = {
    retrieving: "正在检索相关笔记",
    generating: "Codex 正在生成内容",
    publishing: "正在写入目标笔记",
    indexing: "正在刷新检索索引",
  };
  return labels[operation.stage ?? ""] ?? "后台任务正在处理";
}

function conversionStatusLabel(conversion: ConversionRecord): string {
  if (conversion.status === "queued") return "已排队";
  if (conversion.status === "converting") return `正在使用 ${conversion.parser} 转换`;
  if (conversion.status === "waiting-for-mineru") return "等待 MinerU；后台会自动重试";
  if (conversion.status === "ready") return "转换与质检已完成，等待正式归档";
  if (conversion.stages?.conversion === "completed") return "转换已完成，正式归档需要处理";
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

function parseStoredPaths(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function projectStatusActions(
  status: "active" | "paused" | "completed",
): { label: string; value: "active" | "paused" | "completed"; notice: string }[] {
  if (status === "active") {
    return [
      { label: "暂停 Project", value: "paused", notice: "Project 已暂停" },
      { label: "标记完成", value: "completed", notice: "Project 已完成" },
    ];
  }
  if (status === "paused") {
    return [
      { label: "恢复 Project", value: "active", notice: "Project 已恢复" },
      { label: "标记完成", value: "completed", notice: "Project 已完成" },
    ];
  }
  return [{ label: "重新开启", value: "active", notice: "Project 已重新开启" }];
}

function aiDailyMetadata(item: FeedDigestItem): string {
  return [item.source, item.published_at, item.media_count ? `${item.media_count} 个媒体` : ""]
    .filter(Boolean)
    .join(" · ");
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

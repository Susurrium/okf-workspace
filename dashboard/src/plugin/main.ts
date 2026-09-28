import { noteStatusLabel } from "../ui/display-labels.js";
import { Notice, Plugin, TFile, type WorkspaceLeaf } from "obsidian";
import { readFileSync } from "node:fs";

import { LocalApi } from "../api/client.js";
import {
  relationVaultPath,
  routeCaptureUsingLinkedContext,
  type CaptureRelation,
} from "../domain/capture-context.js";
import { isSemanticOperationActive } from "../domain/semantic-operation-state.js";
import {
  convertedDocumentTarget,
  semanticCompletionTitle,
} from "../domain/workflow-notifications.js";
import type {
  ConversionRecord,
  SemanticOperationRecord,
  WebCaptureAction,
} from "../api/types.js";
import { FeedTransportError, HttpFeedApi } from "../feeds/service.js";
import { evictUnresolvedFeedDecisions } from "../feeds/decision-cache.js";
import type {
  FeedDashboardDigest,
  FeedDecisionAction,
  FeedDecisionResult,
  FeedKind,
  FeedSubscriptionPage,
  FeedSubscriptionPageQuery,
  FeedSubscriptionConfirmRequest,
  FeedSubscriptionConfirmResult,
  FeedSubscriptionManagementPage,
  FeedSubscriptionMutationRequest,
  FeedSubscriptionMutationResult,
  FeedSubscriptionPreview,
  FeedSubscriptionPreviewRequest,
  FeedSubscriptionRemoveRequest,
  FeedSubscriptionRemoveResult,
  FeedSubscriptionSource,
  FeedSubscriptionSourcePage,
  FeedSubscriptionSourcePageQuery,
  FeedSubscriptionSourceItemsPage,
  FeedSubscriptionSourceItemsQuery,
  FeedSyncResult,
} from "../feeds/types.js";
import { feedItemMappings } from "../feeds/mappings.js";
import { HttpDocumentImportApi } from "../imports/service.js";
import { importFilesFromDrop, type ImportFile } from "../imports/drop.js";
import type {
  DocumentImportOptions,
} from "../imports/types.js";
import { renderFeedDecisionFlow } from "../ui/feed-decision-flow.js";
import { DashboardSettingTab } from "../../apex/src/settings.js";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "../../apex/src/view.js";
import { updateTaskDatesInFile, type VaultTask } from "../../apex/src/alltasks-scan.js";
import { registerSectionDefinition } from "../../apex/src/section-registry.js";
import { ApexHostAdapter } from "../adapters/apex-host.js";
import { ArtifactEditPolicy } from "../application/artifact-edit-policy.js";
import {
  readLegacyApexSettings,
  takeoverApexNativeData,
} from "../adapters/apex-native-data.js";
import {
  generateWorkbenchPresetMarkdown,
  WORKBENCH_PRESETS,
} from "../features/workbench-presets.js";
import {
  createOkfSurfaceSectionDefinitions,
  OKF_SECTION_TYPES,
  okfSectionDefaultName,
} from "../features/workbench/okf-surface-sections.js";
import {
  DASHBOARD_COMMAND_ID,
  registerDashboardRibbon,
} from "./dashboard-ribbon.js";
import { IndexSyncCoordinator } from "./index-sync.js";
import { feedLivePreviewExtension } from "./live-preview.js";
import { LocalServiceManager } from "./local-service.js";
import { ChoiceModal, FieldsPromptModal, ProjectLogModal, TextPromptModal } from "./prompts.js";
import { QuickCaptureModal } from "./quick-capture-modal.js";
import { DocumentImportModal, type ImportOrigin } from "./document-import-modal.js";
import { hasPendingGeneration } from "../domain/inbox-work-queue.js";
import {
  FeedSubscriptionAddModal,
  FeedSubscriptionSettingsModal,
} from "./feed-subscription-modal.js";
import { SemanticOperationMonitor } from "./semantic-monitor.js";
import { VaultDashboardReader } from "./vault-dashboard.js";
import { VaultNoteService, type ReviewPeriod } from "./vault-note-service.js";
import {
  CHINESE_CALENDAR_COMMAND_ID,
  CHINESE_CALENDAR_PLUGIN_ID,
  CHINESE_CALENDAR_VIEW_TYPE,
  showChineseCalendar,
} from "./chinese-calendar.js";
import { ORGANIZE_DAILY_PROMPT } from "./workflow-prompts.js";
import {
  DEFAULT_SETTINGS,
  type FeedReadingPosition,
  okfServiceSettingDefinitions,
  renderOkfServiceSettings,
  type OkfBrainSettings,
} from "./settings.js";
import { normalizeApexSettings } from "./apex-settings.js";
import {
  buildClaudianFallbackText,
  ClaudianBridgeAdapter,
  type CodexHandoffRequest,
} from "./claudian-bridge.js";
import {
  DashboardUiStateStore,
  normalizeDashboardUiState,
  patchDashboardUiState,
  type DashboardFeedUiStatePatch,
  type DashboardFeed,
  type DashboardPageUiStatePatch,
  type DashboardReadingSourceUiStatePatch,
  type DashboardSection,
  type DashboardUiState,
  type DashboardUiStatePatch,
  type RecentDashboardFile,
} from "./dashboard-ui-state.js";
import {
  OkfDashboardItemView,
  OkfDashboardView,
  OKF_DASHBOARD_VIEW,
  type DashboardSection as EmbeddedDashboardSection,
} from "./dashboard-view.js";

export default class OkfBrainPlugin extends Plugin {
  public settings: OkfBrainSettings = DEFAULT_SETTINGS;
  private persistedSettings: Record<string, unknown> = {};
  private apexHost: ApexHostAdapter | undefined;
  private feedDigestCache: { value: FeedDashboardDigest; loadedAt: number } | undefined;
  private feedDigestRequest: Promise<FeedDashboardDigest> | undefined;
  private feedProjectionRevision = 0;
  private readonly feedDecisionCache = new Map<string, FeedDecisionResult | undefined>();
  private readonly feedDecisionRequests = new Map<string, Promise<FeedDecisionResult | undefined>>();
  private dashboardRefreshTimer: number | undefined;
  private indexSyncTimer: number | undefined;
  private indexSync: IndexSyncCoordinator | undefined;
  private localService: LocalServiceManager | undefined;
  private claudianBridge: ClaudianBridgeAdapter | undefined;
  private vaultNotes: VaultNoteService | undefined;
  private readonly semanticMonitor = new SemanticOperationMonitor();
  private semanticOperationsCache: SemanticOperationRecord[] = [];
  private semanticLastIdlePoll = 0;
  private semanticPollInFlight = false;
  private readonly conversionRecords = new Map<string, import("../api/types.js").ConversionRecord>();
  private conversionListPollInFlight = false;
  private conversionLastIdlePoll = 0;
  private readonly watchedConversionIds = new Set<string>();
  private dashboardUiStateStore: DashboardUiStateStore | undefined;
  private readonly unregisterApexSections: Array<() => void> = [];
  private readonly embeddedDashboardSurfaces = new Set<OkfDashboardView>();

  public async onload(): Promise<void> {
    await this.loadSettings();
    this.vaultNotes = new VaultNoteService(this.app);
    const takeover = await takeoverApexNativeData(this.app, this.manifest.id);
    const copied = takeover.entries.filter((entry) => entry.status === "copied");
    const conflicts = takeover.entries.filter((entry) => entry.status === "target-kept");
    if (copied.length) {
      console.info(`[okf-workspace] adopted ${copied.length} Apex native data files`);
    }
    if (conflicts.length) {
      new Notice(
        `Apex 原数据接管保留了 ${conflicts.length} 个已有目标文件；旧文件未被覆盖，可在诊断记录中核对。`,
        10_000,
      );
    }
    this.apexHost = new ApexHostAdapter({
      owner: this,
      settings: this.settings.apex,
      persist: async (settings) => {
        this.settings.apex = settings;
        await this.saveSettings();
      },
      insertCalendarTask: (date, taskLine, position) =>
        this.notes().appendDailyTask(date, taskLine, position),
      workspacePresets: WORKBENCH_PRESETS,
      createWorkspaceMarkdown: generateWorkbenchPresetMarkdown,
      mutateManagedArtifact: (mutation) =>
        new ArtifactEditPolicy(this.notes()).mutate(mutation),
      convertMemoToCapture: (workspacePath, card) => {
        const title = card.title?.trim() || "工作台便签";
        const content = [card.blockquote?.trim(), card.body?.trim()]
          .filter(Boolean)
          .join("\n\n");
        return this.notes().createCaptureFromWorkbench(workspacePath, card.id, title, content);
      },
      createManagedArtifact: async (artifactType) => {
        if (artifactType === "Project") {
          this.promptProject();
          return true;
        }
        if (["Source", "Source Text"].includes(artifactType)) {
          new Notice("请通过导入或保存订阅内容添加资料。", 8000);
          return true;
        }
        return false;
      },
      openDocumentImportFromDrop: (transfer) => {
        void importFilesFromDrop(transfer)
          .then((files) => this.openDocumentImport(files, {}, "command"))
          .catch((error: unknown) => new Notice(
            error instanceof Error ? error.message : "无法读取拖入的文件夹", 8_000,
          ));
      },
    });
    await this.apexHost.initialize();
    this.unregisterApexSections.push(
      ...createOkfSurfaceSectionDefinitions(this).map(registerSectionDefinition),
    );
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this.apexHost!));
    this.registerView(OKF_DASHBOARD_VIEW, (leaf) => new OkfDashboardItemView(leaf, this));
    registerDashboardRibbon(this, () => void this.openDashboard());
    this.dashboardUiStateStore = new DashboardUiStateStore(
      this.settings.dashboardUiState,
      async (state) => {
        this.settings.dashboardUiState = state;
        await this.saveSettings();
      },
      400,
      (error) => console.error("[okf-workspace] could not save Dashboard UI state", error),
    );
    this.registerDashboardRecentFiles();
    this.claudianBridge = new ClaudianBridgeAdapter(this.app);
    this.localService = new LocalServiceManager(() => ({
      baseUrl: this.settings.baseUrl,
      enabled: this.settings.manageLocalService,
      pythonExecutable: this.settings.pythonExecutable,
      deploymentConfig: this.settings.deploymentConfig,
      logDirectory: this.settings.serviceLogDirectory,
    }));
    this.indexSync = new IndexSyncCoordinator(async () => {
      await this.api().syncIndex();
    });
    this.addSettingTab(new DashboardSettingTab(this.app, this.apexHost, this, {
      heading: "连接与导入",
      getSettingDefinitions: () => okfServiceSettingDefinitions(this),
      renderFallback: (container) => renderOkfServiceSettings(container, this),
    }));
    this.registerCommands();
    this.registerApexCommands();
    this.registerReadingViewControls();
    this.registerIndexSync();
    this.registerEditorExtension(
      feedLivePreviewExtension(this.app, {
        load: (feed, itemId) => this.loadFeedDecision(feed, itemId),
        decide: (feed, itemId, action) => this.decideFeed(feed, itemId, action),
        openPath: (path) => this.openVaultPath(path),
      }),
    );
    void this.initializeManagedEngine();
    void this.initializeSemanticMonitor();
    void this.initializeConversionMonitor();
    this.registerInterval(window.setInterval(() => void this.pollSemanticOperations(), 3_000));
    this.registerInterval(window.setInterval(() => void this.pollConversionRecords(), 5_000));
  }

  public onunload(): void {
    if (this.indexSyncTimer !== undefined) window.clearTimeout(this.indexSyncTimer);
    if (this.dashboardRefreshTimer !== undefined) window.clearTimeout(this.dashboardRefreshTimer);
    this.watchedConversionIds.clear();
    this.app.workspace.detachLeavesOfType(DASHBOARD_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(OKF_DASHBOARD_VIEW);
    for (const surface of [...this.embeddedDashboardSurfaces]) void surface.onClose();
    this.embeddedDashboardSurfaces.clear();
    for (const unregister of this.unregisterApexSections.splice(0)) unregister();
    this.apexHost?.destroy();
    void this.dashboardUiStateStore?.dispose().catch((error: unknown) => {
      console.error("[okf-workspace] could not flush Dashboard UI state", error);
    });
    void this.localService?.stop();
  }

  private async initializeManagedEngine(): Promise<void> {
    if (!this.settings.manageLocalService || !this.localService) return;
    try {
      const result = await this.localService.ensureStarted();
      console.info(`[okf-workspace] local service ${result}`);
    } catch (error) {
      console.error("[okf-workspace] local service startup failed", error);
      new Notice(error instanceof Error ? error.message : "工作区本地服务启动失败", 10_000);
    }
  }

  public async saveSettings(): Promise<void> {
    const dashboardUiState = this.dashboardUiStateStore?.snapshot() ??
      normalizeDashboardUiState(this.settings.dashboardUiState);
    this.settings.dashboardUiState = dashboardUiState;
    const feedReadingPositions: OkfBrainSettings["feedReadingPositions"] = {};
    for (const feed of ["ai-daily", "treehole"] as const) {
      const position = dashboardUiState.feeds[feed];
      if (position.editionId && position.itemId && position.updatedAt) {
        feedReadingPositions[feed] = {
          editionId: position.editionId,
          itemId: position.itemId,
          updatedAt: position.updatedAt,
        };
      }
    }
    this.settings.feedReadingPositions = feedReadingPositions;
    await this.saveData({
      ...this.persistedSettings,
      baseUrl: this.settings.baseUrl,
      tokenFile: this.settings.tokenFile,
      manageLocalService: this.settings.manageLocalService,
      pythonExecutable: this.settings.pythonExecutable,
      deploymentConfig: this.settings.deploymentConfig,
      serviceLogDirectory: this.settings.serviceLogDirectory,
      documentParserPolicy: this.settings.documentParserPolicy,
      dashboardUiState,
      feedReadingPositions,
      apex: this.settings.apex,
    });
  }

  public getDashboardUiState(): DashboardUiState {
    return this.dashboardUiStateStore?.snapshot() ??
      normalizeDashboardUiState(this.settings.dashboardUiState);
  }

  public updateDashboardUiState(patch: DashboardUiStatePatch): DashboardUiState {
    const state = this.dashboardUiStateStore
      ? this.dashboardUiStateStore.update(patch)
      : patchDashboardUiState(this.settings.dashboardUiState, patch);
    this.settings.dashboardUiState = state;
    return state;
  }

  public updateDashboardPageUiState(
    section: DashboardSection,
    patch: DashboardPageUiStatePatch,
  ): DashboardUiState {
    return this.updateDashboardUiState({ pages: { [section]: patch } });
  }

  public updateDashboardFeedUiState(
    feed: DashboardFeed,
    patch: DashboardFeedUiStatePatch,
  ): DashboardUiState {
    return this.updateDashboardUiState({ feeds: { [feed]: patch } });
  }

  public updateDashboardReadingSourceUiState(
    sourceId: string,
    patch: DashboardReadingSourceUiStatePatch,
  ): DashboardUiState {
    return this.updateDashboardUiState({ readingSources: { [sourceId]: patch } });
  }

  public recentDashboardFiles(): readonly RecentDashboardFile[] {
    return this.getDashboardUiState().recentFiles;
  }

  public feedReadingPosition(feed: FeedKind): FeedReadingPosition | undefined {
    const position = this.getDashboardUiState().feeds[feed];
    return position.editionId && position.itemId && position.updatedAt
      ? {
          editionId: position.editionId,
          itemId: position.itemId,
          updatedAt: position.updatedAt,
        }
      : undefined;
  }

  public async rememberFeedReadingPosition(
    feed: FeedKind,
    editionId: string,
    itemId: string,
  ): Promise<void> {
    const current = this.getDashboardUiState().feeds[feed];
    if (current?.editionId === editionId && current.itemId === itemId) return;
    this.updateDashboardFeedUiState(feed, {
      editionId,
      itemId,
      updatedAt: new Date().toISOString(),
    });
  }

  public async reloadLocalToken(): Promise<void> {
    try {
      this.settings.token = readFileSync(this.settings.tokenFile, "utf8").trim();
    } catch {
      this.settings.token = "";
    }
  }

  public promptCapture(initial: CaptureRelation = {}): void {
    void this.openQuickCapture(initial).catch((error: unknown) => {
      new Notice(error instanceof Error ? error.message : "无法打开快速记录", 10_000);
    });
  }

  private async openQuickCapture(initial: CaptureRelation): Promise<void> {
    const contexts = await this.notes().captureContexts();
    new QuickCaptureModal(this.app, contexts, initial, async (value, relation) => {
      const title = value.split(/\r?\n/u)[0]?.trim() || "随手记录";
      const result = await this.notes().createCapture(title, value, relation);
      const notice = new Notice("", 15_000);
      notice.noticeEl.empty();
      notice.noticeEl.createEl("strong", { text: "已保存到待处理" });
      const context = relation.course
        ? {
            kind: "Course",
            option: contexts.courses.find((item) =>
              relationVaultPath(item.path) === relationVaultPath(relation.course ?? "")
            ),
          }
        : relation.project
          ? {
              kind: "Project",
              option: contexts.projects.find((item) =>
                relationVaultPath(item.path) === relationVaultPath(relation.project ?? "")
              ),
            }
          : undefined;
      if (context) {
        notice.noticeEl.createDiv({
          text: `已关联 ${context.kind === "course" ? "课程" : "项目"}${context.option ? `：${context.option.title}` : ""}，可稍后整理`,
        });
      }
      const open = notice.noticeEl.createEl("button", { text: "打开记录" });
      open.addEventListener("click", () => {
        notice.hide();
        void this.openVaultPath(result.path);
      });
      this.refreshDashboardViews();
    }).open();
  }

  public promptDailyCapture(): void {
    void this.openDailyForWriting().catch((error: unknown) => {
      new Notice(error instanceof Error ? error.message : "无法打开今日日记", 10_000);
    });
  }

  public async openDailyForWriting(): Promise<void> {
    const result = await this.notes().createDaily();
    await this.openVaultHeading(result.path, "随手记录");
    this.refreshDashboardViews();
  }

  public promptActionMenu(): void {
    new ChoiceModal(
      this.app,
      [
        { value: "daily", label: "继续写今日日记", description: "打开今天的日记" },
        { value: "jot", label: "打开随手记录", description: "定位到今日日记的原生 Markdown 编辑区" },
        {
          value: "capture",
          label: "快速记录",
          description: "保存到待处理，可选关联课程或项目",
        },
        { value: "class", label: "新建课堂笔记", description: "先选择已有课程" },
        { value: "course", label: "新建课程", description: "创建课程主页" },
        { value: "project", label: "新建项目", description: "创建项目主页与日志" },
        { value: "import", label: "导入资料", description: "PDF、Word 或 PowerPoint" },
        { value: "ask", label: "问我的笔记", description: "在 Claudian 中读取相关笔记后回答" },
      ] as const,
      "快捷操作",
      async (choice) => {
        if (choice === "daily") {
          const result = await this.createDaily();
          await this.openVaultPath(result.path);
        } else if (choice === "jot") this.promptDailyCapture();
        else if (choice === "capture") this.promptCapture();
        else if (choice === "class") this.promptLesson();
        else if (choice === "course") this.promptCourse();
        else if (choice === "project") this.promptProject();
        else if (choice === "import") this.promptDocumentImport();
        else this.promptAsk();
      },
    ).open();
  }

  public openChineseCalendar(): void {
    const commands = (
      this.app as typeof this.app & {
        commands?: { executeCommandById: (id: string) => boolean };
      }
    ).commands;
    const plugins = (
      this.app as typeof this.app & {
        plugins?: {
          enabledPlugins?: Set<string>;
          getPlugin?: (id: string) => unknown;
        };
      }
    ).plugins;
    const pluginEnabled = plugins
      ? Boolean(
          plugins.getPlugin?.(CHINESE_CALENDAR_PLUGIN_ID) ??
          plugins.enabledPlugins?.has(CHINESE_CALENDAR_PLUGIN_ID),
        )
      : undefined;
    void showChineseCalendar({
      leaves: () => this.app.workspace.getLeavesOfType(CHINESE_CALENDAR_VIEW_TYPE),
      reveal: (leaf) => this.app.workspace.revealLeaf(leaf),
      executeCreateCommand: () =>
        commands?.executeCommandById(CHINESE_CALENDAR_COMMAND_ID) ?? false,
      ...(pluginEnabled === undefined ? {} : { pluginEnabled }),
      afterCreate: () => new Promise((resolve) => window.setTimeout(resolve, 50)),
    }).catch((error: unknown) => {
      new Notice(error instanceof Error ? error.message : "无法显示日历", 8_000);
    });
  }

  public openPluginSettings(): void {
    const setting = (
      this.app as typeof this.app & {
        setting?: { open: () => void; openTabById: (id: string) => void };
      }
    ).setting;
    if (!setting) {
      new Notice("无法打开 Obsidian 插件设置", 6_000);
      return;
    }
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  public async openCodexPrompt(
    prompt: string,
    options: Omit<CodexHandoffRequest, "prompt"> = {},
  ): Promise<void> {
    if (!this.claudianBridge) throw new Error("Claudian Bridge 尚未初始化");
    const request: CodexHandoffRequest = {
      prompt,
      actionMode: "read",
      autoSend: false,
      newSession: true,
      ...options,
    };
    if (!this.claudianBridge.isAvailable()) {
      const fallback = buildClaudianFallbackText(request);
      let copied = false;
      try {
        await navigator.clipboard.writeText(fallback);
        copied = true;
      } catch (error) {
        console.warn("[okf-workspace] could not copy Claudian fallback", error);
      }
      const firstContext = request.contextPaths?.[0];
      if (firstContext) await this.openVaultPath(firstContext);
      new Notice(
        copied
          ? "Claudian 未启用；提示词和上下文路径已复制，并已打开首个上下文文件。"
          : "Claudian 未启用；已打开首个上下文文件。请启用 Claudian 插件 后重试 AI 操作。",
        10_000,
      );
      return;
    }
    const result = await this.claudianBridge.handoff(request);
    new Notice(
      result.sent
        ? "任务已在 Claudian 中提交"
        : `任务已在 Claudian 中准备好${result.contextCount ? ` · ${result.contextCount} 个上下文文件` : ""}`,
      6_000,
    );
  }

  public isCodexConsoleAvailable(): boolean {
    return this.claudianBridge?.isAvailable() ?? false;
  }

  public async openCodexConsole(): Promise<void> {
    if (!this.claudianBridge) throw new Error("Claudian Bridge 尚未初始化");
    await this.claudianBridge.open();
  }

  public async organizeTodayInCodex(): Promise<void> {
    const daily = await this.notes().createDaily();
    await this.openCodexPrompt(
      ORGANIZE_DAILY_PROMPT,
      {
        contextPaths: [daily.path],
        actionMode: "write",
        skill: "organize-daily",
      },
    );
  }

  public promptAsk(): void {
    new TextPromptModal(this.app, "问我的笔记", "输入问题", "在 Claudian 中准备", async (value) => {
      const active = this.app.workspace.getActiveFile();
      await this.openCodexPrompt(value, {
        actionMode: "read",
        skill: "retrieve-vault-context",
        ...(active instanceof TFile && active.extension === "md"
          ? { contextPaths: [active.path] }
          : {}),
      });
    }).open();
  }

  public promptReflection(): void {
    new FieldsPromptModal(
      this.app,
      "新建反思",
      [
        { key: "title", label: "标题", placeholder: "这篇反思想讨论什么？" },
      ],
      "创建并打开",
      async (values) => {
        const result = await this.notes().createReflection(
          values.title ?? "反思",
          "",
        );
        await this.openVaultPath(result.path);
      },
    ).open();
  }

  public promptReview(): void {
    new ChoiceModal<ReviewPeriod>(
      this.app,
      [
        {
          value: "weekly",
          label: "Weekly 复盘",
          description: "打开已有或创建本周复盘",
        },
        {
          value: "monthly",
          label: "Monthly 复盘",
          description: "打开已有或创建本月复盘",
        },
        {
          value: "yearly",
          label: "Yearly 复盘",
          description: "打开已有或创建本年复盘",
        },
      ],
      "选择复盘周期",
      async (period) => {
        const result = await this.notes().createReview(period);
        new Notice(result.created ? "已创建本期复盘" : "已打开已有复盘", 6_000);
        await this.openVaultPath(result.path);
      },
    ).open();
  }

  public promptCourse(onCreated?: (slug: string) => void): void {
    new FieldsPromptModal(
      this.app,
      "新建课程",
      [
        { key: "title", label: "课程名称", placeholder: "医学统计学" },
        {
          key: "slug",
          label: "目录名（可留空）",
          placeholder: "medical-statistics",
          required: false,
        },
      ],
      "创建课程",
      async (values) => {
        const result = await this.notes().createCourse(
          values.title ?? "课程",
          values.slug || undefined,
        );
        new Notice("课程已创建：" + result.path);
        await this.openVaultPath(result.path);
        const slug = result.path.split("/")[2];
        if (slug) onCreated?.(slug);
      },
    ).open();
  }

  public promptLesson(): void {
    this.selectCourse("选择课堂笔记所属课程", (course) => this.openLessonPrompt(course));
  }

  public promptLessonForCourse(coursePath: string): void {
    const match = /^\/?learning\/courses\/([^/]+)\/course\.md$/u.exec(coursePath.trim());
    if (!match?.[1]) {
      new Notice(`无法识别课程：${coursePath}`);
      return;
    }
    this.openLessonPrompt(match[1]);
  }

  private openLessonPrompt(course: string): void {
    new FieldsPromptModal(
      this.app,
      "新建课堂笔记",
      [
        { key: "title", label: "本节课标题", placeholder: "回归分析" },
      ],
      "创建并打开",
      async (values) => {
        const result = await this.notes().createLesson(
          course,
          values.title ?? "课堂笔记",
          "",
        );
        await this.openVaultPath(result.path);
      },
    ).open();
  }

  public promptProject(onCreated?: (slug: string) => void): void {
    new FieldsPromptModal(
      this.app,
      "新建项目",
      [
        { key: "title", label: "项目名称", placeholder: "个人知识库" },
        { key: "slug", label: "目录名（可留空）", placeholder: "workspace", required: false },
      ],
      "创建项目",
      async (values) => {
        const result = await this.notes().createProject(
          values.title ?? "项目",
          values.slug || undefined,
        );
        new Notice("项目已创建：" + result.path);
        await this.openVaultPath(result.path);
        const slug = result.path.split("/")[1];
        if (slug) onCreated?.(slug);
      },
    ).open();
  }

  public promptProjectProgress(projectPath: string): void {
    new ProjectLogModal(
      this.app,
      async (value) => {
        const slug = projectPath.split("/")[1];
        if (!slug) throw new Error("项目路径无效");
        if (!value) {
          await this.openVaultPath(`projects/${slug}/log.md`);
          return;
        }
        const result = await this.notes().appendProjectLog(slug, value);
        const notice = new Notice("", 12_000);
        notice.noticeEl.empty();
        notice.noticeEl.createEl("strong", { text: "已追加到项目日志" });
        const open = notice.noticeEl.createEl("button", { text: "打开日志" });
        open.addEventListener("click", () => {
          notice.hide();
          void this.openVaultPath(result.path);
        });
        this.refreshDashboardViews();
      },
    ).open();
  }

  public promptProjectDecision(projectPath: string): void {
    new FieldsPromptModal(
      this.app,
      "记录项目决策",
      [
        { key: "title", label: "标题", placeholder: "采用 Markdown 作为唯一权威" },
      ],
      "创建并打开",
      async (values) => {
        const slug = projectPath.split("/")[1];
        if (!slug) throw new Error("项目路径无效");
        const result = await this.notes().createDecision(
          slug,
          values.title ?? "项目决定",
        );
        await this.openVaultPath(result.path);
        this.refreshDashboardViews();
      },
    ).open();
  }

  public promptNewDecision(): void {
    this.selectProject("选择决策所属项目", (project) => {
      this.promptProjectDecision(`projects/${project}/project.md`);
    });
  }

  public promptProjectStatus(
    projectPath: string,
    current: "active" | "paused" | "completed",
  ): void {
    const options = ([
      { value: "active", label: "进行中", description: "继续推进这个项目" },
      { value: "paused", label: "已暂停", description: "暂时停止，但保留后续入口" },
      { value: "completed", label: "已完成", description: "项目已达到完成条件" },
    ] as const).filter((option) => option.value !== current);
    new ChoiceModal(this.app, options, "更改项目状态", async (status) => {
      await this.setProjectStatus(projectPath, status);
      new Notice(`项目状态已更新为${noteStatusLabel(status)}`);
    }).open();
  }

  public promptTaskDates(task: VaultTask): void {
    new FieldsPromptModal(
      this.app,
      `编辑任务日期：${task.text}`,
      [
        { key: "reminder", label: "提醒", placeholder: "YYYY-MM-DD 或 YYYY-MM-DD HH:MM", initialValue: task.reminder ?? "", required: false },
        { key: "scheduled", label: "计划日", placeholder: "YYYY-MM-DD", initialValue: task.scheduled ?? "", required: false },
        { key: "due", label: "截止日", placeholder: "YYYY-MM-DD", initialValue: task.due ?? "", required: false },
      ],
      "保存日期",
      async (values) => {
        const wrote = await updateTaskDatesInFile(this.app, task, {
          reminder: values.reminder,
          scheduled: values.scheduled,
          due: values.due,
        });
        if (!wrote) throw new Error("任务已变化或日期没有改变，请刷新后重试。");
        new Notice("任务日期已更新");
        this.refreshDashboardViews();
      },
    ).open();
  }

  public promptWikiFromSources(): void {
    const activePath = this.app.workspace.getActiveFile()?.path ?? "";
    new FieldsPromptModal(
      this.app,
      "从材料生成知识笔记草稿",
      [
        { key: "title", label: "知识笔记标题", placeholder: "LiveSync 不是备份" },
        {
          key: "paths",
          label: "来源笔记路径（每行一个）",
          placeholder: "knowledge/wiki/livesync.md",
          multiline: true,
          initialValue: activePath,
        },
        {
          key: "instruction",
          label: "补充要求（可留空）",
          placeholder: "比较三篇材料的共识与冲突",
          multiline: true,
          required: false,
        },
      ],
      "读取来源并创建草稿",
      async (values) => {
        const paths = (values.paths ?? "")
          .split(/[\r\n,，]+/u)
          .map((value) => value.trim())
          .filter(Boolean);
        await this.openCodexPrompt(
          `请读取附带的来源，围绕“${values.title ?? "知识笔记草稿"}”沉淀一篇可长期复用的知识笔记。` +
            "先核对相关的既有知识笔记，选择创建或更新，保留来源依据与尚未解决的不确定性。" +
            `\n\n补充要求：${values.instruction || "无"}`,
          {
            contextPaths: paths,
            actionMode: "write",
            skill: "distill-wiki",
          },
        );
      },
    ).open();
  }

  public promptRewriteCurrentSection(): void {
    const active = this.app.workspace.getActiveFile();
    if (!(active instanceof TFile) || active.extension !== "md") {
      new Notice("请先打开要修改的 Markdown 笔记");
      return;
    }
    new FieldsPromptModal(
      this.app,
      "AI 改写当前笔记指定章节",
      [
        { key: "heading", label: "章节标题", placeholder: "第二节标题（不写 ##）" },
        {
          key: "instruction",
          label: "修改要求",
          placeholder: "在不改变事实的前提下写得更简洁",
          multiline: true,
        },
      ],
      "只修改这一节",
      async (values) => {
        await this.openCodexPrompt(
          `请读取 ${active.path}，定位标题为“${values.heading ?? ""}”的章节，` +
            "只按以下要求修改该章节正文，保留标题、其他章节、未知 frontmatter 和已有链接。" +
            `若有多个同名章节，先询问目标位置。\n\n修改要求：${values.instruction ?? ""}`,
          { contextPaths: [active.path], actionMode: "write" },
        );
      },
    ).open();
  }

  public promptCaptureProject(capturePath: string): void {
    const organize = (project: string): void => {
      void this.api().organizeCapture(capturePath, "project-log", { project }).then(() => {
        new Notice("随手记录已进入项目日志");
        this.refreshDashboardViews();
      }).catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : "写入项目日志失败", 10_000);
      });
    };
    const linked = this.captureRelationSlug(capturePath, "project");
    routeCaptureUsingLinkedContext(
      linked,
      (onSelect) => this.selectProject("选择要写入的项目", onSelect),
      organize,
    );
  }

  public promptCaptureLesson(capturePath: string): void {
    const organize = (course: string): void => {
      void this.api().organizeCapture(capturePath, "lesson", { course }).then((result) => {
        void this.openVaultPath(result.created_or_updated);
        this.refreshDashboardViews();
      }).catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : "创建课堂笔记失败", 10_000);
      });
    };
    const linked = this.captureRelationSlug(capturePath, "course");
    routeCaptureUsingLinkedContext(
      linked,
      (onSelect) => this.selectCourse("选择课堂笔记所属课程", onSelect),
      organize,
    );
  }

  private captureRelationSlug(capturePath: string, kind: "course" | "project"): string | undefined {
    const path = relationVaultPath(capturePath);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return undefined;
    const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[kind];
    if (typeof value !== "string") return undefined;
    const relation = relationVaultPath(value);
    const match = kind === "course"
      ? /^learning\/courses\/([^/]+)\/course\.md$/u.exec(relation)
      : /^projects\/([^/]+)\/project\.md$/u.exec(relation);
    return match?.[1];
  }

  public promptPublishWebCapture(
    capturePath: string,
    action: WebCaptureAction,
  ): void {
    this.promptMaterialContext("要将这份网页资料关联到课程或项目吗？", (relation) =>
      this.publishWebCapture(capturePath, { action, ...relation }),
    );
  }

  private async publishWebCapture(
    capturePath: string,
    options: {
      action: WebCaptureAction;
      course?: string;
      project?: string;
    },
  ): Promise<void> {
    try {
      await this.ensureLocalServiceAvailable();
      const result = await this.api().publishWebCapture(capturePath, options);
      if (result.semantic_operation) {
        this.watchSemanticOperation(result.semantic_operation.operation_id);
      }
      const notice = new Notice("", 20_000);
      notice.noticeEl.empty();
      notice.noticeEl.createEl("strong", {
        text: result.semantic_operation
          ? "网页资料已保存并进入后台生成"
          : result.semantic_error
            ? "网页资料已保存，但后台生成未启动"
            : result.reused
              ? "已合并到现有来源"
              : "网页资料已保存",
      });
      if (result.semantic_error) notice.noticeEl.createDiv({ text: result.semantic_error });
      const open = notice.noticeEl.createEl("button", { text: "打开已保存的资料正文" });
      open.addEventListener("click", () => {
        notice.hide();
        void this.openVaultPath(result.source_text);
      });
      this.refreshDashboardViews();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "网页资料保存失败", 10_000);
    }
  }

  private selectCourse(placeholder: string, onSelect: (slug: string) => void): void {
    void new VaultDashboardReader(this.app).learning().then((projection) => {
      const options = projection.courses.map((course) => ({
        value: course.path.split("/")[2] ?? "",
        label: course.title,
        description: `${course.current_progress || "尚未填写进度"} · ${course.guide_count} 份学习笔记`,
      })).filter((option) => option.value);
      options.push({ value: "__new__", label: "新建课程…", description: "创建后自动继续当前操作" });
      new ChoiceModal(this.app, options, placeholder, async (value) => {
        if (value === "__new__") this.promptCourse(onSelect);
        else onSelect(value);
      }).open();
    }).catch((error: unknown) => {
      new Notice(error instanceof Error ? error.message : "无法读取课程列表", 10_000);
    });
  }

  private selectProject(placeholder: string, onSelect: (slug: string) => void): void {
    void new VaultDashboardReader(this.app).projects().then((projection) => {
      const options = projection.projects.map((project) => ({
        value: project.path.split("/")[1] ?? "",
        label: project.title,
        description: project.next_action || noteStatusLabel(project.project_status) || "暂无下一步",
      })).filter((option) => option.value);
      options.push({ value: "__new__", label: "新建项目…", description: "创建后自动继续当前操作" });
      new ChoiceModal(this.app, options, placeholder, async (value) => {
        if (value === "__new__") this.promptProject(onSelect);
        else onSelect(value);
      }).open();
    }).catch((error: unknown) => {
      new Notice(error instanceof Error ? error.message : "无法读取项目列表", 10_000);
    });
  }

  public promptRoutePendingSource(
    path: string,
    intent: "learn" | "wiki" | "source",
  ): void {
    if (intent !== "learn") {
      this.promptPendingSourceContext(path, intent, intent === "wiki");
      return;
    }
    new ChoiceModal(
      this.app,
      [
        {
          value: "generate",
          label: "立即生成辅助学习材料",
          description: "保存资料后在后台生成",
        },
        {
          value: "later",
          label: "加入待学习列表",
          description: "之后可在学习页面主动生成",
        },
      ] as const,
      "是否现在生成辅助学习材料？",
      async (choice) => this.promptPendingSourceContext(path, intent, choice === "generate"),
    ).open();
  }

  private promptPendingSourceContext(
    path: string,
    intent: "learn" | "wiki" | "source",
    generate: boolean,
  ): void {
    this.promptMaterialContext("要将这份资料关联到课程或项目吗？", (relation) =>
      this.routePendingSource(path, { intent, generate, ...relation }),
    );
  }

  private promptMaterialContext(
    title: string,
    onSelect: (relation: { course?: string; project?: string }) => Promise<void> | void,
  ): void {
    new ChoiceModal(
      this.app,
      [
        { value: "independent", label: "独立资料", description: "不关联课程或项目" },
        { value: "course", label: "关联已有课程", description: "从当前课程列表中选择" },
        { value: "project", label: "关联已有项目", description: "从当前项目列表中选择" },
      ] as const,
      title,
      async (context) => {
        if (context === "course") {
          this.selectCourse("选择资料所属课程", (course) => {
            void onSelect({ course });
          });
        } else if (context === "project") {
          this.selectProject("选择资料所属项目", (project) => {
            void onSelect({ project });
          });
        } else {
          await onSelect({});
        }
      },
    ).open();
  }

  private async routePendingSource(
    path: string,
    options: {
      intent: "learn" | "wiki" | "source";
      generate: boolean;
      course?: string;
      project?: string;
    },
  ): Promise<void> {
    try {
      const result = await this.api().routeImportedSource(path, options);
      if (result.semantic_operation) {
        this.watchSemanticOperation(result.semantic_operation.operation_id);
      }
      const target = result.routed_target ?? result.source_text;
      const notice = new Notice("", 20_000);
      notice.noticeEl.empty();
      notice.noticeEl.createEl("strong", {
        text: result.semantic_operation ? "已归类并进入后台生成" : "资料已归类",
      });
      const open = notice.noticeEl.createEl("button", { text: "打开结果" });
      open.addEventListener("click", () => {
        notice.hide();
        void this.openVaultPath(target);
      });
      this.refreshDashboardViews();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "资料归类失败", 10_000);
    }
  }

  public async openDashboard(): Promise<void> {
    try {
      const result = await this.localService?.ensureStarted();
      if (result) console.info(`[okf-workspace] local service ${result}`);
    } catch (error) {
      new Notice(
        (error instanceof Error ? error.message : "工作区本地服务不可用") +
          "；仍可浏览本地笔记页面",
        10_000,
      );
    }
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private activeApexView(origin?: HTMLElement, workbenchPath?: string): { leaf: WorkspaceLeaf; view: DashboardView } | undefined {
    const leaves = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    const leaf = (origin
      ? leaves.find((candidate) => candidate.view instanceof DashboardView && candidate.view.containerEl.contains(origin))
      : undefined)
      ?? (workbenchPath
        ? leaves.find((candidate) => candidate.view instanceof DashboardView && candidate.view.currentWorkspacePath() === workbenchPath)
        : undefined)
      ?? leaves.find((candidate) => candidate.view === this.app.workspace.getActiveViewOfType(DashboardView))
      ?? leaves[0];
    return leaf?.view instanceof DashboardView ? { leaf, view: leaf.view } : undefined;
  }

  public async returnToOkfWorkbench(workbenchPath?: string): Promise<void> {
    let target = this.activeApexView(undefined, workbenchPath);
    if (!target) {
      await this.openDashboard();
      target = this.activeApexView();
    }
    if (!target) return;
    if (workbenchPath && target.view.currentWorkspacePath() !== workbenchPath &&
      this.settings.apex.workspaceFiles.includes(workbenchPath)) {
      await target.view.switchWorkspace(workbenchPath);
    }
    await this.app.workspace.revealLeaf(target.leaf);
  }

  public hasOkfSectionInActiveWorkbench(section: EmbeddedDashboardSection, workbenchPath?: string): boolean {
    const target = this.activeApexView(undefined, workbenchPath);
    return !!target && (!workbenchPath || target.view.currentWorkspacePath() === workbenchPath) &&
      target.view.hasSectionType(OKF_SECTION_TYPES[section]);
  }

  public async navigateToOkfSection(section: EmbeddedDashboardSection, origin?: HTMLElement, workbenchPath?: string): Promise<void> {
    const target = this.activeApexView(origin, workbenchPath);
    if (target && (!workbenchPath || target.view.currentWorkspacePath() === workbenchPath) &&
      target.view.hasSectionType(OKF_SECTION_TYPES[section])) {
      await this.app.workspace.revealLeaf(target.leaf);
      target.view.refreshSectionType(OKF_SECTION_TYPES[section]);
      if (target.view.revealSectionType(OKF_SECTION_TYPES[section])) return;
    }
    this.updateDashboardUiState({ activeSection: section });
    const existing = this.app.workspace.getLeavesOfType(OKF_DASHBOARD_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: OKF_DASHBOARD_VIEW,
      state: { section, workbenchPath: target?.view.currentWorkspacePath() ?? workbenchPath },
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  public async addOkfSectionToActiveWorkbench(section: EmbeddedDashboardSection, workbenchPath?: string): Promise<void> {
    if (workbenchPath && !this.settings.apex.workspaceFiles.includes(workbenchPath)) {
      new Notice("原工作台已不存在，请返回工作台后再添加卡片。");
      return;
    }
    if (!this.activeApexView()) await this.openDashboard();
    const target = this.activeApexView(undefined, workbenchPath);
    if (!target) {
      new Notice("无法打开当前工作台，请重试。");
      return;
    }
    if (workbenchPath && target.view.currentWorkspacePath() !== workbenchPath &&
      this.settings.apex.workspaceFiles.includes(workbenchPath)) {
      await target.view.switchWorkspace(workbenchPath);
    }
    await target.view.addSectionType(OKF_SECTION_TYPES[section], okfSectionDefaultName(section));
    await this.app.workspace.revealLeaf(target.leaf);
  }

  public async openFeedDigest(feed: FeedKind, digestId: string): Promise<void> {
    await this.ensureLocalServiceAvailable();
    const opened = await new HttpFeedApi(
      this.settings.baseUrl,
      this.settings.token,
    ).openDigest(feed, digestId);
    await this.openVaultPath(opened.vault_path);
  }

  public async loadFeedDashboardDigest(): Promise<FeedDashboardDigest> {
    if (this.feedDigestCache && Date.now() - this.feedDigestCache.loadedAt < 120_000) {
      return this.feedDigestCache.value;
    }
    if (this.feedDigestRequest) return this.feedDigestRequest;
    const api = new HttpFeedApi(this.settings.baseUrl, this.settings.token);
    const revision = this.feedProjectionRevision;
    const request = (async () => {
      try {
        const value = await api.dashboardDigest();
        if (revision === this.feedProjectionRevision) {
          this.feedDigestCache = { value, loadedAt: Date.now() };
        }
        return value;
      } catch (error) {
        // A rejected HTTP response (for example an expired token) is an API
        // error. Starting another service cannot repair it and hides the
        // useful response behind a misleading launch-configuration error.
        if (!(error instanceof FeedTransportError)) throw error;
        await this.ensureLocalServiceAvailable();
        const value = await api.dashboardDigest();
        if (revision === this.feedProjectionRevision) {
          this.feedDigestCache = { value, loadedAt: Date.now() };
        }
        return value;
      }
    })();
    this.feedDigestRequest = request;
    try {
      return await request;
    } finally {
      if (this.feedDigestRequest === request) this.feedDigestRequest = undefined;
    }
  }

  public feedDashboardDigestSnapshot(): FeedDashboardDigest | undefined {
    return this.feedDigestCache?.value;
  }

  public feedProjectionVersion(): number {
    return this.feedProjectionRevision;
  }

  public feedDecisionSnapshot(
    feed: FeedKind,
    itemId: string,
  ): FeedDecisionResult | undefined {
    return this.feedDecisionCache.get(this.feedDecisionKey(feed, itemId));
  }

  public async loadFeedSubscriptions(
    query: FeedSubscriptionPageQuery = {},
  ): Promise<FeedSubscriptionPage> {
    const api = new HttpFeedApi(this.settings.baseUrl, this.settings.token);
    try {
      return await api.listSubscriptions(query);
    } catch (error) {
      if (!(error instanceof FeedTransportError)) throw error;
      await this.ensureLocalServiceAvailable();
      return api.listSubscriptions(query);
    }
  }

  public async loadFeedSubscriptionSources(
    query: FeedSubscriptionSourcePageQuery = {},
  ): Promise<FeedSubscriptionSourcePage> {
    const api = new HttpFeedApi(this.settings.baseUrl, this.settings.token);
    try {
      return await api.listSubscriptionSources(query);
    } catch (error) {
      if (!(error instanceof FeedTransportError)) throw error;
      await this.ensureLocalServiceAvailable();
      return api.listSubscriptionSources(query);
    }
  }

  public async loadFeedSubscriptionSourceItems(
    sourceId: string,
    query: FeedSubscriptionSourceItemsQuery = {},
  ): Promise<FeedSubscriptionSourceItemsPage> {
    const api = new HttpFeedApi(this.settings.baseUrl, this.settings.token);
    try {
      return await api.listSubscriptionSourceItems(sourceId, query);
    } catch (error) {
      if (!(error instanceof FeedTransportError)) throw error;
      await this.ensureLocalServiceAvailable();
      return api.listSubscriptionSourceItems(sourceId, query);
    }
  }

  public promptAddFeedSubscription(): void {
    new FeedSubscriptionAddModal(this.app, {
      preview: (request) => this.previewFeedSubscription(request),
      confirm: (request) => this.confirmFeedSubscription(request),
      confirmed: (result) => {
        this.invalidateFeedProjections();
        this.refreshDashboardViews();
        new Notice(
          result.next_run_will_include_current
            ? "订阅已添加；当前内容会在首次更新中进入订阅阅读"
            : "订阅已添加；将从下一次新内容开始",
          8_000,
        );
      },
    }).open();
  }

  public promptFeedSubscriptionSettings(source: FeedSubscriptionSource): void {
    new FeedSubscriptionSettingsModal(this.app, source, {
      load: () => this.loadManagedFeedSubscriptions(),
      enable: (sourceId, request) => this.enableFeedSubscription(sourceId, request),
      disable: (sourceId, request) => this.disableFeedSubscription(sourceId, request),
      remove: (sourceId, request) => this.removeFeedSubscription(sourceId, request),
      changed: () => {
        this.invalidateFeedProjections();
        this.refreshDashboardViews();
      },
    }).open();
  }

  public previewFeedSubscription(
    request: FeedSubscriptionPreviewRequest,
  ): Promise<FeedSubscriptionPreview> {
    return this.withFeedApi((api) => api.previewSubscription(request));
  }

  public confirmFeedSubscription(
    request: FeedSubscriptionConfirmRequest,
  ): Promise<FeedSubscriptionConfirmResult> {
    return this.withFeedApi((api) => api.confirmSubscription(request));
  }

  public loadManagedFeedSubscriptions(): Promise<FeedSubscriptionManagementPage> {
    return this.withFeedApi((api) => api.listManagedSubscriptions());
  }

  public enableFeedSubscription(
    sourceId: string,
    request: FeedSubscriptionMutationRequest,
  ): Promise<FeedSubscriptionMutationResult> {
    return this.withFeedApi((api) => api.enableSubscription(sourceId, request));
  }

  public disableFeedSubscription(
    sourceId: string,
    request: FeedSubscriptionMutationRequest,
  ): Promise<FeedSubscriptionMutationResult> {
    return this.withFeedApi((api) => api.disableSubscription(sourceId, request));
  }

  public removeFeedSubscription(
    sourceId: string,
    request: FeedSubscriptionRemoveRequest,
  ): Promise<FeedSubscriptionRemoveResult> {
    return this.withFeedApi((api) => api.removeSubscription(sourceId, request));
  }

  private async withFeedApi<T>(operation: (api: HttpFeedApi) => Promise<T>): Promise<T> {
    const api = new HttpFeedApi(this.settings.baseUrl, this.settings.token);
    try {
      return await operation(api);
    } catch (error) {
      if (!(error instanceof FeedTransportError)) throw error;
      await this.ensureLocalServiceAvailable();
      return operation(api);
    }
  }

  public async syncFeedsNow(): Promise<FeedSyncResult[]> {
    await this.ensureLocalServiceAvailable();
    if (this.feedDigestRequest) {
      try {
        await this.feedDigestRequest;
      } catch {
        // A failed stale request must not block an explicit synchronization.
      }
    }
    const results = await this.api().syncFeeds();
    this.invalidateFeedProjections();
    evictUnresolvedFeedDecisions(this.feedDecisionCache);
    try {
      await this.loadFeedDashboardDigest();
    } catch (error) {
      console.warn("[okf-workspace] feeds synchronized but dashboard refresh failed", error);
    }
    return results;
  }

  public async openFeedItem(
    feed: FeedKind,
    digestId: string,
    blockId: string,
  ): Promise<void> {
    await this.ensureLocalServiceAvailable();
    const opened = await new HttpFeedApi(
      this.settings.baseUrl,
      this.settings.token,
    ).openDigest(feed, digestId);
    await this.openVaultPath(opened.vault_path, blockId);
  }

  private api(): LocalApi {
    return new LocalApi(this.settings.baseUrl, this.settings.token);
  }

  public createDaily(): Promise<{ path: string }> {
    return this.notes().createDaily();
  }

  public async setStudyCompleted(path: string, completed: boolean): Promise<{ path: string }> {
    const result = await this.notes().setStudyCompleted(path, completed);
    this.refreshDashboardViews();
    return result;
  }

  public async setProjectStatus(
    path: string,
    status: "active" | "paused" | "completed",
  ): Promise<{ path: string }> {
    const result = await this.notes().setProjectStatus(path, status);
    this.refreshDashboardViews();
    return result;
  }

  private notes(): VaultNoteService {
    if (!this.vaultNotes) throw new Error("笔记保存功能尚未就绪，请稍后重试");
    return this.vaultNotes;
  }

  public watchSemanticOperation(operationId: string): void {
    void this.api()
      .semanticOperation(operationId)
      .then((operation) => {
        this.rememberSemanticOperation(operation);
        this.semanticMonitor.watch(operation);
        if (["completed", "failed", "cancelled", "orphaned"].includes(operation.status)) {
          this.notifySemanticResult(operation);
        }
        this.refreshDashboardViews();
      })
      .catch((error: unknown) => {
        console.warn("[okf-workspace] could not watch semantic operation", error);
      });
  }

  public refreshDashboardViews(): void {
    this.apexHost?.refreshAllDashboards();
  }

  public async mountOkfDashboardSurface(
    container: HTMLElement,
    section: EmbeddedDashboardSection,
  ): Promise<() => void> {
    const leaf = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    if (!leaf) throw new Error("请先打开一个工作台，再打开此页面");
    const surface = new OkfDashboardView(leaf, this, {
      container,
      initialSection: section,
      embedded: true,
    });
    this.embeddedDashboardSurfaces.add(surface);
    try {
      await surface.onOpen();
    } catch (error) {
      this.embeddedDashboardSurfaces.delete(surface);
      await surface.onClose();
      throw error;
    }

    let disposed = false;
    return (): void => {
      if (disposed) return;
      disposed = true;
      this.embeddedDashboardSurfaces.delete(surface);
      void surface.onClose();
    };
  }

  private async initializeSemanticMonitor(): Promise<void> {
    try {
      const operations = await this.api().semanticOperations();
      this.semanticOperationsCache = operations;
      this.semanticMonitor.seed(operations);
      this.refreshDashboardViews();
    } catch (error) {
      console.warn("[okf-workspace] semantic monitor initialization failed", error);
    }
  }

  private async pollSemanticOperations(): Promise<void> {
    if (this.semanticPollInFlight) return;
    const active = this.semanticOperationsCache.some((operation) =>
      isSemanticOperationActive(operation.status),
    );
    if (!active && Date.now() - this.semanticLastIdlePoll < 30_000) return;
    this.semanticPollInFlight = true;
    try {
      const operations = await this.api().semanticOperations();
      const previousStages = new Map(
        this.semanticOperationsCache.map((operation) => [
          operation.operation_id,
          `${operation.status}|${operation.stage ?? ""}|${operation.stage_detail ?? ""}`,
        ]),
      );
      const visibleStageChanged = operations.some((operation) =>
        previousStages.get(operation.operation_id) !==
          `${operation.status}|${operation.stage ?? ""}|${operation.stage_detail ?? ""}`,
      );
      this.semanticOperationsCache = operations;
      if (!active) this.semanticLastIdlePoll = Date.now();
      const transitions = this.semanticMonitor.update(operations);
      if (transitions.length || visibleStageChanged) this.refreshDashboardViews();
      for (const { operation } of transitions) {
        if (["completed", "failed", "cancelled", "orphaned"].includes(operation.status)) {
          void this.notifySemanticResult(operation);
        }
      }
    } catch {
      // The API is intentionally absent while Obsidian/plugin ownership is stopping.
    } finally {
      this.semanticPollInFlight = false;
    }
  }

  private async notifySemanticResult(operation: SemanticOperationRecord): Promise<void> {
    const isWiki = operation.kind === "generate-wiki";
    const completed = operation.status === "completed";
    const interrupted = operation.status === "orphaned";
    const title = await this.vaultTitle(operation.target);
    const notice = new Notice("", 30_000);
    notice.noticeEl.empty();
    notice.noticeEl.createEl("strong", {
      text: completed
        ? semanticCompletionTitle(operation.kind, title)
        : interrupted
          ? "后台任务已中断"
          : `后台任务${operation.status === "failed" ? "失败" : "已取消"}`,
    });
    notice.noticeEl.createDiv({
      text: completed
        ? "点击下面的按钮直接打开结果。"
        : interrupted
          ? "可在对应内容页或系统状态中重新生成。"
          : (operation.error ?? "可以打开目标笔记查看状态。"),
    });
    const open = notice.noticeEl.createEl("button", {
      text: isWiki ? "打开知识笔记" : "打开学习材料",
    });
    open.addEventListener("click", () => {
      notice.hide();
      void this.openVaultPath(operation.target);
    });
  }

  private async initializeConversionMonitor(): Promise<void> {
    await this.pollConversionRecords(true);
  }

  private async pollConversionRecords(force = false): Promise<void> {
    if (this.conversionListPollInFlight) return;
    const activeStatuses = new Set<ConversionRecord["status"]>([
      "queued",
      "converting",
      "waiting-for-mineru",
    ]);
    const hasActiveCached = [...this.conversionRecords.values()]
      .some((record) => activeStatuses.has(record.status) || hasPendingGeneration(record));
    if (!force && !hasActiveCached && Date.now() - this.conversionLastIdlePoll < 30_000) return;
    this.conversionListPollInFlight = true;
    try {
      const conversions = await this.api().conversions();
      const previousRecords = new Map(this.conversionRecords);
      const previous = [...previousRecords.values()]
        .map(conversionVisibleFingerprint)
        .sort()
        .join("\n");
      this.conversionRecords.clear();
      for (const conversion of conversions) {
        this.conversionRecords.set(conversion.conversion_id, conversion);
        if (activeStatuses.has(conversion.status) || hasPendingGeneration(conversion)) {
          this.watchedConversionIds.add(conversion.conversion_id);
        } else if (
          ["imported", "failed"].includes(conversion.status) &&
          this.watchedConversionIds.delete(conversion.conversion_id)
        ) {
          if (conversion.status === "imported") this.notifyDocumentImport(conversion);
          else new Notice(`文档转换失败：${conversion.error ?? "请在系统状态查看详情"}`, 20_000);
        }
      }
      if (!conversions.some((record) => activeStatuses.has(record.status) || hasPendingGeneration(record))) {
        this.conversionLastIdlePoll = Date.now();
      }
      const current = conversions
        .map(conversionVisibleFingerprint)
        .sort()
        .join("\n");
      if (current !== previous) this.refreshDashboardViews();
    } catch {
      // The local service may still be crossing the plugin handoff window.
      if (!hasActiveCached && this.watchedConversionIds.size === 0) {
        this.conversionLastIdlePoll = Date.now();
      }
    } finally {
      this.conversionListPollInFlight = false;
    }
  }

  public watchDocumentConversion(conversionId: string): void {
    this.watchedConversionIds.add(conversionId);
    this.conversionLastIdlePoll = 0;
    void this.pollConversionRecords(true);
  }

  private notifyDocumentImport(record: import("../api/types.js").ConversionRecord): void {
    const target = convertedDocumentTarget(record.outputs);
    const operationId = record.outputs.semantic_operation_id;
    if (operationId) this.watchSemanticOperation(operationId);
    const notice = new Notice("", 30_000);
    notice.noticeEl.empty();
    notice.noticeEl.createEl("strong", { text: "文档转换完成" });
    notice.noticeEl.createDiv({ text: `${record.source_filename} · ${record.parser}` });
    if (target) {
      const open = notice.noticeEl.createEl("button", { text: "打开转换结果" });
      open.addEventListener("click", () => {
        notice.hide();
        void this.openVaultPath(target);
      });
    }
  }

  private registerDashboardRecentFiles(): void {
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (!(file instanceof TFile)) return;
      const state = this.dashboardUiStateStore?.recordFile(file.path);
      if (state) this.settings.dashboardUiState = state;
    }));
  }

  private registerCommands(): void {
    this.addCommand({
      id: DASHBOARD_COMMAND_ID,
      name: "打开工作台",
      callback: () => void this.openDashboard(),
    });
    this.addCommand({
      id: "open-system",
      name: "打开系统状态",
      callback: () => void this.navigateToOkfSection("system"),
    });
    this.addCommand({
      id: "open-today-daily",
      name: "打开/创建今日日记",
      callback: () => {
        void this.notes()
          .createDaily()
          .then((result) => this.openVaultPath(result.path));
      },
    });
    this.addCommand({
      id: "open-action-menu",
      name: "打开快捷操作菜单",
      callback: () => this.promptActionMenu(),
    });
    this.addCommand({
      id: "append-today-daily",
      name: "打开今日日记的随手记录",
      callback: () => this.promptDailyCapture(),
    });
    this.addCommand({
      id: "quick-capture",
      name: "快速记录",
      callback: () => this.promptCapture(),
    });
    this.addCommand({
      id: "new-reflection",
      name: "新建反思",
      callback: () => this.promptReflection(),
    });
    this.addCommand({
      id: "new-review",
      name: "打开/新建周期复盘",
      callback: () => this.promptReview(),
    });
    this.addCommand({
      id: "new-course",
      name: "新建课程",
      callback: () => this.promptCourse(),
    });
    this.addCommand({
      id: "new-lesson",
      name: "新建课堂笔记",
      callback: () => this.promptLesson(),
    });
    this.addCommand({
      id: "new-project",
      name: "新建项目",
      callback: () => this.promptProject(),
    });
    this.addCommand({
      id: "new-formal-decision",
      name: "记录项目决策",
      callback: () => this.promptNewDecision(),
    });
    this.addCommand({
      id: "ask-notes",
      name: "问我的笔记",
      callback: () => this.promptAsk(),
    });
    this.addCommand({
      id: "create-knowledge-from-sources",
      name: "在 Claudian 中生成知识笔记",
      callback: () => this.promptWikiFromSources(),
    });
    this.addCommand({
      id: "rewrite-current-section",
      name: "在 Claudian 中修改当前章节",
      callback: () => this.promptRewriteCurrentSection(),
    });
    this.addCommand({
      id: "import-document",
      name: "导入 PDF/Word/PowerPoint",
      callback: () => this.promptDocumentImport(),
    });
    this.addCommand({
      id: "rebuild-index",
      name: "重建检索索引",
      callback: () => {
        void this.api().rebuildIndex().then(() => new Notice("索引已重建"));
      },
    });
  }

  private registerApexCommands(): void {
    this.addCommand({
      id: "cycle-theme",
      name: "切换工作台主题",
      callback: () => void this.apexHost?.cycleTheme(),
    });
    this.addCommand({
      id: "next-workspace",
      name: "下一个工作台",
      callback: () => this.apexHost?.cycleWorkspace(1),
    });
    this.addCommand({
      id: "previous-workspace",
      name: "上一个工作台",
      callback: () => this.apexHost?.cycleWorkspace(-1),
    });
    this.addCommand({
      id: "toggle-note-popover",
      name: "切换笔记浮窗",
      callback: () => {
        if (!this.apexHost) return;
        this.apexHost.settings = {
          ...this.apexHost.settings,
          disableNotePopover: !this.apexHost.settings.disableNotePopover,
        };
        void this.apexHost.saveSettings();
      },
    });
    this.addCommand({
      id: "add-section",
      name: "添加工作台分区",
      callback: () => void this.apexHost?.addSection(),
    });
    this.addCommand({
      id: "toggle-banner-mode",
      name: "切换工作台横幅模式",
      callback: () => void this.apexHost?.toggleBannerMode(),
    });
  }

  public promptDocumentImport(
    relation: Pick<DocumentImportOptions, "course" | "project"> = {},
  ): void {
    this.openDocumentImport([], relation, relation.course ? "learning" : "command");
  }

  public openDocumentImport(
    files: ImportFile[] = [],
    relation: Pick<DocumentImportOptions, "course" | "project"> = {},
    origin: ImportOrigin = "command",
  ): void {
    const api = new HttpDocumentImportApi(this.settings.baseUrl, this.settings.token);
    let serviceReady: Promise<void> | undefined;
    new DocumentImportModal(
      this.app, files, relation, origin,
      async (file, options) => {
        serviceReady ??= this.ensureLocalServiceAvailable();
        await serviceReady;
        const result = await api.importDocument(file, options);
        this.watchDocumentConversion(result.conversion_id);
        if (result.semantic_operation) this.watchSemanticOperation(result.semantic_operation.operation_id);
        this.refreshDashboardViews();
        return result;
      },
    ).open();
  }

  private registerReadingViewControls(): void {
    this.registerMarkdownPostProcessor((element, context) => {
      const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!(file instanceof TFile)) return;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const feed = frontmatter?.feed;
      const items = feedItemMappings(frontmatter);
      if ((feed !== "ai-daily" && feed !== "treehole") || !items.length) return;
      const section = context.getSectionInfo(element)?.text ?? "";
      for (const mapping of items) {
        if (!section.includes("^" + mapping.block_id)) continue;
        const status = element.createDiv({
          cls: "okf-feed-recommendation",
          text: "这条内容是否值得进入你的知识系统，由你决定。",
        });
        const controls = element.createDiv({ cls: "okf-feed-decisions" });
        this.renderFeedDecisionFlow(controls, status, feed, mapping.id);
      }
    });
  }

  private renderFeedDecisionFlow(
    controls: HTMLElement,
    status: HTMLElement,
    feed: FeedKind,
    itemId: string,
  ): void {
    renderFeedDecisionFlow(controls, status, {
      load: () => this.loadFeedDecision(feed, itemId),
      decide: (action) => this.decideFeed(feed, itemId, action),
      openPath: (path) => this.openVaultPath(path),
      notify: (message) => { new Notice(message, 10_000); },
    });
  }

  private registerIndexSync(): void {
    const refreshDashboard = (): void => {
      if (this.dashboardRefreshTimer !== undefined) {
        window.clearTimeout(this.dashboardRefreshTimer);
      }
      this.dashboardRefreshTimer = window.setTimeout(() => {
        this.dashboardRefreshTimer = undefined;
        this.refreshDashboardViews();
      }, 700);
    };
    const schedule = (): void => {
      if (this.indexSyncTimer !== undefined) window.clearTimeout(this.indexSyncTimer);
      this.indexSyncTimer = window.setTimeout(() => {
        this.indexSyncTimer = undefined;
        void this.indexSync?.request().catch((error: unknown) => {
          console.warn("[okf-workspace] index sync failed", error);
        });
      }, 1_200);
    };
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (
          file instanceof TFile &&
          file.extension === "md" &&
          file.path !== "index.md"
        ) {
          schedule();
          refreshDashboard();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (
          file instanceof TFile &&
          file.extension === "md" &&
          file.path !== "index.md"
        ) {
          schedule();
          refreshDashboard();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (
          file instanceof TFile &&
          file.extension === "md" &&
          file.path !== "index.md"
        ) {
          schedule();
          refreshDashboard();
        }
      }),
    );
    this.registerEvent(this.app.vault.on("rename", () => {
      schedule();
      refreshDashboard();
    }));
  }

  private async decideFeed(
    feed: FeedKind,
    itemId: string,
    action: FeedDecisionAction,
  ): Promise<FeedDecisionResult> {
    await this.ensureLocalServiceAvailable();
    const api = new HttpFeedApi(this.settings.baseUrl, this.settings.token);
    let result: FeedDecisionResult;
    try {
      result = await api.decide(feed, itemId, action);
    } catch (error) {
      if (!(error instanceof FeedTransportError)) throw error;
      await this.ensureLocalServiceAvailable();
      const recovered = await api.getDecision(feed, itemId);
      const needsSemanticOperation = ["learn-now", "wiki-now"].includes(action);
      result =
        recovered?.action === action &&
        (!needsSemanticOperation || recovered.semantic_operation !== undefined)
          ? recovered
          : await api.decide(feed, itemId, action);
    }
    if (result.semantic_operation) {
      this.watchSemanticOperation(result.semantic_operation.operation_id);
    }
    this.feedDecisionCache.set(this.feedDecisionKey(feed, itemId), result);
    this.invalidateFeedProjections();
    this.refreshDashboardViews();
    return result;
  }

  private invalidateFeedProjections(): void {
    this.feedDigestCache = undefined;
    this.feedDigestRequest = undefined;
    this.feedProjectionRevision += 1;
  }

  public loadFeedDecision(
    feed: FeedKind,
    itemId: string,
  ): Promise<FeedDecisionResult | undefined> {
    const key = this.feedDecisionKey(feed, itemId);
    if (this.feedDecisionCache.has(key)) {
      return Promise.resolve(this.feedDecisionCache.get(key));
    }
    const pending = this.feedDecisionRequests.get(key);
    if (pending) return pending;
    const request = new HttpFeedApi(this.settings.baseUrl, this.settings.token)
      .getDecision(feed, itemId)
      .then((result) => {
        this.feedDecisionCache.set(key, result);
        return result;
      })
      .finally(() => this.feedDecisionRequests.delete(key));
    this.feedDecisionRequests.set(key, request);
    return request;
  }

  public semanticOperationsSnapshot(): readonly SemanticOperationRecord[] {
    return [...this.semanticOperationsCache].sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at),
    );
  }

  public conversionSnapshot(): readonly import("../api/types.js").ConversionRecord[] {
    return [...this.conversionRecords.values()].sort((left, right) =>
      (right.updated_at ?? "").localeCompare(left.updated_at ?? ""),
    );
  }

  private rememberSemanticOperation(operation: SemanticOperationRecord): void {
    this.semanticOperationsCache = [
      operation,
      ...this.semanticOperationsCache.filter(
        (candidate) => candidate.operation_id !== operation.operation_id,
      ),
    ];
  }

  private feedDecisionKey(feed: FeedKind, itemId: string): string {
    return `${feed}:${itemId}`;
  }

  private async vaultTitle(path: string): Promise<string> {
    const normalized = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (file instanceof TFile) {
      const title = this.app.metadataCache.getFileCache(file)?.frontmatter?.title;
      if (typeof title === "string" && title.trim()) return title.trim();
      const markdown = await this.app.vault.cachedRead(file);
      const heading = /^#\s+(.+)$/mu.exec(markdown)?.[1]?.trim();
      if (heading) return heading;
      return file.basename;
    }
    return normalized.split("/").at(-1)?.replace(/\.md$/iu, "") || normalized;
  }

  public async openVaultPath(path: string, blockId?: string): Promise<void> {
    const normalized = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const file = this.app.vault.getAbstractFileByPath(normalized);
      if (file instanceof TFile) {
        if (blockId) {
          await this.app.workspace.openLinkText(`${normalized}#^${blockId}`, "", false);
        } else {
          await this.app.workspace.getLeaf(false).openFile(file);
        }
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    new Notice("文件已创建，但 Obsidian 尚未显示；可在文件区打开：" + normalized, 10_000);
  }

  private async openVaultHeading(path: string, heading: string): Promise<void> {
    const normalized = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const file = this.app.vault.getAbstractFileByPath(normalized);
      if (file instanceof TFile) {
        await this.app.workspace.openLinkText(`${normalized}#${heading}`, "", false);
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    new Notice("今日日记已创建，但 Obsidian 尚未显示：" + normalized, 10_000);
  }

  public async ensureLocalServiceAvailable(): Promise<void> {
    if (!this.localService) throw new Error("工作区本地服务尚未初始化");
    await this.localService.ensureStarted();
  }

  private async loadSettings(): Promise<void> {
    const raw = await this.loadData();
    const loaded = raw && typeof raw === "object"
      ? raw as Record<string, unknown> & Partial<OkfBrainSettings>
      : {};
    this.persistedSettings = { ...loaded };
    delete this.persistedSettings.token;
    let apexSettings = loaded.apex;
    let importedLegacyApexSettings = false;
    if (!apexSettings || typeof apexSettings !== "object") {
      try {
        const legacy = await readLegacyApexSettings(this.app);
        if (legacy && typeof legacy === "object") {
          apexSettings = legacy as OkfBrainSettings["apex"];
          importedLegacyApexSettings = true;
        }
      } catch (error) {
        console.warn("[okf-workspace] could not read legacy Apex settings", error);
      }
    }
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      dashboardUiState: normalizeDashboardUiState(
        loaded?.dashboardUiState,
        loaded?.feedReadingPositions,
      ),
      feedReadingPositions: { ...DEFAULT_SETTINGS.feedReadingPositions, ...loaded?.feedReadingPositions },
      apex: normalizeApexSettings(apexSettings),
    };
    await this.reloadLocalToken();
    if (importedLegacyApexSettings) await this.saveSettings();
  }
}

function conversionVisibleFingerprint(record: ConversionRecord): string {
  return JSON.stringify({
    id: record.conversion_id,
    status: record.status,
    parser: record.parser,
    stages: record.stages,
    error: record.error,
    warnings: record.warnings,
    target: record.outputs.routed_target ?? record.outputs.source_text ?? record.outputs.source,
  });
}

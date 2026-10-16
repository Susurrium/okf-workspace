import { saveSyncedDocument } from "../imports/synced-intake.js";
import { originalsForNote } from "../imports/original-references.js";
import { ensureDocumentSyncCapacity } from "../imports/sync-capacity.js";
import { noteStatusLabel } from "../ui/display-labels.js";
import { FileSystemAdapter, Notice, Platform, Plugin, TFile, TFolder, type WorkspaceLeaf } from "obsidian";

import { LocalApi } from "../api/client.js";
import { assertMatchingVault, currentVaultFingerprint } from "../api/vault-identity.js";
import {
  relationVaultPath,
  normalizeCaptureRelation,
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
import { normalizedDigestPath, openPreparedDigest, vaultFingerprint } from "../feeds/open-digest.js";
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
import { importFilesFromDrop, type ImportFile } from "../imports/drop.js";
import type {
  DocumentImportOptions,
} from "../imports/types.js";
import { methodLabels } from "../imports/types.js";
import { renderFeedDecisionFlow } from "../ui/feed-decision-flow.js";
import { DashboardSettingTab } from "../../apex/src/settings.js";
import { DashboardView, DASHBOARD_VIEW_TYPE, DASHBOARD_SECTION_VIEW_TYPE } from "../../apex/src/view.js";
import { collectVaultTasks, scanFileTasks, updateTaskDatesInFile, replaceTaskInFile, toggleTaskInFile, invalidateAllTasks, invalidatePath, isTaskSourcePath, type VaultTask } from "../../apex/src/alltasks-scan.js";
import { TaskReminderService, type ReminderStore } from '../tasks/reminders.js';
import type { SavedTaskView } from "../tasks/task-catalog.js";
import { TaskViewsModal } from "../tasks/task-views-modal.js";
import { TaskTargetModal } from "../tasks/task-target-modal.js";
import { readTaskBoundaryReport, TaskBoundaryReportModal } from '../tasks/task-boundary-report.js';
import { moveTaskToNote, copyTaskSubtree } from '../../apex/src/task-operations.js';
import { createTaskNote } from '../../apex/src/calendar-task-note.js';
import { configureTasks, taskStatusTypes, setTaskSourceFilter, prepareTaskLine, getSettings as getTaskSettings } from "../../tasks-generated/core.js";
import { taskSourceKind } from '../../apex/src/task-source.js';
import type { TasksRuntime } from "../../tasks-generated/plugin.js";
import { registerSectionDefinition } from "../../apex/src/section-registry.js";
import { ApexHostAdapter } from "../adapters/apex-host.js";
import { ArtifactEditPolicy } from "../application/artifact-edit-policy.js";
import { ProjectCategoryModal } from "./project-category-modal.js";
import { projectCategory } from "../domain/project-organization.js";
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
  type SurfaceMountContext,
} from "../features/workbench/okf-surface-sections.js";
import { workbenchInstanceKey } from "../features/workbench/section-config.js";
import { parse as parseWorkbench } from "../../apex/src/parser.js";
import { chooseWorkspaceContext } from "./workspace-context-modal.js";
import {
  DASHBOARD_COMMAND_ID,
  registerDashboardRibbon,
} from "./dashboard-ribbon.js";
import { IndexSyncCoordinator } from "./index-sync.js";
import { feedLivePreviewExtension } from "./live-preview.js";
import type { LocalServiceManager } from "./local-service.js";
import { OriginalFiles } from "./original-files.js";
import { SyncedImportsModal } from "./synced-imports-modal.js";
import { ChoiceModal, FieldsPromptModal, ProjectLogModal, TextPromptModal } from "./prompts.js";
import { QuickCaptureModal } from "./quick-capture-modal.js";
import { CaptureSession, type PreparedCapture } from './capture-session.js';
import { assertCaptureDraftPersisted } from './capture-persistence.js';
import { mountQuickCapture } from './quick-capture-inline.js';
import { DocumentConversionResultModal, DocumentImportModal, DocumentReconversionModal, type ImportOrigin,
  type DocumentImportDraft } from "./document-import-modal.js";
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
import { recoverWorkspaceRegistry } from "./workspace-recovery.js";
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
  public get isMobile(): boolean { return Platform.isMobile; }
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
  private readonly captureSessions = new Map<string, CaptureSession>();
  private readonly captureEditors = new Map<string, QuickCaptureModal>();
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
  private readonly importDrafts = new Map<string, DocumentImportDraft>();
  private readonly importDraftVersions = new Map<string, number>();
  public originalFiles: OriginalFiles | undefined;
  private taskRuntime: TasksRuntime | undefined;
  private taskReminders: TaskReminderService | undefined;
  private readonly workbenchPages = new Map<string, WorkspaceLeaf>();
  private readonly pageIds = new WeakMap<WorkspaceLeaf, string>();
  private focusedNavigationQueue: Promise<void> = Promise.resolve();

  public async onload(): Promise<void> {
    await this.loadSettings();
    await this.initializeTasks();
    this.originalFiles = new OriginalFiles(this.app);
    this.app.workspace.onLayoutReady(() => {
      void ensureDocumentSyncCapacity(this.app).catch((error: unknown) =>
        new Notice(error instanceof Error ? error.message : "请检查 LiveSync 附件同步上限"));
      void this.originalFiles?.recover();
    });
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (this.originalFiles?.recoveryIssues.length && /^(sources\/originals|system\/imports)\//u.test(file.path)) {
        void this.originalFiles.recover().then(() => this.refreshDashboardViews());
      }
    }));
    this.registerOriginalAccess();
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
      chooseWorkspaceContext: (presetId) => chooseWorkspaceContext(this.app, presetId),
      openTodayNote: async () => { const daily = await this.notes().createDaily(); await this.openVaultPath(daily.path); },
      executeQuickAction: async (action) => {
        if (action.type !== "command" || action.target !== "daily-notes") return false;
        const daily = await this.notes().createDaily();
        await this.openVaultPath(daily.path);
        return true;
      },
      saveTasksToDaily: (block) => this.notes().appendDailyTaskBlock(block),
      editTask: task => this.promptTaskDetails(task),
      handlesTaskReminders: false,
      checklistsInWorkbenchOnly: true,
      prepareTaskLine: line => this.prepareFormalTaskLine(line),
      calendarDefaultDate: 'scheduled',
      editTaskDates: task => this.promptTaskDates(task),
      createTask: date => this.promptNewTask({ date, calendar: true }),
      openTaskSource: task => this.openTaskSource(task),
      canWriteTaskTarget: file => this.taskTargetAllowed(file),
      taskStatistics: async excludeFolders => {
        const tasks = (await collectVaultTasks(this.app, excludeFolders)).filter(task => task.formal && task.statusType !== 'CANCELLED');
        const doneTasks = tasks.filter(task => task.statusType === 'DONE').length;
        return { totalTasks: tasks.length, doneTasks, pendingTasks: tasks.filter(task => !task.checked).length,
          taskCompletion: tasks.length ? Math.round(doneTasks / tasks.length * 100) : 0 };
      },
      recentDocumentExclusions: ["system/", "inbox/uploads/"],
      quickCapture: {
        enabled: () => this.apexHost?.settings.widgetQuickCaptureEnabled !== false,
        mount: container => mountQuickCapture(container, this.captureSession(), () => this.openQuickCapture({})),
        submit: async text => { const session = this.captureSession(); session.setText(text); await session.submit(); },
      },
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
    this.registerView(DASHBOARD_SECTION_VIEW_TYPE, (leaf) => new DashboardView(leaf, this.apexHost!, true));
    this.registerView(OKF_DASHBOARD_VIEW, (leaf) => new OkfDashboardItemView(leaf, this));
    registerDashboardRibbon(this, () => void this.openDashboard());
    this.dashboardUiStateStore = new DashboardUiStateStore(
      this.settings.dashboardUiState,
      async (state) => {
        this.settings.dashboardUiState = state;
        await this.saveSettings();
      },
      400,
      (error) => {
        console.error("[okf-workspace] could not save Dashboard UI state", error);
        for (const session of this.captureSessions.values()) session.reportDraftError(error);
      },
    );
    this.registerDashboardRecentFiles();
    if (!this.isMobile) {
      this.claudianBridge = new ClaudianBridgeAdapter(this.app);
      const { LocalServiceManager } = await import("./local-service.js");
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
    }
    this.addSettingTab(new DashboardSettingTab(this.app, this.apexHost, this, {
      heading: "连接与导入",
      getSettingDefinitions: () => [...okfServiceSettingDefinitions(this), ...(this.taskRuntime?.settingsDefinitions() ?? [])],
      renderFallback: (container) => {
        renderOkfServiceSettings(container, this);
        this.taskRuntime?.displaySettings(container.createDiv());
      },
    }));
    this.registerCommands();
    this.registerApexCommands();
    if (!this.isMobile) this.registerReadingViewControls();
    this.registerIndexSync();
    if (!this.isMobile) {
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
  }

  public onunload(): void {
    for (const editor of this.captureEditors.values()) editor.close();
    this.captureEditors.clear();
    if (this.indexSyncTimer !== undefined) window.clearTimeout(this.indexSyncTimer);
    if (this.dashboardRefreshTimer !== undefined) window.clearTimeout(this.dashboardRefreshTimer);
    this.watchedConversionIds.clear();
    this.app.workspace.detachLeavesOfType(DASHBOARD_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(DASHBOARD_SECTION_VIEW_TYPE);
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
      dashboardUiState,
      feedReadingPositions,
      apex: this.settings.apex,
      tasks: this.settings.tasks,
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
    instanceKey?: string,
  ): DashboardUiState {
    if (instanceKey) return this.updateDashboardUiState({ instances: { [instanceKey]: patch } });
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
    if (this.isMobile) { this.settings.token = ""; return; }
    try {
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
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
    const key = JSON.stringify(normalizeCaptureRelation(initial));
    const existing = this.captureEditors.get(key);
    if (existing) { existing.contentEl.querySelector('textarea')?.focus(); return; }
    const contexts = await this.notes().captureContexts();
    if (this.captureEditors.has(key)) { this.captureEditors.get(key)!.contentEl.querySelector('textarea')?.focus(); return; }
    const session = this.captureSession(initial);
    const state = session.snapshot();
    const editor = new QuickCaptureModal(this.app, contexts, initial, () => session.submit(), {
      text: state.text, relation: state.relation,
      save: text => session.setText(text), saveRelation: relation => session.setRelation(relation),
    }, session);
    const close = editor.onClose.bind(editor);
    editor.onClose = () => { close(); this.captureEditors.delete(key); };
    this.captureEditors.set(key, editor);
    editor.open();
  }

  private captureSession(initial: CaptureRelation = {}): CaptureSession {
    const draftKey = `captureDraft:${JSON.stringify(normalizeCaptureRelation(initial))}`;
    const existing = this.captureSessions.get(draftKey);
    if (existing) return existing;
    const relationKey = `${draftKey}:relation`;
    const filters = this.getDashboardUiState().pages.inbox.filters;
    const relation = filters[relationKey];
    const storedRequest = filters[`${draftKey}:prepared`];
    const prepared = typeof storedRequest === 'string' ? JSON.parse(storedRequest) as PreparedCapture : undefined;
    if (prepared && (typeof prepared.path !== 'string' || typeof prepared.markdown !== 'string' || !prepared.relation || typeof prepared.relation !== 'object')) throw new Error('快速记录重试信息损坏，请保留草稿并检查配置');
    const session = new CaptureSession({
      initialRelation: initial,
      text: String(filters[draftKey] ?? ''), relation: typeof relation === 'string' ? normalizeCaptureRelation(JSON.parse(relation)) : initial, prepared,
      persist: (text, nextRelation, request) => {
        this.updateDashboardPageUiState('inbox', { filters: {
          [draftKey]: text || null,
          [relationKey]: nextRelation.course || nextRelation.project ? JSON.stringify(nextRelation) : null,
          [`${draftKey}:prepared`]: request ? JSON.stringify(request) : null,
        } });
      },
      flush: async () => {
        if (this.dashboardUiStateStore) await this.dashboardUiStateStore.flush();
        else await this.saveSettings();
        // Obsidian 的设置写入可能吞掉磁盘异常；关键草稿必须回读确认。
        const directory = this.manifest.dir;
        if (!directory) throw new Error('快速记录缺少插件设置目录');
        const stored = JSON.parse(await this.app.vault.adapter.read(`${directory}/data.json`));
        assertCaptureDraftPersisted(stored, this.getDashboardUiState().pages.inbox.filters, draftKey);
      },
      prepare: (text, nextRelation) => this.notes().prepareCapture(text.split(/\r?\n/u)[0]!.trim(), text, nextRelation),
      write: request => this.notes().writePreparedCapture(request),
      refresh: async () => {
        for (const type of [DASHBOARD_VIEW_TYPE, DASHBOARD_SECTION_VIEW_TYPE]) {
          for (const leaf of this.app.workspace.getLeavesOfType(type)) {
            if (leaf.view instanceof DashboardView) await leaf.view.refresh();
          }
        }
        for (const leaf of this.app.workspace.getLeavesOfType(OKF_DASHBOARD_VIEW)) {
          if (leaf.view instanceof OkfDashboardItemView) await leaf.view.refresh();
        }
      },
      saved: path => {
        const notice = new Notice('已保存到收集箱', 10000);
        notice.noticeEl.createEl('button', { text: '打开记录' }).addEventListener('click', () => { notice.hide(); void this.openVaultPath(path); });
      },
    });
    this.captureSessions.set(draftKey, session);
    return session;
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
        { value: "search", label: "搜索笔记", description: "打开全局搜索" },
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
        { value: "uploads", label: "已保存的资料", description: "打开原件、转换正文或查看处理结果" },
        { value: "new-task", label: "新建任务", description: "安排一个行动，可关联课程或项目" },
        { value: "tasks", label: "打开任务", description: "查看未完成任务，切换日期视图或完成与取消历史" },
        ...(["inbox", "reading", "sources", "learning", "projects", "knowledge", "life", "system"] as const)
          .map((section) => ({ value: `view:${section}` as const, label: `打开${okfSectionDefaultName(section)}`, description: "浏览完整功能，可添加到工作台" })),
        ...(!this.isMobile ? [{ value: "ask", label: "问我的笔记", description: "在 Claudian 中读取相关笔记后回答" } as const] : []),
      ] as const,
      "快捷操作",
      async (choice) => {
        if (choice === "search") {
          const commands = (this.app as typeof this.app & { commands?: { executeCommandById(id: string): boolean } }).commands;
          if (!commands?.executeCommandById("global-search:open")) throw new Error("全局搜索不可用");
        } else if (choice === "new-task") this.promptNewTask();
        else if (choice === "tasks") {
          await this.navigateToOkfSection("tasks", undefined, undefined, { taskView: "all" });
        } else if (choice.startsWith("view:")) {
          await this.navigateToOkfSection(choice.slice(5) as EmbeddedDashboardSection);
        } else if (choice === "daily") {
          const result = await this.createDaily();
          await this.openVaultPath(result.path);
        } else if (choice === "jot") this.promptDailyCapture();
        else if (choice === "capture") this.promptCapture();
        else if (choice === "class") this.promptLesson();
        else if (choice === "course") this.promptCourse();
        else if (choice === "project") this.promptProject();
        else if (choice === "import") this.promptDocumentImport();
        else if (choice === "uploads") this.openDocumentSubmissions();
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
      const opened = firstContext ? await this.tryOpenVaultPath(firstContext) : undefined;
      if (firstContext && opened !== "opened") this.noticeVaultOpenFailure(opened!, firstContext);
      new Notice(
        copied
          ? `Claudian 未启用；提示词和上下文路径已复制${opened === "opened" ? "，并已打开首个上下文文件" : ""}。`
          : `Claudian 未启用${opened === "opened" ? "；已打开首个上下文文件" : ""}。请启用 Claudian 插件后重试 AI 操作。`,
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
        const opened = await this.tryOpenVaultPath(result.path);
        if (opened === "opened") {
          new Notice(result.created ? "已创建并打开本期复盘" : "已打开已有复盘", 6_000);
        } else {
          this.noticeVaultOpenFailure(opened, result.path);
        }
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
    void this.openProjectPrompt(onCreated).catch(error => new Notice(error instanceof Error ? error.message : String(error)));
  }

  private async openProjectPrompt(onCreated?: (slug: string) => void): Promise<void> {
    const { projects } = await new VaultDashboardReader(this.app).projects();
    const categories = [...new Set(projects.map(project => projectCategory(project.project_category)).filter((value): value is string => value !== null))].sort();
    new FieldsPromptModal(
      this.app,
      "新建项目",
      [
        { key: "title", label: "项目名称", placeholder: "个人知识库" },
        { key: "slug", label: "目录名（可留空）", placeholder: "workspace", required: false },
        { key: "category", label: "项目类别（可留空）", placeholder: "选择已有类别或输入新名称", required: false, suggestions: categories },
      ],
      "创建项目",
      async (values) => {
        const result = await this.notes().createProject(
          values.title ?? "项目",
          values.slug || undefined,
          values.category || undefined,
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
    if (!this.taskRuntime) { new Notice('任务功能尚未启用，请先完成 Tasks 接管'); return; }
    const dates = (item: VaultTask): Record<string, string> => ({ reminder: item.reminder ?? '',
      scheduled: [item.scheduled, item.scheduledTime].filter(Boolean).join(' '), due: [item.due, item.dueTime].filter(Boolean).join(' '),
      start: [item.start, item.startTime].filter(Boolean).join(' '), end: [item.end, item.endTime].filter(Boolean).join(' ') });
    const initial = dates(task);
    this.taskRuntime.editDates(task.text, initial, async values => {
      const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== initial[key]));
      if (!Object.keys(changed).length) return;
      const records = scanFileTasks(task.file, await this.app.vault.read(task.file));
      const matches = records.filter(item => task.blockId ? item.blockId === task.blockId : item.originalLine === task.originalLine);
      if (matches.length !== 1) throw new Error('无法唯一定位任务，请保留输入并检查来源');
      const current = matches[0]!;
      const currentDates = dates(current);
      if (Object.keys(changed).some(key => currentDates[key] !== initial[key])) throw new Error('这些日期在编辑期间已被修改，请检查来源后再保存');
      if (!await updateTaskDatesInFile(this.app, current, changed)) throw new Error('任务已经变化，请重试');
      new Notice('任务日期已更新');
      this.refreshDashboardViews();
    });
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

  public promptNewWikiMap(): void {
    new TextPromptModal(this.app, "新建知识导航", "导航主题与组织要求", "在 Claudian 中准备", async value => {
      await this.openCodexPrompt(`请根据相关真实知识笔记创建或维护知识导航。主题与要求：${value}`,
        { actionMode: "write", skill: "maintain-wiki-map" });
    }).open();
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
    initialContext?: { course?: string; project?: string },
  ): void {
    if (intent === "source") {
      this.promptPendingSourceContext(path, intent, false, initialContext);
      return;
    }
    new ChoiceModal(
      this.app,
      [
        {
          value: "generate",
          label: intent === "wiki" ? "立即生成知识笔记" : "立即生成辅助学习材料",
          description: "保存资料后在后台生成",
        },
        {
          value: "later",
          label: intent === "wiki" ? "保存用途，稍后生成" : "加入待学习列表",
          description: intent === "wiki" ? "之后从知识待生成列表继续" : "之后可在学习页面主动生成",
        },
      ] as const,
      intent === "wiki" ? "是否现在生成知识笔记？" : "是否现在生成辅助学习材料？",
      async (choice) => this.promptPendingSourceContext(path, intent, choice === "generate", initialContext),
    ).open();
  }

  private promptPendingSourceContext(
    path: string,
    intent: "learn" | "wiki" | "source",
    generate: boolean,
    initialContext?: { course?: string; project?: string },
  ): void {
    if (initialContext !== undefined) {
      void this.routePendingSource(path, { intent, generate, ...initialContext });
      return;
    }
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
        { value: "both", label: "关联课程和项目", description: "分别选择课程和项目，同一用途保留两个关系" },
      ] as const,
      title,
      async (context) => {
        if (context === "both") {
          this.selectCourse("选择课程", course => this.selectProject("选择项目", project => {
            void onSelect({ course, project });
          }));
        } else if (context === "course") {
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
      const target = result.semantic_operation?.status === "completed"
        ? result.routed_target ?? result.source_text ?? result.source
        : result.source_text ?? result.source;
      const notice = new Notice("", 20_000);
      notice.noticeEl.empty();
      notice.noticeEl.createEl("strong", {
        text: result.semantic_operation ? "已归类并进入后台生成" : "资料已归类",
      });
      const open = notice.noticeEl.createEl("button", {
        text: target === result.routed_target ? "打开生成结果" : "打开已保存资料",
      });
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
    this.app.workspace.setActiveLeaf(target.leaf, { focus: true });
  }

  public async hasOkfSectionInActiveWorkbench(section: EmbeddedDashboardSection, workbenchPath?: string): Promise<boolean> {
    const target = this.activeApexView(undefined, workbenchPath);
    const types = section === "tasks" ? [OKF_SECTION_TYPES.tasks, "alltasks"] : [OKF_SECTION_TYPES[section]];
    if (target && (!workbenchPath || target.view.currentWorkspacePath() === workbenchPath)) return types.some(type => target.view.hasSectionType(type));
    const path = (workbenchPath ?? this.settings.apex.dashboardFile).replace(/\.md$/iu, "");
    const file = this.app.vault.getAbstractFileByPath(`${path}.md`);
    if (!(file instanceof TFile)) return false;
    return parseWorkbench(await this.app.vault.read(file)).columns.some(column => types.includes(column.sectionType ?? ""));
  }

  public async navigateToOkfSection(section: EmbeddedDashboardSection, origin?: HTMLElement, workbenchPath?: string,
    config?: Record<string, unknown>, stateKey?: string): Promise<void> {
    const request = this.focusedNavigationQueue.then(() => this.navigateFocusedPage(section, origin, workbenchPath, config, stateKey));
    this.focusedNavigationQueue = request.catch(() => undefined);
    return request;
  }

  private async navigateFocusedPage(section: EmbeddedDashboardSection, origin?: HTMLElement, workbenchPath?: string,
    config?: Record<string, unknown>, stateKey?: string): Promise<void> {
    const target = this.activeApexView(origin, workbenchPath);
    this.updateDashboardUiState({ activeSection: section });
    const pages = this.app.workspace.getLeavesOfType(OKF_DASHBOARD_VIEW);
    const existing = origin ? pages.find(page => page.view.containerEl.contains(origin))
      : pages.find(page => page === this.app.workspace.activeLeaf);
    const boardPath = target?.view.currentWorkspacePath() ?? workbenchPath;
    const linked = origin && !existing && boardPath ? this.workbenchPages.get(boardPath) : undefined;
    const leaf = existing ?? (linked && pages.includes(linked) ? linked : this.app.workspace.getLeaf("tab"));
    if (existing?.view instanceof OkfDashboardItemView) existing.view.rememberNavigation();
    else if (leaf.view instanceof OkfDashboardItemView) leaf.view.navigationHistory.length = 0;
    if (origin && boardPath) this.workbenchPages.set(boardPath, leaf);
    let pageId = this.pageIds.get(leaf);
    if (!pageId) { pageId = crypto.randomUUID(); this.pageIds.set(leaf, pageId); }
    const scope = [config?.course, config?.project, config?.statuses, config?.feedStreams, config?.folders,
      config?.excludeFolders, config?.notePaths, config?.readingView, config?.readingSourceId,
      config?.catalogueKey, config?.taskView, config?.savedViewId];
    const instance = stateKey ?? workbenchInstanceKey(boardPath ?? "", `page:${pageId}:${section}:${JSON.stringify(scope)}`);
    if (section === 'tasks' && config?.resetTaskQuery) this.updateDashboardPageUiState('tasks', { filters: { taskAdvancedQuery: null, taskQueryDraft: null } }, instance);
    const storedConfig = config ? { ...config } : undefined;
    if (storedConfig) {
      delete storedConfig.resetTaskQuery;
      delete storedConfig.mode;
      delete storedConfig.limit;
      delete storedConfig.pageSize;
    }
    if (config?.viewState && typeof config.viewState === "object") this.updateDashboardPageUiState(section, config.viewState as DashboardPageUiStatePatch, instance);
    await leaf.setViewState({
      type: OKF_DASHBOARD_VIEW,
      state: { section, workbenchPath: boardPath,
        ...(storedConfig ? { config: storedConfig } : {}), stateKey: instance },
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private dashboardPage(origin?: HTMLElement): WorkspaceLeaf | undefined {
    return this.app.workspace.getLeavesOfType(OKF_DASHBOARD_VIEW).find(leaf => origin
      ? leaf.view.containerEl.contains(origin) : leaf === this.app.workspace.activeLeaf);
  }

  public canReturnToPreviousDashboardPage(origin?: HTMLElement): boolean {
    const view = this.dashboardPage(origin)?.view;
    return view instanceof OkfDashboardItemView && view.navigationHistory.length > 0;
  }

  public async returnToPreviousDashboardPage(workbenchPath?: string, origin?: HTMLElement): Promise<void> {
    const leaf = this.dashboardPage(origin);
    const request = this.focusedNavigationQueue.then(() => this.restorePreviousDashboardPage(workbenchPath, leaf));
    this.focusedNavigationQueue = request.catch(() => undefined);
    return request;
  }

  private async restorePreviousDashboardPage(workbenchPath?: string, leaf?: WorkspaceLeaf): Promise<void> {
    const previous = leaf?.view instanceof OkfDashboardItemView ? leaf.view.navigationHistory.pop() : undefined;
    if (!previous || !leaf) { await this.returnToOkfWorkbench(workbenchPath); return; }
    await leaf.setViewState({ type: OKF_DASHBOARD_VIEW, state: previous, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  public async addOkfSectionToActiveWorkbench(section: EmbeddedDashboardSection, workbenchPath?: string, config?: Record<string, unknown>): Promise<void> {
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
    const initial = { ...config };
    const viewState = initial.viewState as { filters?: Record<string, unknown>; tab?: string } | undefined;
    if (viewState) {
      const filters = Object.fromEntries(Object.entries(viewState.filters ?? {}).filter(([key]) => !key.startsWith("loaded:") && !key.startsWith("details:") && key !== "taskQueryDraft"));
      initial.initialView = { tab: viewState.tab, filters };
    }
    for (const key of ["mode", "limit", "pageSize", "viewState", "taskQueryDraft"]) delete initial[key];
    await target.view.addSectionType(OKF_SECTION_TYPES[section], okfSectionDefaultName(section), initial);
    await this.app.workspace.revealLeaf(target.leaf);
  }

  public async openFeedDigest(feed: FeedKind, digestId: string): Promise<void> {
    await this.openFeedEdition(feed, digestId);
  }

  private async openFeedEdition(
    feed: FeedKind,
    digestId: string,
    blockId?: string,
  ): Promise<void> {
    await this.ensureLocalServiceAvailable();
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("当前 Vault 不支持验证本地服务的 Vault 路径");
    }
    const api = this.feedApi();
    const expectedFingerprint = vaultFingerprint(adapter.getBasePath());
    const identity = await api.vaultIdentity();
    assertMatchingVault(identity.vault_fingerprint, expectedFingerprint);
    const prepared = await api.prepareDigest(feed, digestId);
    await openPreparedDigest(prepared, expectedFingerprint, {
      getFile: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? file : undefined;
      },
      hasFolder: (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFolder,
      stat: async (path) => (await adapter.stat(path))?.type,
      createFolder: (path) => this.app.vault.createFolder(path).then(() => undefined),
      create: (path, markdown) => this.app.vault.create(path, markdown),
      refreshExisting: async () => {
        const opened = await api.openDigest(feed, digestId);
        if (normalizedDigestPath(opened.vault_path) !== normalizedDigestPath(prepared.vault_path)) {
          throw new Error("本期汇总路径在创建期间发生变化，请重试");
        }
      },
      open: async (file, targetBlockId) => {
        if (targetBlockId) {
          await this.app.workspace.openLinkText(`${file.path}#^${targetBlockId}`, "", false);
        } else {
          await this.app.workspace.getLeaf(false).openFile(file);
        }
      },
      waitForFile: (path) => this.waitForVaultFile(path),
      describePath: (path) => adapter.getFullPath(path),
    }, blockId).catch(async (error: unknown) => {
      const diskType = await adapter.stat(prepared.vault_path)
        .then((stat) => stat?.type)
        .catch(() => undefined);
      console.warn("[okf-workspace] Feed Digest could not be opened", {
        feed,
        digestId,
        path: prepared.vault_path,
        diskType,
        indexed: this.app.vault.getAbstractFileByPath(prepared.vault_path) instanceof TFile,
        error,
      });
      throw error;
    });
  }

  public async loadFeedDashboardDigest(): Promise<FeedDashboardDigest> {
    if (this.feedDigestCache && Date.now() - this.feedDigestCache.loadedAt < 120_000) {
      return this.feedDigestCache.value;
    }
    if (this.feedDigestRequest) return this.feedDigestRequest;
    const api = this.feedApi();
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
    const api = this.feedApi();
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
    const api = this.feedApi();
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
    const api = this.feedApi();
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
    const api = this.feedApi();
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
    await this.openFeedEdition(feed, digestId, blockId);
  }

  public api(): LocalApi {
    if (this.isMobile) throw new Error("这个处理操作请在电脑上执行；资料可先保存并同步提交");
    return new LocalApi(this.settings.baseUrl, this.settings.token, currentVaultFingerprint(this.app));
  }

  private feedApi(): HttpFeedApi {
    return new HttpFeedApi(this.settings.baseUrl, this.settings.token, currentVaultFingerprint(this.app));
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

  public async setProjectCategory(path: string, category: string | null, expected?: string | null): Promise<void> {
    await this.notes().setProjectCategory(path, category, expected);
    this.refreshDashboardViews();
  }

  public async promptProjectCategory(path?: string): Promise<void> {
    const { projects } = await new VaultDashboardReader(this.app).projects();
    new ProjectCategoryModal(this.app, projects, () => this.refreshDashboardViews(), path).open();
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
    for (const leaf of this.app.workspace.getLeavesOfType(OKF_DASHBOARD_VIEW)) {
      if (leaf.view instanceof OkfDashboardItemView) void leaf.view.refresh();
    }
  }

  public async mountOkfDashboardSurface(
    container: HTMLElement,
    section: EmbeddedDashboardSection,
    context?: SurfaceMountContext,
  ): Promise<() => void> {
    const target = this.activeApexView(container);
    const leaf = target?.leaf;
    if (!leaf) throw new Error("请先打开一个工作台，再打开此页面");
    const surface = new OkfDashboardView(leaf, this, {
      container,
      initialSection: section,
      embedded: true,
      ...(context ? { config: context.config, headerActions: context.headerActions, sectionActions: context.sectionActions,
        instanceKey: workbenchInstanceKey(target!.view.currentWorkspacePath(), context.columnId),
        workbenchPath: target!.view.currentWorkspacePath() } : {}),
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
    if (completed) {
      const open = notice.noticeEl.createEl("button", {
        text: isWiki ? "打开知识笔记" : "打开学习材料",
      });
      open.addEventListener("click", () => {
        notice.hide();
        void this.openVaultPath(operation.target);
      });
    }
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
      "waiting-for-parser",
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
    notice.noticeEl.createDiv({ text: `${record.source_filename} · ${record.method ? methodLabels[record.method] : record.parser}` });
    for (const warning of record.warnings ?? []) notice.noticeEl.createDiv({ text: warning });
    notice.noticeEl.createEl("button", { text: "重新转换…" }).addEventListener("click", () => {
      notice.hide();
      this.promptDocumentReconversion(record);
    });
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
    this.addCommand({ id: "open-appearance-studio", name: "打开外观工作室", callback: () => this.apexHost?.openAppearanceStudio() });
    this.addCommand({ id: "new-task", name: "新建任务", callback: () => this.promptNewTask() });
    this.addCommand({ id: "open-tasks", name: "打开任务", callback: () =>
      void this.navigateToOkfSection("tasks", undefined, undefined, { taskView: "all" }) });
    for (const section of ["today", "inbox", "reading", "sources", "learning", "projects", "knowledge", "life"] as const) {
      this.addCommand({ id: `open-${section}`, name: `打开${okfSectionDefaultName(section)}`,
        callback: () => void this.navigateToOkfSection(section) });
    }
    this.addCommand({ id: "view-document-uploads", name: "查看已保存的资料",
      callback: () => this.openDocumentSubmissions() });
    this.addCommand({ id: 'inspect-task-boundary', name: '检查任务范围与历史配置', callback: () => {
      void readTaskBoundaryReport(this.app, this.settings.tasks).then(report => new TaskBoundaryReportModal(this.app, report).open())
        .catch(error => new Notice(String(error), 8000));
    } });
    this.addCommand({
      id: DASHBOARD_COMMAND_ID,
      name: "打开工作台",
      callback: () => void this.openDashboard(),
    });
    this.addCommand({
      id: "open-system",
      name: "打开后台与诊断",
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
    if (!this.isMobile) this.addCommand({
      id: "ask-notes",
      name: "问我的笔记",
      callback: () => this.promptAsk(),
    });
    if (!this.isMobile) this.addCommand({
      id: "create-knowledge-from-sources",
      name: "在 Claudian 中生成知识笔记",
      callback: () => this.promptWikiFromSources(),
    });
    if (!this.isMobile) this.addCommand({
      id: "rewrite-current-section",
      name: "在 Claudian 中修改当前章节",
      callback: () => this.promptRewriteCurrentSection(),
    });
    this.addCommand({
      id: "import-document",
      name: "导入 PDF/Word/PowerPoint",
      callback: () => this.promptDocumentImport(),
    });
    if (!this.isMobile) this.addCommand({
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

  public openDocumentSubmissions(): void { new SyncedImportsModal(this.app, this.originalFiles).open(); }

  public openDocumentImport(
    files: ImportFile[] = [],
    relation: Pick<DocumentImportOptions, "course" | "project"> = {},
    origin: ImportOrigin = "command",
  ): void {
    const key = JSON.stringify(relation);
    const version = (this.importDraftVersions.get(key) ?? 0) + 1;
    this.importDraftVersions.set(key, version);
    new DocumentImportModal(
        this.app, files, relation, origin,
        async (file, options) => {
          const saved = await saveSyncedDocument(this.app, file, options);
          this.refreshDashboardViews();
          return saved;
        }, undefined,
        async (kind, title, slug) => {
          const result = kind === "course" ? await this.notes().createCourse(title, slug)
            : await this.notes().createProject(title, slug);
          this.refreshDashboardViews();
          return result;
        }, true, "store", false, false, "learn", this.importDrafts.get(key), draft => {
          if (this.importDraftVersions.get(key) !== version) return;
          if (draft) this.importDrafts.set(key, draft);
          else this.importDrafts.delete(key);
        },
    ).open();
  }

  public promptDocumentReconversion(record: ConversionRecord): void {
    new DocumentReconversionModal(
      this.app, record.source_filename,
      async () => {
        await this.ensureLocalServiceAvailable();
        return this.api().converters();
      },
      async (method) => {
        const retried = await this.api().retryConversion(record.conversion_id, method);
        this.watchDocumentConversion(retried.conversion_id);
        this.refreshDashboardViews();
        new Notice("已按指定方式重新排队；沿用原件与资料身份");
      },
    ).open();
  }

  public async processSourceOriginal(path: string, relation: Pick<DocumentImportOptions, "course" | "project"> = {},
    generate = false, generationKind: "learn" | "wiki" = "learn"): Promise<void> {
    const references = await originalsForNote(this.app, path);
    if (!references.length) throw new Error("该资料没有可用的文件原件，无法请求转换");
    const open = async (digest: string): Promise<void> => {
      const reference = references.find(item => item.digest === digest)!;
      const original = this.app.vault.getAbstractFileByPath(reference.path ?? `sources/originals/${digest}/${reference.filename}`);
      if (!(original instanceof TFile)) throw new Error("原件尚未同步到本机，请等待同步完成");
      const input = { file: new File([await this.app.vault.readBinary(original)], reference.filename), relativePath: reference.filename };
      const draft: DocumentImportDraft = { files: [input], relation, action: "convert", intent: generate ? generationKind : "source",
        generate, generationKind, quality: "quick", method: "auto" };
      new DocumentImportModal(this.app, [input], relation, "context",
        (file, options) => saveSyncedDocument(this.app, file, options), undefined, undefined, true,
        "convert", generate, false, generationKind, draft).open();
    };
    if (references.length === 1) await open(references[0]!.digest);
    else new ChoiceModal(this.app, references.map(item => ({ value: item.digest, label: item.filename, description: "选择要转换的原件" })),
      "选择原件", open).open();
  }

  public async showDocumentConversionResult(record: ConversionRecord): Promise<void> {
    try {
      const result = await this.api().conversionResult(record.conversion_id);
      new DocumentConversionResultModal(this.app, result).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
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

  private registerOriginalAccess(): void {
    this.addCommand({ id: "open-original", name: "打开当前资料的原件", callback: () => {
      const file = this.app.workspace.getActiveFile();
      if (file) void this.originalFiles?.openNote(file.path);
    } });
    this.registerObsidianProtocolHandler("okf-original", (params) => {
      if (/^[0-9a-f]{64}$/u.test(params.sha256 ?? "") && params.filename) {
        void this.originalFiles?.open({ digest: params.sha256!, filename: params.filename });
      }
    });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile)) return;
      if (file.extension === "md") menu.addItem((item) => item.setTitle("打开关联原件").setIcon("file")
        .onClick(() => void this.originalFiles?.openNote(file.path)));
      else if (/^(pdf|docx?|pptx?|png|jpe?g|webp|bmp|gif)$/iu.test(file.extension)) {
        menu.addItem((item) => item.setTitle("导入为资料").setIcon("file-input").onClick(() => {
          void this.originalFiles?.importVaultFile(file, (input) =>
            this.openDocumentImport([{ file: input, relativePath: input.name }]))
            .catch((error: unknown) => new Notice(error instanceof Error ? error.message : "附件读取失败"));
        }));
      }
    }));
    this.registerMarkdownPostProcessor((element, context) => {
      if (!element.querySelector("h1")) return;
      const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!(file instanceof TFile)) return;
      const kind = this.app.metadataCache.getFileCache(file)?.frontmatter?.type;
      if (!["Source", "Source Text", "Study Guide", "Wiki"].includes(String(kind))) return;
      const button = element.createEl("button", { text: "打开关联原件", cls: "okf-original-action" });
      button.addEventListener("click", () => void this.originalFiles?.openNote(file.path));
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
      if (this.isMobile) return;
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
    const api = this.feedApi();
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
    const request = this.feedApi()
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
    try {
      const result = await this.tryOpenVaultPath(path, blockId ? `^${blockId}` : undefined);
      if (result !== "opened") this.noticeVaultOpenFailure(result, path);
    } catch (error) {
      console.warn("[okf-workspace] could not open Vault path", { path, error });
      new Notice(error instanceof Error ? error.message : `无法打开文件：${path}`, 10_000);
    }
  }

  private async tryOpenVaultPath(
    path: string,
    fragment?: string,
  ): Promise<"opened" | "unindexed" | "missing" | "unavailable"> {
    const normalized = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
    const file = await this.waitForVaultFile(normalized);
    if (file) {
      if (fragment) {
        await this.app.workspace.openLinkText(`${normalized}#${fragment}`, "", false);
      } else {
        await this.app.workspace.getLeaf(false).openFile(file);
      }
      return "opened";
    }
    let diskType: "file" | "folder" | undefined;
    try {
      diskType = (await this.app.vault.adapter.stat(normalized))?.type;
    } catch (error) {
      console.warn("[okf-workspace] could not inspect missing Vault path", { path: normalized, error });
      return "unavailable";
    }
    console.warn("[okf-workspace] Vault path could not be opened", {
      path: normalized,
      diskType,
      indexed: false,
    });
    return diskType === "file" ? "unindexed" : "missing";
  }

  private noticeVaultOpenFailure(
    status: "unindexed" | "missing" | "unavailable",
    path: string,
  ): void {
    const normalized = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
    const location = !this.isMobile && this.app.vault.adapter instanceof FileSystemAdapter
      ? this.app.vault.adapter.getFullPath(normalized)
      : normalized;
    new Notice(status === "unindexed"
      ? `文件在当前 Vault 的磁盘中，但 Obsidian 尚未识别；请重新加载 Obsidian 后打开：${location}`
      : status === "missing"
        ? `当前 Vault 中尚无该文件；若正在后台生成请等待，若任务已完成请检查服务连接的 Vault：${location}`
        : `Obsidian 无法核查文件状态；请检查当前 Vault：${location}`, 10_000);
  }

  private async waitForVaultFile(path: string): Promise<TFile | undefined> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) return file;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    return undefined;
  }

  private async openVaultHeading(path: string, heading: string): Promise<void> {
    const result = await this.tryOpenVaultPath(path, heading);
    if (result !== "opened") this.noticeVaultOpenFailure(result, path);
  }

  public async ensureLocalServiceAvailable(): Promise<void> {
    if (this.isMobile) throw new Error("这个处理操作请在电脑上执行；资料可先保存并同步提交");
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
    const recoveredWorkspace = await recoverWorkspaceRegistry(apexSettings, this.app.vault.adapter);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      dashboardUiState: normalizeDashboardUiState(
        loaded?.dashboardUiState,
        loaded?.feedReadingPositions,
      ),
      feedReadingPositions: { ...DEFAULT_SETTINGS.feedReadingPositions, ...loaded?.feedReadingPositions },
      apex: normalizeApexSettings(recoveredWorkspace.settings),
      tasks: loaded.tasks && typeof loaded.tasks === 'object' ? loaded.tasks : {},
    };
    await this.reloadLocalToken();
    if (importedLegacyApexSettings || recoveredWorkspace.recovered) await this.saveSettings();
  }

  private async initializeTasks(): Promise<void> {
    if (!Object.keys(this.settings.tasks).length) {
      const legacyPath = `${this.app.vault.configDir}/plugins/obsidian-tasks-plugin/data.json`;
      if (await this.app.vault.adapter.exists(legacyPath)) {
        const legacy: unknown = JSON.parse(await this.app.vault.adapter.read(legacyPath));
        if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('Tasks 设置格式无效');
        this.settings.tasks = legacy as Record<string, unknown>;
        await this.saveSettings();
      }
    }
    await configureTasks(this.settings.tasks);
    setTaskSourceFilter(path => {
      if (!path) return true;
      const file = this.app.vault.getAbstractFileByPath(path);
      return taskSourceKind(path, file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter ?? {} : {}) === 'tasks';
    });
    this.register(() => setTaskSourceFilter());
    const installed = (this.app as AppWithTaskPlugins).plugins?.plugins?.['obsidian-tasks-plugin'];
    if (installed) {
      const notice = new Notice('', 0);
      notice.noticeEl.createDiv({ text: '独立 Tasks 插件正在运行。切换后由工作台内置的 Tasks 接管笔记操作，原任务和设置均保留。' });
      const button = notice.noticeEl.createEl('button', { text: '使用内置 Tasks' });
      button.addEventListener('click', () => {
        button.disabled = true;
        void (async () => {
          await (this.app as AppWithTaskPlugins).plugins!.disablePluginAndSave('obsidian-tasks-plugin');
          await this.initializeTasks();
          if (this.apexHost) this.apexHost.handlesTaskReminders = false;
          notice.hide();
          this.refreshDashboardViews();
        })().catch(error => { button.disabled = false; new Notice(error instanceof Error ? error.message : '切换 Tasks 失败', 8000); });
      });
      return;
    }
    const { installTasks } = await import('../../tasks-generated/plugin.js');
    this.taskRuntime = await installTasks(this, {
      settings: { ...this.settings.tasks, statusSettings: getTaskSettings().statusSettings },
      save: async settings => {
        this.settings.tasks = { ...this.settings.tasks, ...settings };
        invalidateAllTasks();
        await this.saveTaskStatusContract();
        await this.saveSettings();
      },
      onError: error => {
        console.error('[okf-workspace] task index refresh failed', error);
        new Notice(error instanceof Error ? error.message : '任务索引刷新失败', 8000);
      },
      invalidate: path => {
        if (path) invalidatePath(path); else invalidateAllTasks();
        this.refreshDashboardViews();
      },
      writeTask: async (task, lines) => {
        const file = this.app.vault.getAbstractFileByPath(task.path);
        if (!(file instanceof TFile)) throw new Error('任务来源已经变化');
        const source = await this.app.vault.read(file);
        if (!scanFileTasks(file, source).some(candidate => candidate.eligible && candidate.originalLine === task.originalMarkdown)) throw new Error('任务或来源已经变化，请刷新后重试');
        if (!await replaceTaskInFile(this.app, { file, path: task.path, line: task.lineNumber, originalLine: task.originalMarkdown }, lines)) throw new Error('无法唯一定位任务');
        this.refreshDashboardViews();
      },
    });
    await this.saveTaskStatusContract();
    this.taskReminders = new TaskReminderService({
      read: async () => (await collectVaultTasks(this.app)).filter(task => task.eligible),
      acknowledged: this.settings.tasks.reminderAcknowledgements as ReminderStore | undefined,
      save: async state => { this.settings.tasks.reminderAcknowledgements = state; await this.saveSettings(); },
      show: (task, acknowledge) => this.showTaskReminder(task, acknowledge),
    });
    const check = () => void this.taskReminders!.tick().catch(error => {
      console.error('[okf-workspace] task reminders failed', error);
      new Notice(error instanceof Error ? error.message : '任务提醒检查失败', 8000);
    });
    this.registerInterval(window.setInterval(check, 30_000));
    check();
  }

  private showTaskReminder(task: VaultTask, acknowledge: () => Promise<void>): void {
    const notice = new Notice('', 0);
    notice.noticeEl.createEl('strong', { text: task.text });
    notice.noticeEl.createDiv({ text: `${task.reminder} · ${task.path}` });
    notice.noticeEl.createEl('button', { text: '打开任务', attr: { type: 'button' } }).addEventListener('click', () =>
      void (task.formal ? this.promptTaskDetails(task) : this.openTaskSource(task)).catch(error => new Notice(String(error))));
    const action = (label: string, execute: () => Promise<void>) => {
      const button = notice.noticeEl.createEl('button', { text: label });
      button.addEventListener('click', () => {
        button.disabled = true;
        void execute().then(async () => { await acknowledge(); notice.hide(); }).catch(error => {
          button.disabled = false;
          new Notice(error instanceof Error ? error.message : '提醒操作失败', 8000);
        });
      });
    };
    action('完成', async () => {
      if (!await toggleTaskInFile(this.app, task, true)) throw new Error('任务已经变化，请刷新后重试');
      this.refreshDashboardViews();
    });
    action('稍后一小时', async () => {
      const date = new Date(Date.now() + 3_600_000);
      const pad = (value: number) => String(value).padStart(2, '0');
      const reminder = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      if (!await updateTaskDatesInFile(this.app, task, { reminder })) throw new Error('任务已经变化，请刷新后重试');
      this.refreshDashboardViews();
    });
    action('关闭提醒', async () => {});
  }

  private async saveTaskStatusContract(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath('system/views/Tasks.md');
    if (!(file instanceof TFile)) return;
    const statuses = taskStatusTypes();
    await this.app.fileManager.processFrontMatter(file, frontmatter => {
      frontmatter.task_statuses = statuses;
      frontmatter.task_projection = { version: 1, global_filter: getTaskSettings().globalFilter,
        global_query: getTaskSettings().globalQuery, task_format: getTaskSettings().taskFormat };
    });
  }

  public async promptTaskDetails(task: VaultTask): Promise<void> {
    if (!this.taskRuntime) throw new Error('任务功能尚未启用，请停用独立 Tasks 插件并重新载入 Dashboard');
    const contexts = await this.notes().captureContexts();
    let published: string | undefined;
    this.taskRuntime.editTask(task.originalLine, task.path, async lines => {
      const payload = lines.join('\n');
      if (published !== undefined && published !== payload) throw new Error('任务已保存，但刷新尚未完成；请先完成刷新，再重新打开编辑');
      if (published === undefined) {
        if (!await replaceTaskInFile(this.app, task, lines)) throw new Error('任务已发生变化，无法唯一定位');
        published = payload;
      }
      await this.taskRuntime!.refresh();
      this.refreshDashboardViews();
    }, { courses: contexts.courses, projects: contexts.projects,
      inheritedCourse: this.taskInheritedContext(task, 'course'), inheritedProject: this.taskInheritedContext(task, 'project'),
      openSource: () => void this.openTaskSource(task).catch(error => new Notice(String(error))),
      beforeApply: async () => {
        if (published !== undefined) return;
        const source = await this.app.vault.read(task.file);
        const matches = scanFileTasks(task.file, source).filter(item => item.originalLine === task.originalLine);
        if (!matches.length || matches.length > 1 && !matches.some(item => item.line === task.line)) throw new Error('任务在编辑期间已经变化，请保留输入并重新打开来源检查');
      },
    });
  }

  private taskInheritedContext(task: VaultTask, kind: 'course' | 'project'): string | undefined {
    const metadata = this.app.metadataCache.getFileCache(task.file)?.frontmatter;
    const reference = metadata?.[kind];
    if (typeof reference === 'string') return reference;
    if (kind === 'project' && /^projects\/[^/]+\//u.test(task.path)) return task.path.split('/')[1];
    if (kind === 'course' && /^learning\/courses\/[^/]+\//u.test(task.path)) return task.path.split('/')[2];
    return undefined;
  }

  public promptNewTask(context: Record<string, unknown> = {}): void {
    void (async () => {
      if (!this.taskRuntime) throw new Error('任务功能尚未启用');
      const day = new Date();
      const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      const contexts = await this.notes().captureContexts();
      const fields = ['course', 'project'].flatMap(key => typeof context[key] === 'string' && context[key]
        ? [`[${key}:: /${String(context[key]).replace(/^\//u, '')}]`] : []);
      const scheduled = typeof context.date === 'string' ? context.date : context.taskView === 'today' ? iso : '';
      const line = prepareTaskLine(`- [ ] ${fields.join(' ')}${scheduled ? ` ⏳ ${scheduled}` : ''}`);
      const initialTarget = String(context.target ?? context.project ?? context.course ?? '').replace(/^\//u, '');
      const calendarTarget = context.calendar ? this.settings.apex.calendarTaskTarget : undefined;
      const targetHint = calendarTarget?.path ? `留空使用日历保存位置：${calendarTarget.path}${calendarTarget.kind === 'note' ? '（每条任务一篇）' : calendarTarget.kind === 'folder' ? '（每天一篇）' : ''}。也可选择已有笔记。` : undefined;
      let published: { path: string; payload: string } | undefined;
      let prepared: { input: string; payload: string } | undefined;
      this.taskRuntime.editTask(line, initialTarget, async (lines, destination) => {
        const input = JSON.stringify(lines);
        if (prepared?.input !== input) prepared = { input, payload: lines.map(line => this.prepareFormalTaskLine(line)).join('\n') };
        const taskLine = prepared.payload;
        if (!taskLine) throw new Error('新建任务必须保留至少一个执行项');
        if (published && published.payload !== taskLine) throw new Error(`任务已经保存到 ${published.path}，刷新尚未完成；请先刷新后再编辑`);
        if (!published) {
          const path = destination?.trim().replace(/^\//u, '') ?? '';
          if (path) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile) || !this.taskTargetAllowed(file)) throw new Error('请选择已有的可编辑笔记；来源资料、模板和派生视图不作为任务保存位置');
            await this.notes().appendTaskToNote(file, taskLine);
            published = { path, payload: taskLine };
          } else if (calendarTarget?.path) {
            const destination = calendarTarget.path.trim().replace(/^\/+|\/+$/gu, '');
            if (!isTaskSourcePath(destination) || destination.split('/').some(part => ['.', '..'].includes(part) || part.includes(':'))) throw new Error('日历保存位置无效');
            if (calendarTarget.kind === 'note') {
              const result = await createTaskNote(this.app, { iso: scheduled || iso, taskLine, folder: destination,
                templatePath: calendarTarget.templatePath, untitled: '任务' });
              published = { path: result.file.path, payload: taskLine };
              if (result.templateMissing) new Notice('任务已保存；指定模板尚未读取，当前笔记仅包含任务。');
            } else {
              const path = calendarTarget.kind === 'folder' ? `${destination}/${scheduled || iso}.md` : destination.endsWith('.md') ? destination : `${destination}.md`;
              const file = this.app.vault.getAbstractFileByPath(path);
              if (file instanceof TFile) { if (!this.taskTargetAllowed(file)) throw new Error('此日历目标不能保存任务'); await this.notes().appendTaskToNote(file, taskLine); }
              else await this.notes().createTaskContainer(path, taskLine);
              published = { path, payload: taskLine };
            }
          } else {
            const result = await this.notes().appendDailyTaskBlock(taskLine);
            published = { path: result.path, payload: taskLine };
          }
        }
        await this.taskRuntime!.refresh();
        this.refreshDashboardViews();
        const notice = new Notice(`任务已保存：${published.path}`, 7000);
        notice.noticeEl.createEl('button', { text: '查看来源', attr: { type: 'button' } }).addEventListener('click', () => void this.openVaultPath(published!.path));
      }, { isNew: true, target: initialTarget, targetHint, courses: contexts.courses, projects: contexts.projects,
        beforeApply: async target => {
          if (published) return;
          const path = target?.trim().replace(/^\//u, '') ?? '';
          if (path) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile) || !this.taskTargetAllowed(file)) throw new Error('请选择已有的可编辑笔记作为保存位置');
          }
          if (calendarTarget?.path && (!isTaskSourcePath(calendarTarget.path) || calendarTarget.path.split('/').some(part => ['.', '..'].includes(part) || part.includes(':')))) throw new Error('日历保存位置无效');
        },
        targets: this.app.vault.getMarkdownFiles().filter(file => this.taskTargetAllowed(file)).map(file => ({ path: file.path,
          title: String(this.app.metadataCache.getFileCache(file)?.frontmatter?.title ?? file.basename) })) });
    })().catch(error => new Notice(error instanceof Error ? error.message : '新建任务失败', 8000));
  }

  private taskTargetAllowed(file: TFile): boolean {
    const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return taskSourceKind(file.path, metadata ?? {}) === 'tasks';
  }

  public promptMoveTask(task: VaultTask): void {
    const choices = this.app.vault.getMarkdownFiles().filter(file => file.path !== task.path && this.taskTargetAllowed(file))
      .map(file => ({ path: file.path, title: String(this.app.metadataCache.getFileCache(file)?.frontmatter?.title ?? file.basename) }));
    new TaskTargetModal(this.app, task.path, choices, async path => {
      await moveTaskToNote(this.app, task, path);
      await this.taskRuntime?.refresh();
      this.refreshDashboardViews();
    }).open();
  }

  public async addTaskToDaily(task: VaultTask, independent = false): Promise<void> {
    task = await this.resolveCurrentTask(task);
    if (independent) {
      await this.notes().appendDailyTaskBlock(await copyTaskSubtree(this.app, task));
    } else {
      let id = task.blockId;
      if (!id) {
        id = `task-${crypto.randomUUID()}`;
        if (!await replaceTaskInFile(this.app, task, [`${task.originalLine.trimEnd()} ^${id}`])) throw new Error('任务已经变化，请重新读取');
      }
      const daily = await this.notes().createDaily();
      const link = this.app.fileManager.generateMarkdownLink(task.file, daily.path, `#^${id}`, task.text);
      await this.notes().appendDailyTaskBlock(`- ${link}`);
    }
    await this.taskRuntime?.refresh();
    this.refreshDashboardViews();
    new Notice(independent ? '已复制为独立日记任务' : '已加入当日日记，继续操作原任务');
  }

  public async openTaskSource(task: VaultTask, origin?: HTMLElement): Promise<void> {
    const current = await this.resolveCurrentTask(task);
    const view = this.activeApexView(origin)?.view;
    if (view) view.revealTaskSource(current.file, current.line, current.blockId);
    else await this.app.workspace.getLeaf('tab').openFile(current.file, { eState: { line: current.line } });
  }

  private async resolveCurrentTask(task: VaultTask): Promise<VaultTask> {
    const tasks = await collectVaultTasks(this.app);
    const path = task.file.path;
    let current = task.blockId ? tasks.find(candidate => candidate.path === path && candidate.blockId === task.blockId)
      : tasks.find(candidate => candidate.path === path && candidate.line === task.line && candidate.originalLine === task.originalLine);
    if (!current && task.blockId) {
      const matches = tasks.filter(candidate => candidate.eligible && candidate.blockId === task.blockId);
      if (matches.length === 1) current = matches[0];
    }
    if (!current) throw new Error('任务已经变化，无法确定来源位置');
    return current;
  }

  public prepareFormalTaskLine(line: string): string {
    let prepared = line.trimEnd();
    if (prepared.includes('\n')) throw new Error('任务必须为单行 Markdown 清单');
    prepared = prepareTaskLine(prepared);
    if (!/\s+\^[\w-]+\s*$/u.test(prepared)) prepared += ` ^task-${crypto.randomUUID()}`;
    return prepared;
  }

  public taskQueryViews(): SavedTaskView[] {
    const views = this.settings.tasks.savedViews;
    if (views === undefined) return [];
    if (!Array.isArray(views)) throw new Error("保存视图配置必须为列表");
    return views.map((view, index) => {
      if (!view || typeof view.name !== "string" || typeof view.query !== "string" || !view.context || typeof view.context !== "object") throw new Error("保存视图缺少名称、查询或范围");
      return { ...view, id: typeof view.id === "string" ? view.id : `legacy-${index}-${encodeURIComponent(view.name)}`,
        context: { ...view.context, ...(!view.id && view.query ? { taskView: "custom" } : {}) } };
    });
  }

  public taskRuntimeTasks(): import('../../tasks-generated/core.js').UpstreamTask[] {
    return this.taskRuntime?.getTasks() ?? [];
  }

  public async saveTaskQueryView(query: string, context: Record<string, unknown>, id?: string): Promise<void> {
    const tasks = (await collectVaultTasks(this.app)).filter(task => task.formal && task.upstream).map(task => task.upstream!);
    const { executeTaskQuery } = await import('../../tasks-generated/core.js');
    executeTaskQuery(query, tasks);
    const savedContext = { ...context, taskQuery: query };
    for (const key of ["mode", "limit", "pageSize", "taskQueryDraft", "viewState", "taskShown"]) delete (savedContext as Record<string, unknown>)[key];
    if (id) {
      const views = this.taskQueryViews();
      const view = views.find(view => view.id === id);
      if (!view) throw new Error("保存视图已经变化，请重新选择");
      view.query = query;
      view.context = savedContext;
      this.settings.tasks.savedViews = views;
      await this.saveSettings();
      new Notice("保存视图已更新");
      return;
    }
    new FieldsPromptModal(this.app, '保存任务视图', [
      { key: 'name', label: '视图名称', placeholder: '例如：本周课程任务' },
    ], '保存视图', async values => {
      const name = values.name!;
      const views = this.taskQueryViews();
      if (views.some(view => view.name === name)) throw new Error("已有同名视图，请选择其他名称，或使用“更新当前保存视图”");
      views.push({ id: crypto.randomUUID(), name, query, context: savedContext });
      this.settings.tasks.savedViews = views;
      await this.saveSettings();
      this.refreshDashboardViews();
    }).open();
  }

  public manageTaskQueryViews(): void {
    const save = async (views: SavedTaskView[]) => { this.settings.tasks.savedViews = views; await this.saveSettings(); this.refreshDashboardViews(); };
    new TaskViewsModal(this.app, this.taskQueryViews(), async (id, name) => {
      if (!name.trim()) throw new Error("请填写视图名称");
      const views = this.taskQueryViews();
      if (views.some(view => view.id !== id && view.name === name.trim())) throw new Error("已有同名视图");
      const view = views.find(view => view.id === id);
      if (!view) throw new Error("视图已经变化");
      view.name = name.trim();
      await save(views);
    }, id => save(this.taskQueryViews().filter(view => view.id !== id))).open();
  }
}

type AppWithTaskPlugins = import('obsidian').App & { plugins?: { plugins?: Record<string, unknown>; disablePluginAndSave(id: string): Promise<void> } };

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

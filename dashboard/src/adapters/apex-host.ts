import { Notice, Platform, TFile, type Plugin } from "obsidian";

import { BackupService } from "../../apex/src/backup-service.js";
import { ExpenseService, registerExpenseService } from "../../apex/src/expense-service.js";
import { HabitService, registerHabitService } from "../../apex/src/habit-service.js";
import {
  type ApexHost,
  type ArtifactMutation,
  type ArtifactMutationResult,
  registerApexHost,
} from "../../apex/src/host.js";
import type { DashboardCard } from "../../apex/src/types.js";
import { setLanguage, t } from "../../apex/src/i18n.js";
import { MediaTagService, registerMediaTagService } from "../../apex/src/media-tags.js";
import { MusicService, registerMusicService } from "../../apex/src/music-service.js";
import { PomodoroService } from "../../apex/src/pomodoro-service.js";
import { ReadingService } from "../../apex/src/reading-service.js";
import {
  createPomodoroMiniPanel,
  type PomodoroMiniPanel,
} from "../../apex/src/pomodoro-mini-panel.js";
import {
  createReadingMiniTimer,
  type ReadingMiniTimer,
} from "../../apex/src/reading-mini-timer.js";
import { generateDefaultMarkdown } from "../../apex/src/parser.js";
import { teardownBasenameIndex } from "../../apex/src/renderer.js";
import { type DashboardSettings } from "../../apex/src/types.js";
import type { TaskInsertTarget } from "../../apex/src/daily-notes.js";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "../../apex/src/view.js";
import {
  alignWorkspaceNames,
  nextWorkspacePath,
  normalizeWorkspacePath,
  pruneMissingWorkspaces,
} from "../../apex/src/workspace-registry.js";

export interface ApexHostAdapterOptions {
  owner: Plugin;
  settings: DashboardSettings;
  persist: (settings: DashboardSettings) => Promise<void>;
  insertCalendarTask?: (
    date: string,
    taskLine: string,
    position: "start" | "end",
  ) => Promise<TaskInsertTarget | null>;
  workspacePresets?: ApexHost["workspacePresets"];
  createWorkspaceMarkdown?: (presetId?: string) => string;
  mutateManagedArtifact?: (mutation: ArtifactMutation) => Promise<ArtifactMutationResult>;
  convertMemoToCapture?: (
    workspacePath: string,
    card: DashboardCard,
  ) => Promise<{ path: string; created: boolean }>;
  createManagedArtifact?: (artifactType: string) => Promise<boolean>;
}

/**
 * Hosts the upstream Apex UI and native services inside the single OKF plugin.
 * It owns no Workspace domain rules; those remain in the outer plugin/Engine.
 */
export class ApexHostAdapter implements ApexHost {
  public settings: DashboardSettings;
  public readonly app;
  public readonly manifest;

  private readonly owner: Plugin;
  private readonly persist: (settings: DashboardSettings) => Promise<void>;
  private readonly calendarTaskWriter: ApexHostAdapterOptions["insertCalendarTask"];
  public readonly workspacePresets: ApexHost["workspacePresets"];
  private readonly workspaceMarkdownFactory: ApexHostAdapterOptions["createWorkspaceMarkdown"];
  private readonly artifactMutation: ApexHostAdapterOptions["mutateManagedArtifact"];
  private readonly memoConversion: ApexHostAdapterOptions["convertMemoToCapture"];
  private readonly managedArtifactCreation: ApexHostAdapterOptions["createManagedArtifact"];
  public readonly backupService: BackupService;
  private readonly mediaTagService: MediaTagService;
  private readonly habitService: HabitService;
  private readonly expenseService: ExpenseService;
  public readonly pomodoroService: PomodoroService;
  public readonly readingService: ReadingService;
  private musicService: MusicService | undefined;
  private pomodoroMiniPanel: PomodoroMiniPanel | undefined;
  private readingMiniTimer: ReadingMiniTimer | undefined;
  private workspaceOps: Promise<void> = Promise.resolve();
  private destroyed = false;

  public constructor(options: ApexHostAdapterOptions) {
    this.owner = options.owner;
    this.app = options.owner.app;
    this.manifest = options.owner.manifest;
    this.settings = options.settings;
    this.persist = options.persist;
    this.calendarTaskWriter = options.insertCalendarTask;
    this.workspacePresets = options.workspacePresets;
    this.workspaceMarkdownFactory = options.createWorkspaceMarkdown;
    this.artifactMutation = options.mutateManagedArtifact;
    this.memoConversion = options.convertMemoToCapture;
    this.managedArtifactCreation = options.createManagedArtifact;
    this.backupService = new BackupService(this);
    this.mediaTagService = new MediaTagService(this);
    this.habitService = new HabitService(this);
    this.expenseService = new ExpenseService(this);
    this.pomodoroService = new PomodoroService(this);
    this.readingService = new ReadingService(this);
  }

  public async initialize(): Promise<void> {
    setLanguage(this.settings.language);
    registerApexHost(this);

    this.mediaTagService.load();
    registerMediaTagService(this.mediaTagService);
    await Promise.all([
      this.habitService.load(),
      this.expenseService.load(),
      this.pomodoroService.loadSessions(),
      this.readingService.loadSessions(),
    ]);
    registerHabitService(this.habitService);
    registerExpenseService(this.expenseService);

    if (!Platform.isPhone) {
      this.musicService = new MusicService(this);
      await this.musicService.load();
      registerMusicService(this.musicService);
    }
    this.pomodoroMiniPanel = createPomodoroMiniPanel(this, this.pomodoroService, activeDocument);
    this.readingMiniTimer = createReadingMiniTimer(this.readingService, activeDocument);

    this.owner.registerInterval(window.setInterval(() => void this.backupService.tick(), 60_000));
    this.owner.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) void this.handleWorkspaceFileRenamed(file, oldPath);
    }));
    this.owner.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) void this.handleWorkspaceFileDeleted(file);
    }));
    this.app.workspace.onLayoutReady(() => void this.pruneWorkspaceRegistry());
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    registerApexHost(null);
    teardownBasenameIndex(this.app);
    registerMediaTagService(null);
    void this.mediaTagService.flush();
    this.mediaTagService.destroy();
    registerHabitService(null);
    this.habitService.destroy();
    registerExpenseService(null);
    this.expenseService.destroy();
    this.pomodoroMiniPanel?.destroy();
    this.pomodoroMiniPanel = undefined;
    this.readingMiniTimer?.destroy();
    this.readingMiniTimer = undefined;
    this.pomodoroService.destroy();
    this.readingService.destroy();
    registerMusicService(null);
    this.musicService?.destroy();
  }

  public async saveSettings(): Promise<void> {
    await this.persist(this.settings);
  }

  public insertCalendarTask(
    date: string,
    taskLine: string,
    position: "start" | "end",
  ): Promise<TaskInsertTarget | null> {
    if (!this.calendarTaskWriter) return Promise.resolve(null);
    return this.calendarTaskWriter(date, taskLine, position);
  }

  public mutateManagedArtifact(mutation: ArtifactMutation): Promise<ArtifactMutationResult> {
    return this.artifactMutation?.(mutation) ?? Promise.resolve({ outcome: "allow" });
  }

  public convertMemoToCapture(
    workspacePath: string,
    card: DashboardCard,
  ): Promise<{ path: string; created: boolean }> {
    if (!this.memoConversion) return Promise.reject(new Error("Capture 转换服务未配置"));
    return this.memoConversion(workspacePath, card);
  }

  public createManagedArtifact(artifactType: string): Promise<boolean> {
    return this.managedArtifactCreation?.(artifactType) ?? Promise.resolve(false);
  }

  public createDefaultWorkspaceMarkdown(): string {
    return this.workspaceMarkdownFactory?.() ?? generateDefaultMarkdown();
  }

  public refreshAllDashboards(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      if (leaf.view instanceof DashboardView) void leaf.view.refresh();
    }
  }

  public async reloadAllDashboards(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      if (leaf.view instanceof DashboardView) await leaf.view.reloadFromDisk();
    }
  }

  public async addSection(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    if (!(leaf?.view instanceof DashboardView)) {
      new Notice(t("main.openDashboard"));
      return;
    }
    await leaf.view.addSection();
  }

  public async toggleBannerMode(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    if (!(leaf?.view instanceof DashboardView)) {
      new Notice(t("main.openDashboard"));
      return;
    }
    await leaf.view.toggleBannerMode();
  }

  public async cycleTheme(): Promise<void> {
    const themes = [
      "earth", "nordic", "aurora", "blossom", "lilac", "island", "tundra",
      "matcha", "mono", "neon", "volt", "magma", "onyx",
    ];
    const index = themes.indexOf(this.settings.stylePreset);
    this.settings = { ...this.settings, stylePreset: themes[(index + 1) % themes.length] ?? "earth" };
    await this.saveSettings();
    this.refreshAllDashboards();
  }

  public cycleWorkspace(delta: 1 | -1): void {
    const files = this.settings.workspaceFiles;
    if (files.length < 2) return;
    const active = normalizeWorkspacePath(this.settings.dashboardFile);
    const index = Math.max(0, files.indexOf(active));
    const next = files[(index + delta + files.length) % files.length];
    if (next) void this.switchWorkspace(next);
  }

  public async switchWorkspace(path: string): Promise<void> {
    return this.runWorkspaceOp(async () => {
      const target = normalizeWorkspacePath(path);
      if (!target) return;
      if (!this.settings.workspaceFiles.includes(target)) return;
      if (target !== normalizeWorkspacePath(this.settings.dashboardFile)) {
        this.settings = { ...this.settings, dashboardFile: target };
        await this.saveSettings();
      }
      const active = this.app.workspace.getActiveViewOfType(DashboardView);
      if (active) await active.switchWorkspace(target);
    });
  }

  public async createWorkspace(name: string, presetId?: string): Promise<string | void> {
    return this.runWorkspaceOp(async () => {
      const trimmed = name.trim();
      const path = nextWorkspacePath(
        this.settings.workspaceFiles,
        trimmed,
        (candidate) => this.workspaceFileExists(candidate),
      );
      try {
        const markdown = this.workspaceMarkdownFactory?.(presetId) ?? generateDefaultMarkdown();
        await this.app.vault.create(path.endsWith(".md") ? path : `${path}.md`, markdown);
      } catch (error) {
        console.error("Workspace file creation failed:", error);
        new Notice(t("workspace.createFailed"));
        return undefined;
      }
      const names = alignWorkspaceNames(this.settings.workspaceFiles, this.settings.workspaceNames);
      this.settings = {
        ...this.settings,
        workspaceFiles: [...this.settings.workspaceFiles, path],
        workspaceNames: [...names, trimmed],
        dashboardFile: path,
      };
      await this.saveSettings();
      new Notice(t("workspace.created", { name: trimmed || path }));
      return path;
    });
  }

  public async renameWorkspace(path: string, name: string): Promise<void> {
    const target = normalizeWorkspacePath(path);
    const index = this.settings.workspaceFiles.indexOf(target);
    if (index < 0) return;
    const names = alignWorkspaceNames(this.settings.workspaceFiles, this.settings.workspaceNames);
    const trimmed = name.trim();
    if (names[index] === trimmed) return;
    this.settings = {
      ...this.settings,
      workspaceNames: names.map((current, position) => position === index ? trimmed : current),
    };
    await this.saveSettings();
    this.refreshAllDashboards();
  }

  public async removeWorkspace(path: string): Promise<void> {
    return this.runWorkspaceOp(async () => {
      const files = this.settings.workspaceFiles;
      if (files.length <= 1) return;
      const target = normalizeWorkspacePath(path);
      const index = files.indexOf(target);
      if (index < 0) return;
      const names = alignWorkspaceNames(files, this.settings.workspaceNames);
      const nextFiles = files.filter((_, position) => position !== index);
      const active = normalizeWorkspacePath(this.settings.dashboardFile);
      this.settings = {
        ...this.settings,
        workspaceFiles: nextFiles,
        workspaceNames: names.filter((_, position) => position !== index),
        dashboardFile: active === target ? nextFiles[0]! : this.settings.dashboardFile,
      };
      await this.saveSettings();
      await this.repointRemovedWorkspace(target, this.settings.dashboardFile);
    });
  }

  public async reorderWorkspaces(from: number, to: number): Promise<void> {
    return this.runWorkspaceOp(async () => {
      const files = [...this.settings.workspaceFiles];
      const names = alignWorkspaceNames(files, this.settings.workspaceNames);
      if (from < 0 || from >= files.length || to < 0 || to >= files.length || from === to) return;
      const [movedFile] = files.splice(from, 1);
      const [movedName] = names.splice(from, 1);
      files.splice(to, 0, movedFile!);
      names.splice(to, 0, movedName!);
      this.settings = { ...this.settings, workspaceFiles: files, workspaceNames: names };
      await this.saveSettings();
      this.refreshAllDashboards();
    });
  }

  public async retargetWorkspace(oldPath: string, newPath: string): Promise<void> {
    return this.runWorkspaceOp(async () => {
      const target = normalizeWorkspacePath(oldPath);
      const next = normalizeWorkspacePath(newPath);
      const index = this.settings.workspaceFiles.indexOf(target);
      if (index < 0 || !next || next === target) return;
      if (this.settings.workspaceFiles.includes(next)) {
        new Notice(t("workspace.pathExists"));
        return;
      }
      if (!this.workspaceFileExists(next)) {
        new Notice(t("workspace.pathNotFound", { file: `${next}.md` }));
        return;
      }
      const activeChanged = normalizeWorkspacePath(this.settings.dashboardFile) === target;
      this.settings = {
        ...this.settings,
        workspaceFiles: this.settings.workspaceFiles.map((current, position) => position === index ? next : current),
        workspaceNames: alignWorkspaceNames(this.settings.workspaceFiles, this.settings.workspaceNames),
        dashboardFile: activeChanged ? next : this.settings.dashboardFile,
      };
      await this.saveSettings();
      await this.repointRenamedWorkspace(target, next);
      this.refreshAllDashboards();
    });
  }

  private runWorkspaceOp<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.workspaceOps.then(operation);
    this.workspaceOps = run.then(() => undefined).catch((error: unknown) => {
      console.error("Workspace operation failed:", error);
    });
    return run;
  }

  private workspaceFileExists(path: string): boolean {
    return !!this.app.vault.getFileByPath(path.endsWith(".md") ? path : `${path}.md`);
  }

  private async repointRemovedWorkspace(path: string, fallback: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      if (leaf.view instanceof DashboardView) await leaf.view.handleWorkspaceRemoved(path, fallback);
    }
  }

  private async repointRenamedWorkspace(oldPath: string, newPath: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      if (leaf.view instanceof DashboardView) await leaf.view.replaceWorkspacePath(oldPath, newPath);
    }
  }

  private async pruneWorkspaceRegistry(): Promise<void> {
    const active = normalizeWorkspacePath(this.settings.dashboardFile);
    const pruned = pruneMissingWorkspaces(
      this.settings.workspaceFiles,
      alignWorkspaceNames(this.settings.workspaceFiles, this.settings.workspaceNames),
      active,
      (path) => this.workspaceFileExists(path),
    );
    if (pruned.files.length === this.settings.workspaceFiles.length) return;
    this.settings = { ...this.settings, workspaceFiles: pruned.files, workspaceNames: pruned.names };
    await this.saveSettings();
    this.refreshAllDashboards();
  }

  private async handleWorkspaceFileRenamed(file: TFile, oldPath: string): Promise<void> {
    return this.runWorkspaceOp(async () => {
      const oldEntry = normalizeWorkspacePath(oldPath);
      const index = this.settings.workspaceFiles.indexOf(oldEntry);
      if (index < 0) return;
      const next = normalizeWorkspacePath(file.path);
      const active = normalizeWorkspacePath(this.settings.dashboardFile);
      this.settings = {
        ...this.settings,
        workspaceFiles: this.settings.workspaceFiles.map((current, position) => position === index ? next : current),
        workspaceNames: alignWorkspaceNames(this.settings.workspaceFiles, this.settings.workspaceNames),
        dashboardFile: active === oldEntry ? next : this.settings.dashboardFile,
      };
      await this.saveSettings();
      await this.repointRenamedWorkspace(oldEntry, next);
    });
  }

  private async handleWorkspaceFileDeleted(file: TFile): Promise<void> {
    return this.runWorkspaceOp(async () => {
      const entry = normalizeWorkspacePath(file.path);
      const files = this.settings.workspaceFiles;
      const index = files.indexOf(entry);
      if (index < 0) return;
      if (files.length <= 1) {
        this.settings = {
          ...this.settings,
          workspaceFiles: ["dashboard"],
          workspaceNames: [""],
          dashboardFile: "dashboard",
        };
      } else {
        const names = alignWorkspaceNames(files, this.settings.workspaceNames);
        const nextFiles = files.filter((_, position) => position !== index);
        const active = normalizeWorkspacePath(this.settings.dashboardFile);
        this.settings = {
          ...this.settings,
          workspaceFiles: nextFiles,
          workspaceNames: names.filter((_, position) => position !== index),
          dashboardFile: active === entry ? nextFiles[0]! : this.settings.dashboardFile,
        };
      }
      await this.saveSettings();
      await this.repointRemovedWorkspace(entry, this.settings.dashboardFile);
    });
  }
}

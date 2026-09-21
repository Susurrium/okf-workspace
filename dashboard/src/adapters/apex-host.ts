import { Notice, Platform, TFile, type Plugin } from "obsidian";

import { BackupService } from "../../apex/src/backup-service.js";
import { ExpenseService, registerExpenseService } from "../../apex/src/expense-service.js";
import { HabitService, registerHabitService } from "../../apex/src/habit-service.js";
import { type ApexHost, registerApexHost } from "../../apex/src/host.js";
import { setLanguage, t } from "../../apex/src/i18n.js";
import { MediaTagService, registerMediaTagService } from "../../apex/src/media-tags.js";
import { MusicService, registerMusicService } from "../../apex/src/music-service.js";
import { generateDefaultMarkdown } from "../../apex/src/parser.js";
import { teardownBasenameIndex } from "../../apex/src/renderer.js";
import { type DashboardSettings } from "../../apex/src/types.js";
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
  public readonly backupService: BackupService;
  private readonly mediaTagService: MediaTagService;
  private readonly habitService: HabitService;
  private readonly expenseService: ExpenseService;
  private musicService: MusicService | undefined;
  private workspaceOps: Promise<void> = Promise.resolve();
  private destroyed = false;

  public constructor(options: ApexHostAdapterOptions) {
    this.owner = options.owner;
    this.app = options.owner.app;
    this.manifest = options.owner.manifest;
    this.settings = options.settings;
    this.persist = options.persist;
    this.backupService = new BackupService(this);
    this.mediaTagService = new MediaTagService(this);
    this.habitService = new HabitService(this);
    this.expenseService = new ExpenseService(this);
  }

  public async initialize(): Promise<void> {
    setLanguage(this.settings.language);
    registerApexHost(this);

    this.mediaTagService.load();
    registerMediaTagService(this.mediaTagService);
    await Promise.all([this.habitService.load(), this.expenseService.load()]);
    registerHabitService(this.habitService);
    registerExpenseService(this.expenseService);

    if (!Platform.isPhone) {
      this.musicService = new MusicService(this);
      await this.musicService.load();
      registerMusicService(this.musicService);
    }

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
    registerMusicService(null);
    this.musicService?.destroy();
  }

  public async saveSettings(): Promise<void> {
    await this.persist(this.settings);
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
      if (!target || target === normalizeWorkspacePath(this.settings.dashboardFile)) return;
      if (!this.settings.workspaceFiles.includes(target)) return;
      this.settings = { ...this.settings, dashboardFile: target };
      await this.saveSettings();
      await this.repointAllViews();
    });
  }

  public async createWorkspace(name: string): Promise<void> {
    return this.runWorkspaceOp(async () => {
      const trimmed = name.trim();
      const path = nextWorkspacePath(
        this.settings.workspaceFiles,
        trimmed,
        (candidate) => this.workspaceFileExists(candidate),
      );
      try {
        await this.app.vault.create(path.endsWith(".md") ? path : `${path}.md`, generateDefaultMarkdown());
      } catch (error) {
        console.error("Workspace file creation failed:", error);
        new Notice(t("workspace.createFailed"));
        return;
      }
      const names = alignWorkspaceNames(this.settings.workspaceFiles, this.settings.workspaceNames);
      this.settings = {
        ...this.settings,
        workspaceFiles: [...this.settings.workspaceFiles, path],
        workspaceNames: [...names, trimmed],
        dashboardFile: path,
      };
      await this.saveSettings();
      await this.repointAllViews();
      new Notice(t("workspace.created", { name: trimmed || path }));
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
      await this.repointAllViews();
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
      if (activeChanged) await this.repointAllViews();
      else this.refreshAllDashboards();
    });
  }

  private runWorkspaceOp(operation: () => Promise<void>): Promise<void> {
    const run = this.workspaceOps.then(operation);
    this.workspaceOps = run.catch((error: unknown) => {
      console.error("Workspace operation failed:", error);
    });
    return run;
  }

  private workspaceFileExists(path: string): boolean {
    return !!this.app.vault.getFileByPath(path.endsWith(".md") ? path : `${path}.md`);
  }

  private async repointAllViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      if (leaf.view instanceof DashboardView) await leaf.view.applyWorkspaceSwitch();
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
      await this.repointAllViews();
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
      await this.repointAllViews();
    });
  }
}

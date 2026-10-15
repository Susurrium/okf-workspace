import type { App, TFile } from 'obsidian';

import type { DashboardSettings } from './types';
import type { TaskInsertTarget } from './daily-notes';
import type { PomodoroService } from './pomodoro-service';
import type { ReadingService } from './reading-service';
import type { DashboardCard, QuickAction } from './types';
import type { VaultTask } from './alltasks-scan';

export type ArtifactMutation =
	| { kind: 'frontmatter'; path: string; artifactType: string; property: string; value: unknown }
	| { kind: 'move'; path: string; artifactType: string; targetPath: string }
	| { kind: 'trash'; path: string; artifactType: string };

export type ArtifactMutationResult =
	| { outcome: 'allow' }
	| { outcome: 'handled'; message?: string }
	| { outcome: 'deny'; message: string };

/**
 * Generic host surface used by the Apex workbench UI and native services.
 *
 * The upstream plugin implements this directly. An embedding plugin can provide
 * an adapter without constructing a second Obsidian Plugin or importing any OKF
 * domain code into the upstream source tree.
 */
export interface ApexHost {
	app: App;
	manifest: { id: string };
	settings: DashboardSettings;
	pomodoroService?: PomodoroService;
	readingService?: ReadingService;
	backupService?: {
		runBackupNow(): Promise<void>;
		restoreLatestNow(): Promise<boolean>;
	};
	saveSettings(): Promise<void>;
	refreshAllDashboards(): void;
	reloadAllDashboards(): Promise<void>;
	switchWorkspace(path: string): Promise<void>;
	workspacePresets?: readonly WorkspacePresetOption[];
	createWorkspace(name: string, presetId?: string): Promise<string | void>;
	createDefaultWorkspaceMarkdown?(): string;
	renameWorkspace(path: string, name: string): Promise<void>;
	removeWorkspace(path: string): Promise<void>;
	reorderWorkspaces(from: number, to: number): Promise<void>;
	retargetWorkspace(oldPath: string, newPath: string): Promise<void>;
	insertCalendarTask?(
		date: string,
		taskLine: string,
		position: 'start' | 'end',
	): Promise<TaskInsertTarget | null>;
	mutateManagedArtifact?(mutation: ArtifactMutation): Promise<ArtifactMutationResult>;
	convertMemoToCapture?(
		workspacePath: string,
		card: DashboardCard,
	): Promise<{ path: string; created: boolean }>;
	createManagedArtifact?(artifactType: string): Promise<boolean>;
	openDocumentImportFromDrop?(transfer: DataTransfer): void;
	executeQuickAction?(action: QuickAction): Promise<boolean>;
	openTodayNote?(): Promise<void>;
	saveTasksToDaily?(block: string): Promise<{ path: string }>;
	editTask?(task: VaultTask): Promise<void>;
	handlesTaskReminders?: boolean;
	checklistsInWorkbenchOnly?: boolean;
	prepareTaskLine?(line: string): string;
	calendarDefaultDate?: 'scheduled' | 'due';
	editTaskDates?(task: VaultTask): void;
	createTask?(date?: string): void;
	openTaskSource?(task: VaultTask): Promise<void>;
	canWriteTaskTarget?(file: TFile): boolean;
	taskStatistics?(excludeFolders?: string[]): Promise<{ totalTasks: number; doneTasks: number; pendingTasks: number; taskCompletion: number }>;
	recentDocumentExclusions?: readonly string[];
}

export interface WorkspacePresetOption {
	id: string;
	label: string;
	description?: string;
}

let registeredHost: ApexHost | null = null;

/** Runtime lookup for modules that Obsidian opens outside a DashboardView. */
export function registerApexHost(host: ApexHost | null): void {
	registeredHost = host;
}

export function getRegisteredApexHost(): ApexHost | null {
	return registeredHost;
}

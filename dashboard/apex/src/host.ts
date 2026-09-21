import type { App } from 'obsidian';

import type { DashboardSettings } from './types';
import type { TaskInsertTarget } from './daily-notes';

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

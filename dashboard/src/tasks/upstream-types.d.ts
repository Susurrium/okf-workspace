declare module '*tasks-generated/core.js' {
  export interface TaskDate { format(pattern: string): string; isValid(): boolean; }
  export interface UpstreamTask {
    readonly path: string;
    readonly lineNumber: number;
    readonly description: string;
    readonly originalMarkdown: string;
    readonly status: { symbol: string; type: string; name: string };
    readonly isDone: boolean;
    readonly priority: string;
    readonly startDate: TaskDate | null;
    readonly scheduledDate: TaskDate | null;
    readonly dueDate: TaskDate | null;
    readonly doneDate: TaskDate | null;
    readonly createdDate: TaskDate | null;
    readonly cancelledDate: TaskDate | null;
    readonly recurrence: { toText(): string } | null;
    readonly id: string;
    readonly dependsOn: string[];
    readonly blockLink: string;
    readonly parent: { description: string; isTask: boolean } | null;
    isBlocked(tasks: readonly UpstreamTask[]): boolean;
    toFileLineString(): string;
    toggleWithRecurrenceInUsersOrder(): UpstreamTask[];
  }
  export interface TaskQueryResult {
    groups: Array<{ groups: string[]; tasks: UpstreamTask[] }>;
    totalTasksCount: number;
    totalTasksCountBeforeLimit: number;
  }
  export function configureTasks(settings?: Record<string, unknown>): Promise<Record<string, unknown>>;
  export function getSettings(): Record<string, unknown> & { globalFilter: string; globalQuery: string; taskFormat: string };
  export function matchesTaskFilter(line: string): boolean;
  export function prepareTaskLine(line: string): string;
  export function readTaskIndex(): UpstreamTask[] | undefined;
  export function parseTaskLine(line: string, path?: string, number?: number, metadata?: Record<string, unknown>): UpstreamTask | null;
  export function taskForEditor(task: UpstreamTask): UpstreamTask;
  export function restoreEditorExtensions(edited: UpstreamTask, original: UpstreamTask): UpstreamTask;
  export function taskDisplayDescription(description: string): string;
  export function changeTaskStatus(line: string, path: string, status: string): string[];
  export function validateTaskDate(value: string): boolean;
  export function cloneTaskLines(lines: string[], path: string): string[];
  export function taskStatusTypes(): Record<string, string>;
  export function applyTaskStatusTypes(types: Record<string, string>): void;
  export function setTaskSourceFilter(filter?: (path: string) => boolean): void;
  export function indexTaskFile(file: import('obsidian').TFile, content: string, metadata: import('obsidian').CachedMetadata,
    items: import('obsidian').ListItemCache[]): UpstreamTask[];
  export function executeTaskQuery(source: string, tasks: UpstreamTask[], path?: string, metadata?: Record<string, unknown>, scope?: string[]): TaskQueryResult;
}

declare module '*tasks-generated/plugin.js' {
  import type { Plugin, SettingDefinitionItem } from 'obsidian';
  import type { UpstreamTask } from '*tasks-generated/core.js';
  export interface TasksRuntime {
    apiV1: {
      createTaskLineModal(): Promise<string>;
      editTaskLineModal(line: string): Promise<string>;
      executeToggleTaskDoneCommand(line: string, path: string): string;
    };
    refresh(): Promise<void>;
    settingsDefinitions(): SettingDefinitionItem[];
    displaySettings(container: HTMLElement): void;
    getTasks(): UpstreamTask[];
    editDates(title: string, values: Record<string, string>, submit: (values: Record<string, string>) => Promise<void>): void;
    editTask(line: string, path: string, submit: (lines: string[], target?: string) => Promise<void>, context?: {
      isNew?: boolean; target?: string; targetHint?: string;
      courses?: ReadonlyArray<{ path: string; title: string }>; projects?: ReadonlyArray<{ path: string; title: string }>;
      targets?: ReadonlyArray<{ path: string; title: string }>; inheritedCourse?: string; inheritedProject?: string;
      openSource?: () => void; beforeApply?: (target?: string) => Promise<void>;
    }): void;
  }
  export function installTasks(owner: Plugin, options: {
    settings: Record<string, unknown>;
    save(settings: Record<string, unknown>): Promise<void>;
    onError(error: unknown): void;
    invalidate(path?: string): void;
    writeTask(task: { path: string; lineNumber: number; originalMarkdown: string }, lines: string[]): Promise<void>;
  }): Promise<TasksRuntime>;
}

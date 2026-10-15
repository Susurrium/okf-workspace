import TasksPlugin from '../vendor/tasks/src/main';
import { TasksEvents } from '../vendor/tasks/src/Obsidian/TasksEvents';
import { SettingsTab } from '../vendor/tasks/src/Config/SettingsTab';
import { configureTasks, getSettings } from './core-entry';
import { parseTaskLine, setTaskIndexReader } from './core-entry';
import { TaskModal } from './task-modal';
import type { TaskEditorContext } from './editor-context';
import { TaskDatesModal } from './task-dates-modal';
import type { Plugin, PluginSettingTab } from 'obsidian';
import { setTaskWriter } from './task-file';

export async function installTasks(owner: Plugin, options: {
  settings: Record<string, unknown>;
  save(settings: object): Promise<void>;
  onError(error: unknown): void;
  invalidate(path?: string): void;
  writeTask(task: { path: string; lineNumber: number; originalMarkdown: string }, lines: string[]): Promise<void>;
}) {
  await configureTasks(options.settings);
  setTaskWriter(options.writeTask);
  owner.register(() => setTaskWriter(undefined));
  class IntegratedTasks extends TasksPlugin {
    settingsTab!: SettingsTab;
    ready!: Promise<void>;
    override async loadSettings() { await configureTasks(options.settings); }
    override addSettingTab(tab: PluginSettingTab) { this.settingsTab = tab as SettingsTab; }
    async saveSettings() {
      await configureTasks({ ...getSettings() });
      await options.save(getSettings());
      await this.refreshTasks();
    }
    override onload() {
      this.ready = super.onload();
      return this.ready;
    }
  }
  const runtime = new IntegratedTasks(owner.app, { ...owner.manifest, name: '待办' });
  owner.register(() => runtime.unload());
  runtime.load();
  await runtime.ready;
  setTaskIndexReader(() => runtime.getTasks());
  owner.register(() => setTaskIndexReader(undefined));
  const events = new TasksEvents({ obsidianEvents: owner.app.workspace });
  owner.registerEvent(events.onCacheUpdate(() => options.invalidate()));
  return {
    apiV1: runtime.apiV1,
    refresh: () => runtime.refreshTasks(),
    settingsDefinitions: () => runtime.settingsTab.getSettingDefinitions(),
    displaySettings: (container: HTMLElement) => { runtime.settingsTab.containerEl = container; runtime.settingsTab.display(); },
    getTasks: () => runtime.getTasks(),
    editDates: (title: string, values: Record<string, string>, submit: (values: Record<string, string>) => Promise<void>) => {
      new TaskDatesModal(owner.app, title, values, submit).open();
    },
    editTask: (line: string, path: string, submit: (lines: string[], target?: string) => Promise<void>, editorContext?: TaskEditorContext) => {
      const task = parseTaskLine(line, path);
      if (!task) throw new Error('任务格式无效');
      const modal = new TaskModal({ app: owner.app, task, allTasks: runtime.getTasks(),
        editorContext, onSaveSettings: () => runtime.saveSettings(), onSubmit: (updated, target) => submit(updated.map(task => task.toFileLineString()), target) });
      modal.open();
    },
  };
}

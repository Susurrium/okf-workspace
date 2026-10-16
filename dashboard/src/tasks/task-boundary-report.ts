import { Modal, TFile, type App } from 'obsidian';
import { scanFileTasks } from '../../apex/src/alltasks-scan.js';

export interface TaskBoundaryReport {
  workbenchTasks: Array<{ path: string; line: number; markdown: string }>;
  settingDifferences: Array<{ key: string; current: unknown; original: unknown }>;
}

export async function readTaskBoundaryReport(app: App, settings: Record<string, unknown>): Promise<TaskBoundaryReport> {
  const workbenchTasks: TaskBoundaryReport['workbenchTasks'] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (file.path.split('/').some(part => part.startsWith('.'))) continue;
    const text = await app.vault.read(file);
    for (const task of scanFileTasks(file, text)) if (task.checklist && /(?:^|\s)#task(?=\s|$)/iu.test(task.originalLine)) {
      workbenchTasks.push({ path: file.path, line: task.line, markdown: task.originalLine });
    }
  }
  const settingDifferences: TaskBoundaryReport['settingDifferences'] = [];
  const path = `${app.vault.configDir}/plugins/obsidian-tasks-plugin/data.json`;
  if (await app.vault.adapter.exists(path)) {
    const original: unknown = JSON.parse(await app.vault.adapter.read(path));
    if (!original || typeof original !== 'object' || Array.isArray(original)) throw new Error('原 Tasks 配置必须为对象');
    for (const [key, value] of Object.entries(original)) if (JSON.stringify(settings[key]) !== JSON.stringify(value)) {
      settingDifferences.push({ key, current: settings[key], original: value });
    }
  }
  return { workbenchTasks, settingDifferences };
}

export class TaskBoundaryReportModal extends Modal {
  constructor(app: App, private readonly report: TaskBoundaryReport) { super(app); }
  onOpen(): void {
    this.titleEl.setText('任务范围与历史配置检查');
    this.contentEl.createEl('p', { text: `工作台中带历史任务标记的条目：${this.report.workbenchTasks.length} 项。需要继续由 Tasks 管理的条目应明确迁移到普通笔记。` });
    for (const task of this.report.workbenchTasks) {
      const button = this.contentEl.createEl('button', { text: `${task.path}:${task.line + 1} · ${task.markdown}`, attr: { type: 'button' } });
      button.addEventListener('click', () => {
        const file = this.app.vault.getAbstractFileByPath(task.path);
        if (file instanceof TFile) void this.app.workspace.getLeaf('tab').openFile(file, { eState: { line: task.line } });
      });
    }
    this.contentEl.createEl('p', { text: `与原独立 Tasks 配置存在差异的字段：${this.report.settingDifferences.length} 项。` });
    for (const item of this.report.settingDifferences) {
      const details = this.contentEl.createEl('details');
      details.createEl('summary', { text: item.key });
      details.createEl('pre', { text: JSON.stringify({ current: item.current, original: item.original }, null, 2) });
    }
  }
}

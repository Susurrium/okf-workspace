import { Notice } from 'obsidian';
import { mount, unmount } from 'svelte';
import { TaskModal as UpstreamModal, type TaskModalParams } from '../vendor/tasks/src/Obsidian/TaskModal';
import { Task } from '../vendor/tasks/src/Task/Task';
import { taskForEditor, taskDisplayDescription, restoreEditorExtensions, editorTaskWithDescription, validateTaskDate } from './core-entry';
import TaskEditor from './TaskContextEditor.svelte';
import { OptionsModal } from '../vendor/tasks/src/Obsidian/OptionsModal';
import type { TaskEditorContext } from './editor-context';
import { StatusRegistry } from '../vendor/tasks/src/Statuses/StatusRegistry';
import { applyModalTheme } from '../apex/src/modal-theme';

export interface WorkbenchTaskModalParams extends Omit<TaskModalParams, 'onSubmit'> {
  onSubmit(tasks: Task[], target?: string): void | Promise<void>;
  editorContext?: TaskEditorContext;
}

export class TaskModal extends UpstreamModal {
  private submitting = false;
  private settled = false;
  private readonly original: Task;
  private readonly draft: Record<string, string>;
  private readonly initial: Record<string, string>;
  private readonly parameters: WorkbenchTaskModalParams;
  private component: ReturnType<typeof mount> | undefined;

  constructor(parameters: WorkbenchTaskModalParams) {
    super({ ...parameters, task: taskForEditor(parameters.task) });
    this.original = parameters.task;
    this.parameters = parameters;
    const description = this.original.description;
    this.draft = {
      reminder: /⏰\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/u.exec(description)?.[1] ?? '',
      end: /\[end::\s*([^\]]+)\]/u.exec(description)?.[1] ?? /🛬\s*(\d{4}-\d{2}-\d{2})/u.exec(description)?.[1] ?? '',
      project: /\[project::\s*([^\]]+)\]/u.exec(description)?.[1]?.trim() ?? '',
      course: /\[course::\s*([^\]]+)\]/u.exec(description)?.[1]?.trim() ?? '',
    };
    for (const key of ['start', 'scheduled', 'due', 'completion']) this.draft[key] = new RegExp(`\\[okf-${key}-time::\\s*(\\d{2}:\\d{2})\\]`, 'u').exec(description)?.[1] ?? '';
    this.initial = { ...this.draft };
    Object.defineProperty(this, 'onSubmit', { value: (updated: Task[]) => { void this.submit(updated).catch(error => new Notice(String(error))); } });
  }

  override onOpen(): void {
    this.modalEl.addClass('tasks-edit-modal-container', 'okf-task-editor-modal');
    applyModalTheme(this.modalEl);
    this.modalEl.createEl('button', { text: '编辑选项', attr: { type: 'button' } }).addEventListener('click', () =>
      new OptionsModal({ app: this.app, onSave: this.parameters.onSaveSettings }).open());
    this.titleEl.setText(this.parameters.editorContext?.isNew || !taskDisplayDescription(this.original.description) ? '新建任务' : '任务详情');
    const context = this.parameters.editorContext ?? this.defaultContext();
    this.component = mount(TaskEditor, { target: this.contentEl, props: {
      task: taskForEditor(this.original), allTasks: this.allTasks, extensions: this.draft, context,
      statusOptions: this.getTaskStatusOptions(), onSubmit: (tasks: Task[]) => this.submit(tasks),
      onCancel: () => { this.close(); }, validate: async () => {
        for (const key of ['course', 'project']) {
          const path = this.draft[key]?.replace(/^\//u, '');
          if (path && (context.isNew || this.draft[key] !== this.initial[key])) {
            if (!(key === 'project' ? /^projects\/[^/]+\/project\.md$/u : /^learning\/courses\/[^/]+\/course\.md$/u).test(path)) throw new Error('课程或项目关联路径无效');
            if (!this.app.vault.getAbstractFileByPath(path)) throw new Error(`关联目标不存在：${path}`);
          }
        }
        if (context.beforeApply) await context.beforeApply(context.target);
      },
    } });
    this.contentEl.querySelector<HTMLTextAreaElement>('#description')?.focus();
  }

  private getTaskStatusOptions() {
    const statuses = this.allTasks.flatMap(task => [task.status]);
    const registry = this.parameters.task.status;
    // 状态选项来自注册表，保留用户自定义状态及当前未知状态。
    return [...new Map([...StatusRegistry.getInstance().registeredStatuses, ...statuses, registry].map(status => [status.symbol, status])).values()];
  }

  private defaultContext(): TaskEditorContext {
    const files = this.app.vault.getMarkdownFiles();
    const choices = files.map(file => ({ path: file.path, title: String(this.app.metadataCache.getFileCache(file)?.frontmatter?.title ?? file.basename) }));
    return { courses: choices.filter(item => /^learning\/courses\/[^/]+\/course\.md$/u.test(item.path)),
      projects: choices.filter(item => /^projects\/[^/]+\/project\.md$/u.test(item.path)) };
  }

  private async submit(updated: Task[]): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    try {
      if (this.parameters.editorContext?.beforeApply) await this.parameters.editorContext.beforeApply(this.parameters.editorContext.target);
      const restored = updated.map(task => {
        if (!taskDisplayDescription(task.description)) throw new Error('请填写任务内容');
        const value = restoreEditorExtensions(task, this.original);
        let description = value.description;
        for (const [key, input] of Object.entries(this.draft)) {
          if (input === this.initial[key]) continue;
          if (['project', 'course'].includes(key)) {
            const value = input.replace(/^\//u, '');
            if (value && !(key === 'project' ? /^projects\/[^/]+\/project\.md$/u : /^learning\/courses\/[^/]+\/course\.md$/u).test(value)) throw new Error('课程或项目笔记路径无效');
            description = description.replace(new RegExp(`\\s*\\[${key}::[^\\]]+\\]`, 'gu'), '');
            if (value) description += ` [${key}:: /${value}]`;
          } else if (['reminder', 'end'].includes(key)) {
            if (input && !validateTaskDate(input)) throw new Error(`${key === 'reminder' ? '提醒' : '结束'}时间无效`);
            description = description.replace(key === 'reminder' ? /\s*⏰\s*\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?/u : /\s*(?:\[end::[^\]]+\]|🛬\s*\d{4}-\d{2}-\d{2})/u, '');
            if (input) description += key === 'reminder' ? ` ⏰ ${input}` : ` [end:: ${input}]`;
          } else {
            if (input && !/^([01]\d|2[0-3]):[0-5]\d$/u.test(input)) throw new Error('时间必须为有效的 HH:MM');
            const date = key === 'start' ? task.startDate : key === 'due' ? task.dueDate : key === 'completion' ? task.doneDate : task.scheduledDate;
            if (input && !date) throw new Error('请先选择对应日期');
            description = description.replace(new RegExp(`\\s*\\[okf-${key}-time::[^\\]]+\\]`, 'gu'), '');
            if (input) description += ` [okf-${key}-time:: ${input}]`;
          }
        }
        if (this.draft.end && task.startDate && this.draft.end.slice(0, 10) < task.startDate.format('YYYY-MM-DD')) throw new Error('结束日期不能早于开始日期');
        const unresolved = this.original.dependsOn.filter(id => !this.allTasks.some(item => item.id === id));
        return editorTaskWithDescription(value, description, [...new Set([...value.dependsOn, ...unresolved])]);
      });
      await this.parameters.onSubmit(restored, this.parameters.editorContext?.target);
      this.settled = true;
      this.close();
    } finally { this.submitting = false; }
  }

  override onClose(): void {
    super.onClose();
    if (this.component) { void unmount(this.component); this.component = undefined; }
    if (!this.settled) this.parameters.onCancel?.();
  }
}

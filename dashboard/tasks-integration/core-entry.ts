import { Task } from '../vendor/tasks/src/Task/Task';
import { TaskLocation } from '../vendor/tasks/src/Task/TaskLocation';
import { TasksFile } from '../vendor/tasks/src/Scripting/TasksFile';
import { Query } from '../vendor/tasks/src/Query/Query';
import { getQueryForQueryRenderer } from '../vendor/tasks/src/Query/QueryRendererHelper';
import { GlobalQuery } from '../vendor/tasks/src/Config/GlobalQuery';
import { GlobalFilter } from '../vendor/tasks/src/Config/GlobalFilter';
import { getSettings, updateSettings, resetSettings } from '../vendor/tasks/src/Config/Settings';
import { StatusSettings } from '../vendor/tasks/src/Config/StatusSettings';
import { StatusRegistry } from '../vendor/tasks/src/Statuses/StatusRegistry';
import { Status } from '../vendor/tasks/src/Statuses/Status';
import { initializeI18n } from '../vendor/tasks/src/i18n/i18n';
import { DefaultTaskSerializer, DEFAULT_SYMBOLS } from '../vendor/tasks/src/TaskSerializer/DefaultTaskSerializer';
import { DataviewTaskSerializer } from '../vendor/tasks/src/TaskSerializer/DataviewTaskSerializer';
import { Filter } from '../vendor/tasks/src/Query/Filter/Filter';
import { Explanation } from '../vendor/tasks/src/Query/Explain/Explanation';
import { StatusConfiguration, StatusType } from '../vendor/tasks/src/Statuses/StatusConfiguration';
import { FileParser } from '../vendor/tasks/src/Obsidian/FileParser';
import { logging } from '../vendor/tasks/src/lib/logging';
import type { CachedMetadata, ListItemCache, TFile } from 'obsidian';
import { taskHost } from '../vendor/tasks/src/TaskHost';
import type { TaskSerializer } from '../vendor/tasks/src/TaskSerializer';

const emoji = new DefaultTaskSerializer(DEFAULT_SYMBOLS);
const dataview = new DataviewTaskSerializer();
const occurrenceShifts = new WeakMap<Task, number>();
export function setTaskSourceFilter(filter?: (path: string) => boolean): void { taskHost.acceptsSource = filter; }
let indexReader: (() => Task[] | undefined) | undefined;
export function setTaskIndexReader(reader?: () => Task[] | undefined): void { indexReader = reader; }
export function readTaskIndex(): Task[] | undefined { return indexReader?.(); }
const dateSymbols = { start: '🛫', due: '📅', scheduled: '⏳', completion: '✅', created: '➕', cancelled: '❌' };
const extras = /\s*(?:⏰\s*\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?|🛬\s*\d{4}-\d{2}-\d{2}|\[(?:end|project|course)::[^\]]+\]|\[okf-(?:start|due|scheduled|completion)-time::[^\]]+\]|<!--collapsed-->)/gu;

// 日期、状态、循环和查询交给上游；这里只处理工作台扩展与已有内联字段。
class ExtensionSerializer implements TaskSerializer {
  constructor(private readonly selected: TaskSerializer) {}
  deserialize(body: string) {
    const retained: string[] = [];
    let normalized = body.replace(extras, value => { retained.push(value.trim()); return ''; });
    // 原生 Dataview 内容保持上游解析，包括括号形式；只提取时间扩展。
    if (this.selected instanceof DataviewTaskSerializer && !/[📅🛫⏳✅➕❌🔁🔺⏫🔼🔽⏬🆔⛔🏁]/u.test(normalized)) {
      normalized = normalized.replace(/(\[(start|due|scheduled|completion)::\s*\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(\s*\])/giu,
        (_full, prefix: string, name: string, time: string, suffix: string) => {
          retained.push(`[okf-${name.toLowerCase()}-time:: ${time}]`);
          return prefix + suffix;
        });
      const details = this.selected.deserialize(normalized);
      details.description = [details.description.trim(), ...retained].filter(Boolean).join(' ');
      return details;
    }
    const fields: string[] = [];
    normalized = normalized.replace(/\[(start|due|scheduled|completion|created|cancelled)::\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s*\]/giu,
      (_full, name: string, date: string, time: string) => {
        const key = name.toLowerCase() as keyof typeof dateSymbols;
        fields.push(`${dateSymbols[key]} ${date}`);
        if (time) retained.push(`[okf-${key}-time:: ${time}]`);
        return '';
      });
    normalized = normalized.replace(/\[(priority|repeat|id|dependsOn|onCompletion)::[^\]]+\]/gu, value => {
      const legacyPriority = /^\[priority::\s*([^\]]+)\]$/u.exec(value)?.[1]?.trim().toLowerCase();
      if (legacyPriority) {
        const aliases = { hi: 'high', h: 'high', urgent: 'high', u: 'high', '1': 'high', '!!!': 'high', p1: 'high',
          mid: 'medium', m: 'medium', normal: 'medium', n: 'medium', '2': 'medium', '!!': 'medium', p2: 'medium',
          l: 'low', 'low-priority': 'low', '3': 'low', '!': 'low', p3: 'low' };
        value = `[priority:: ${aliases[legacyPriority as keyof typeof aliases] ?? legacyPriority}]`;
      }
      const details = dataview.deserialize(value);
      fields.push(emoji.serialize(new Task({ ...details, status: Status.TODO, taskLocation: TaskLocation.fromUnknownPosition(new TasksFile('')),
        indentation: '', listMarker: '-', blockLink: '', originalMarkdown: '', scheduledDateIsInferred: false })));
      return '';
    });
    const details = emoji.deserialize(`${normalized.trim()} ${fields.join(' ')}`.trim());
    details.description = [details.description.trim(), ...retained].filter(Boolean).join(' ');
    return details;
  }

  serialize(task: Task): string {
    const shift = occurrenceShifts.get(task) ?? 0;
    const description = shift ? task.description.replace(/(⏰\s*|🛬\s*|\[end::\s*)(\d{4}-\d{2}-\d{2})/gu,
      (_match, prefix: string, date: string) => `${prefix}${window.moment(date, 'YYYY-MM-DD', true).add(shift, 'days').format('YYYY-MM-DD')}`) : task.description;
    return this.selected.serialize(shift ? new Task({ ...task, description }) : task);
  }
}

const serializers = new WeakMap<TaskSerializer, TaskSerializer>();
taskHost.serializer = selected => {
  if (!serializers.has(selected)) serializers.set(selected, new ExtensionSerializer(selected));
  return serializers.get(selected)!;
};
taskHost.nextOccurrence = (previous, next) => {
  const before = previous.scheduledDate ?? previous.dueDate ?? previous.startDate;
  const after = next.scheduledDate ?? next.dueDate ?? next.startDate;
  const shift = before && after ? after.diff(before, 'days') : 0;
  occurrenceShifts.set(next, shift);
  return next;
};

export async function configureTasks(settings: Record<string, unknown> = {}) {
  await initializeI18n();
  resetSettings();
  updateSettings(settings);
  const configured = getSettings();
  GlobalFilter.getInstance().set(configured.globalFilter);
  GlobalFilter.getInstance().setRemoveGlobalFilter(configured.removeGlobalFilter);
  GlobalQuery.getInstance().set(configured.globalQuery);
  StatusSettings.applyToStatusRegistry(configured.statusSettings, StatusRegistry.getInstance());
  return configured;
}

export function matchesTaskFilter(line: string): boolean { return GlobalFilter.getInstance().includedIn(Task.extractTaskComponents(line)?.body ?? line); }
export function prepareTaskLine(line: string): string {
  const filter = getSettings().globalFilter;
  if (!filter || GlobalFilter.getInstance().includedIn(line)) return line;
  return line.replace(/^(\s*[-*+][\t ]+\[.\]\s*)/u, (_prefix, prefix: string) => `${prefix}${filter} `);
}

export function parseTaskLine(line: string, path = '', number = 0, metadata = {}) {
  return Task.parseTaskSignifiers(line.replace(/\s*<!--collapsed-->\s*$/u, ''),
    new TaskLocation(new TasksFile(path, { frontmatter: metadata }), number, 0, number, null), null);
}

export function indexTaskFile(file: TFile, content: string, metadata: CachedMetadata, items: ListItemCache[]): Task[] {
  const tasksFile = new TasksFile(file.path, metadata, file);
  return new FileParser(tasksFile, content, items, logging.getLogger('tasks.WorkbenchIndex'), error => {
    throw new Error(`无法解析任务：${file.path}`, { cause: error });
  }).parseFileContent();
}

export function changeTaskStatus(line: string, path: string, status: string): string[] {
  const task = parseTaskLine(line, path);
  if (!task) throw new Error('任务格式无效');
  const nextStatus = StatusRegistry.getInstance().bySymbolOrCreate(status);
  return task.handleNewStatusWithRecurrenceInUsersOrder(nextStatus).map(next => next.toFileLineString());
}

export function executeTaskQuery(source: string, tasks: Task[], path = '', metadata = {}, scope?: string[]) {
  const query = getQueryForQueryRenderer(source, GlobalQuery.getInstance(), new TasksFile(path, metadata));
  if (query.error) throw new Error(query.error);
  if (scope) {
    const allowed = new Set(scope);
    query.addFilter(new Filter('当前工作台范围', task => allowed.has(`${task.path}:${task.lineNumber}`), new Explanation('当前工作台范围')));
  }
  const result = query.applyQueryToTasks(tasks);
  if (result.searchErrorMessage) throw new Error(result.searchErrorMessage);
  return result;
}

export { Task, TasksFile, TaskLocation, Query, getSettings, StatusRegistry };

export function taskStatusTypes(): Record<string, string> {
  return Object.fromEntries(StatusRegistry.getInstance().registeredStatuses.map(status => [status.symbol, status.type]));
}

export function applyTaskStatusTypes(types: Record<string, string>): void {
  const allowed = new Set(['TODO', 'DONE', 'CANCELLED', 'IN_PROGRESS', 'ON_HOLD', 'NON_TASK']);
  for (const [symbol, type] of Object.entries(types)) {
    if (symbol.length !== 1 || !allowed.has(type)) throw new Error(`任务状态配置无效：${symbol}`);
  }
  if (types[' '] && types[' '] !== 'TODO' || types.x && types.x !== 'DONE') throw new Error('标准复选框必须使用 TODO 和 DONE 状态');
  const settings = getSettings();
  const update = (status: StatusConfiguration): StatusConfiguration => ({ ...status, type: (types[status.symbol] ?? status.type) as StatusType });
  const coreStatuses = settings.statusSettings.coreStatuses.map(update);
  const customStatuses = settings.statusSettings.customStatuses.map(update);
  const known = new Set([...coreStatuses, ...customStatuses].map(status => status.symbol));
  for (const [symbol, type] of Object.entries(types)) if (!known.has(symbol)) {
    customStatuses.push(new StatusConfiguration(symbol, symbol, type === 'DONE' ? ' ' : 'x', true, type as StatusType));
  }
  updateSettings({ statusSettings: { coreStatuses, customStatuses } });
  StatusSettings.applyToStatusRegistry(getSettings().statusSettings, StatusRegistry.getInstance());
}

export function validateTaskDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/u.test(value)
    && window.moment(value, value.length > 10 ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD', true).isValid();
}

export function cloneTaskLines(lines: string[], path: string): string[] {
  const parsed = lines.map(line => parseTaskLine(line, path));
  if (parsed.some(task => !task)) throw new Error('清单包含无法识别的任务');
  const ids = new Map(parsed.filter(task => task!.id).map(task => [task!.id, crypto.randomUUID()]));
  return parsed.map(task => new Task({ ...task!, id: ids.get(task!.id) ?? task!.id,
    dependsOn: task!.dependsOn.map(id => ids.get(id) ?? id), blockLink: ` ^task-${crypto.randomUUID()}` }).toFileLineString());
}

export function taskForEditor(task: Task): Task {
  return copyEditorTask(task, task.description.replace(extras, ' ').replace(/\s+/gu, ' ').trim());
}

export function taskDisplayDescription(description: string): string {
  return GlobalFilter.getInstance().removeAsWordFrom(description.replace(extras, ' ')).replace(/\s+/gu, ' ').trim();
}

export function restoreEditorExtensions(edited: Task, original: Task): Task {
  const retained = original.description.match(extras)?.map(value => value.trim()) ?? [];
  const restored = copyEditorTask(edited, [edited.description, ...retained].filter(Boolean).join(' '));
  if (occurrenceShifts.has(edited)) occurrenceShifts.set(restored, occurrenceShifts.get(edited)!);
  return restored;
}

export function editorTaskWithDescription(task: Task, description: string, dependsOn = task.dependsOn): Task {
  const edited = copyEditorTask(task, description, dependsOn);
  if (occurrenceShifts.has(task)) occurrenceShifts.set(edited, occurrenceShifts.get(task)!);
  return edited;
}

function copyEditorTask(task: Task, description: string, dependsOn = task.dependsOn): Task {
  const copy = new Task({ ...task, description, dependsOn, parent: null });
  Object.defineProperty(copy, 'parent', { value: task.parent });
  Object.defineProperty(copy, 'children', { value: [...task.children] });
  return copy;
}

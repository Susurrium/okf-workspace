import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import type { VaultTask } from './alltasks-scan';
import { getRegisteredApexHost } from './host';

export interface CalendarScope {
  calendarTaskState: 'open' | 'all' | 'done' | 'cancelled';
  calendarDateFact: 'all' | 'scheduled' | 'due' | 'start' | 'reminder' | 'span';
  course?: string;
  project?: string;
}

export function readCalendarScope(raw: Record<string, unknown> = {}): CalendarScope {
  const state = raw.calendarTaskState ?? (getRegisteredApexHost()?.calendarDefaultDate === 'scheduled' ? 'open' : 'all');
  const fact = raw.calendarDateFact ?? 'all';
  if (typeof state !== 'string' || typeof fact !== 'string' || !['open', 'all', 'done', 'cancelled'].includes(state) || !['all', 'scheduled', 'due', 'start', 'reminder', 'span'].includes(fact)) throw new Error('日历范围配置无效');
  return { calendarTaskState: state as CalendarScope['calendarTaskState'], calendarDateFact: fact as CalendarScope['calendarDateFact'],
    course: typeof raw.course === 'string' ? raw.course : undefined, project: typeof raw.project === 'string' ? raw.project : undefined };
}

export function filterCalendarScope(byDay: Map<string, VaultTask[]>, scope: CalendarScope): Map<string, VaultTask[]> {
  const path = (value?: string) => value?.replace(/^\//u, '');
  const result = new Map<string, VaultTask[]>();
  for (const [day, tasks] of byDay) {
    const visible = tasks.filter(task => task.eligible !== false && (!scope.course || path(task.course) === path(scope.course)) && (!scope.project || path(task.project) === path(scope.project))
      && (scope.calendarTaskState === 'all' || scope.calendarTaskState === 'open' ? scope.calendarTaskState === 'all' || !task.checked
        : task.statusType === (scope.calendarTaskState === 'done' ? 'DONE' : 'CANCELLED'))
      && (scope.calendarDateFact === 'all' || scope.calendarDateFact === 'reminder' ? scope.calendarDateFact === 'all' || task.reminder?.slice(0, 10) === day
        : scope.calendarDateFact === 'span' ? Boolean(task.start && task.end && task.start <= day && task.end >= day) : task[scope.calendarDateFact] === day));
    if (visible.length) result.set(day, visible);
  }
  return result;
}

export function calendarScopeControls(parent: HTMLElement, app: App, initial: CalendarScope,
  save: (scope: CalendarScope) => void | Promise<void>, contexts = false): void {
  const host = parent.createDiv({ cls: 'okf-calendar-filters' });
  let current = { ...initial };
  const select = (name: string, key: keyof CalendarScope, choices: Record<string, string>) => {
    const label = host.createEl('label'); label.createSpan({ text: name });
    const input = label.createEl('select', { attr: { 'aria-label': `日历${name}` } });
    for (const [value, text] of Object.entries(choices)) input.createEl('option', { text, attr: { value } });
    if (current[key] && !Object.hasOwn(choices, current[key])) input.createEl('option', { text: `${current[key]}（保留当前范围）`, attr: { value: current[key] } });
    input.value = current[key] ?? '';
    input.addEventListener('change', () => {
      const previous = { ...current }; current = { ...current, [key]: input.value };
      input.disabled = true;
      void Promise.resolve().then(() => save(current)).catch(error => { current = previous; input.value = current[key] ?? ''; new Notice(error instanceof Error ? error.message : '日历范围保存失败'); })
        .finally(() => { input.disabled = false; });
    });
  };
  select('状态', 'calendarTaskState', { open: '未完成', all: '全部状态', done: '已完成', cancelled: '已取消' });
  select('按日期类型显示', 'calendarDateFact', { all: '全部日期', scheduled: '计划日期', due: '截止日期', reminder: '提醒日期', start: '开始日期', span: '跨日安排' });
  if (contexts) {
    const choices = app.vault.getMarkdownFiles().map(file => ({ path: file.path, title: String(app.metadataCache.getFileCache(file)?.frontmatter?.title ?? file.basename) }));
    select('课程', 'course', { '': '全部课程范围', ...Object.fromEntries(choices.filter(item => /^learning\/courses\/[^/]+\/course\.md$/u.test(item.path)).map(item => [item.path, item.title])) });
    select('项目', 'project', { '': '全部项目范围', ...Object.fromEntries(choices.filter(item => /^projects\/[^/]+\/project\.md$/u.test(item.path)).map(item => [item.path, item.title])) });
  }
}

export function calendarTimeEvents(byDay: Map<string, VaultTask[]>, fact: CalendarScope['calendarDateFact'] = 'all'): Map<string, VaultTask[]> {
  return new Map([...byDay].map(([day, tasks]) => [day, tasks.flatMap(task => {
    const kinds: NonNullable<VaultTask['calendarEventKind']>[] = [];
    if (task.reminder?.slice(0, 10) === day) kinds.push('reminder');
    if (task.scheduled === day) kinds.push('scheduled');
    if (task.due === day) kinds.push('due');
    if (task.completion === day) kinds.push('completion');
    if (task.cancelled === day) kinds.push('cancelled');
    if (task.start && (task.start === day || task.end && task.start <= day && task.end >= day) || task.end === day) kinds.push('span');
    const selected = kinds.filter(kind => fact === 'all' || kind === fact || (fact === 'start' || fact === 'span') && kind === 'span');
    return selected.length ? selected.map(calendarEventKind => ({ ...task, calendarEventKind })) : [task];
  })]));
}

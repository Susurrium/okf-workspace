import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TFile, type App } from 'obsidian';
import { configureTasks, getSettings, parseTaskLine, prepareTaskLine, executeTaskQuery, setTaskSourceFilter, taskForEditor, restoreEditorExtensions } from '../tasks-generated/core.js';
import { scanFileTasks, collectVaultTasks, toggleTaskInFile, replaceTaskInFile, updateTaskDatesInFile } from '../apex/src/alltasks-scan.js';
import { taskSourceKind, readTaskSourceKind } from '../apex/src/task-source.js';
import { parse, serialize, generateDefaultMarkdown } from '../apex/src/parser.js';
import { transitionTaskItem, recalcChecked } from '../apex/src/task-tree.js';
import { readTaskBoundaryReport } from '../src/tasks/task-boundary-report.js';
import { SyncEngine } from '../apex/src/sync.js';
import { DEFAULT_SETTINGS } from '../apex/src/types.js';
import { registerApexHost } from '../apex/src/host.js';
import { VaultNoteService } from '../src/plugin/vault-note-service.js';

const file = (path: string) => new (TFile as unknown as new (path: string) => TFile)(path);
beforeEach(async () => { setTaskSourceFilter(); await configureTasks(); });
afterEach(() => { setTaskSourceFilter(); registerApexHost(null); });

describe('Tasks and workbench checklist boundaries', () => {
  it('preserves empty and custom filters, without imposing a task tag', async () => {
    expect(getSettings().globalFilter).toBe('');
    expect(scanFileTasks(file('notes.md'), '- [ ] Small task')[0]?.formal).toBe(true);
    expect(prepareTaskLine('- [ ] Action')).toBe('- [ ] Action');
    await configureTasks({ globalFilter: '#todo', taskFormat: 'dataview', isShownInEditModal: { due: false } });
    expect(getSettings()).toMatchObject({ globalFilter: '#todo', taskFormat: 'dataview', isShownInEditModal: { due: false } });
    expect(prepareTaskLine('- [ ] Action')).toBe('- [ ] #todo Action');
    const tasks = scanFileTasks(file('notes.md'), '- [ ] #task Other\n- [ ] #todo Action');
    expect(tasks.filter(task => task.formal).map(task => task.text)).toEqual(['Action']);
  });

  it('honours native Dataview serialization and parenthesized fields', async () => {
    await configureTasks({ taskFormat: 'dataview' });
    const task = parseTaskLine('- [ ] Action (due:: 2026-10-20)')!;
    expect(task.dueDate?.format('YYYY-MM-DD')).toBe('2026-10-20');
    const completed = task.toggleWithRecurrenceInUsersOrder()[0]!.toFileLineString();
    expect(completed).toContain('[due:: 2026-10-20]');
    expect(completed).toContain('[completion::');
    expect(completed).not.toContain('📅');
    expect(parseTaskLine('- [ ] Action [due:: 2026-10-20 09:30]')!.toFileLineString()).toContain('[okf-due-time:: 09:30]');
  });

  it('excludes every workbench regardless of path, filename, marker, or schema version', () => {
    for (const path of ['中文工作台.md', 'boards/other.md', 'boards/index.md']) {
      const tasks = scanFileTasks(file(path), '---\ndashboard: true\nworkbench_schema: 99\n---\n- [ ] #task Action 🔁 every week ⏳ 2026-10-20');
      expect(tasks[0]).toMatchObject({ formal: false, checklist: true });
    }
    expect(() => taskSourceKind('board.md', { dashboard: 'true' })).toThrow('布尔值');
    expect(() => taskSourceKind('board.md', { dashboard: true, type: 'Project' })).toThrow('身份冲突');
    expect(taskSourceKind('.dashboard-backup/board.md', { dashboard: true })).toBe('excluded');
    expect(() => readTaskSourceKind('board.md', '---\ndashboard: true\n- [ ] Action')).toThrow('结束标记');
    expect(readTaskSourceKind('board.md', '\uFEFF---\ndashboard: true\n---\n')).toBe('checklists');
  });

  it('keeps Apex parsing and transitions independent of Tasks settings and recurrence', () => {
    const board = parse(generateDefaultMarkdown());
    const card = board.columns.flatMap(column => column.cards).find(candidate => candidate.tasks.length)!;
    card.tasks = [{ text: '#task Checklist 🔁 every week ⏳ 2026-10-20', checked: false, children: [{ text: 'Child', checked: false }] }];
    const checked = transitionTaskItem(card.tasks[0]!, true);
    expect(checked).toHaveLength(1);
    expect(checked[0]?.text).toBe(card.tasks[0]?.text);
    expect(checked[0]?.children?.[0]?.checked).toBe(true);
    card.tasks = checked;
    const reloaded = parse(serialize(board)).columns.flatMap(column => column.cards).find(candidate => candidate.id === card.id)!;
    expect(reloaded.tasks[0]).toMatchObject({ checked: true, text: '#task Checklist 🔁 every week ⏳ 2026-10-20' });
    expect(recalcChecked({ text: '#task Parent', checked: false, children: checked }).checked).toBe(true);
  });

  it('retains recurrence offsets when the upstream editor restores extension fields', () => {
    const original = parseTaskLine('- [ ] Action 🔁 every week ⏳ 2026-10-20 ⏰ 2026-10-20 09:00 [end:: 2026-10-21]')!;
    const next = taskForEditor(original).toggleWithRecurrenceInUsersOrder().find(task => !task.isDone)!;
    const restored = restoreEditorExtensions(next, original).toFileLineString();
    expect(restored).toContain('⏰ 2026-10-27 09:00');
    expect(restored).toContain('[end:: 2026-10-28]');
  });

  it('updates scope after a file changes its workbench identity', async () => {
    const target = file('可重命名.md');
    let text = '- [ ] Action';
    const app = { vault: { getMarkdownFiles: () => [target], read: async () => text, cachedRead: async () => text }, metadataCache: { getFileCache: () => ({ listItems: [{ task: ' ' }] }) } } as unknown as App;
    expect(await collectVaultTasks(app)).toHaveLength(1);
    text = '---\ndashboard: true\n---\n- [ ] Action';
    target.stat.size = text.length;
    expect(await collectVaultTasks(app)).toHaveLength(0);
    expect(await collectVaultTasks(app)).toHaveLength(0);
  });

  it('rejects writes when a task source has become a workbench', async () => {
    const target = file('notes.md');
    const task = scanFileTasks(target, '- [ ] Action')[0]!;
    let text = '---\ndashboard: true\n---\n- [ ] Action';
    const app = { vault: { process: async (_file: TFile, transform: (value: string) => string) => { text = transform(text); } } } as unknown as App;
    await expect(replaceTaskInFile(app, task, ['- [x] Action'])).rejects.toThrow('来源已经变化');
    await expect(toggleTaskInFile(app, task, true)).rejects.toThrow('来源已经变化');
    expect(text).toContain('- [ ] Action');
  });

  it('applies the upstream global query even to an otherwise empty view query', async () => {
    await configureTasks({ globalQuery: 'path does not include hidden' });
    const tasks = [parseTaskLine('- [ ] Visible', 'visible.md')!, parseTaskLine('- [ ] Hidden', 'hidden.md')!];
    const result = executeTaskQuery('', tasks);
    expect(result.groups.flatMap(group => group.tasks).map(task => task.path)).toEqual(['visible.md']);
  });

  it('keeps archived checklist content and descendants inside the original workbench', async () => {
    const target = file('board.md');
    const board = parse(generateDefaultMarkdown());
    const column = board.columns.find(column => column.cards.some(card => card.tasks.length))!;
    column.cards[0]!.tasks = [{ text: 'Archive parent ^archive-parent', checked: true, children: [{ text: 'Retained child', checked: false }] }];
    let disk = serialize(board);
    const app = { vault: { getFileByPath: () => target, read: async () => disk, on: () => ({}), offref: () => undefined,
      modify: async (_file: TFile, content: string) => { disk = content; },
      adapter: { exists: async () => true, write: async () => undefined, list: async () => ({ files: [], folders: [] }) } } } as unknown as App;
    const sync = new SyncEngine(app, { ...DEFAULT_SETTINGS, dashboardFile: 'board' });
    try {
      await sync.init();
      await sync.archiveTasks(column.id ?? column.name, true);
      const current = parse(disk);
      expect(current.bodyPreamble).toContain('Archive parent ^archive-parent');
      expect(current.bodyPreamble).toContain('Retained child');
      expect(current.columns.find(item => item.name === column.name)?.cards[0]?.tasks).toEqual([]);
      expect(scanFileTasks(target, disk).filter(task => task.formal)).toEqual([]);
    } finally { sync.destroy(); }
  });

  it('reports historical workbench tasks and setting differences without writing', async () => {
    const board = file('boards/历史.md');
    const note = file('notes.md');
    const text = '---\ndashboard: true\n---\n- [ ] #task Existing ^existing\n- [ ] Checklist';
    const app = { vault: { configDir: '.obsidian', getMarkdownFiles: () => [board, note],
      read: async (source: TFile) => source === board ? text : '- [ ] #task Ordinary',
      adapter: { exists: async () => true, read: async () => JSON.stringify({ globalFilter: '#todo', taskFormat: 'dataview' }) } } } as unknown as App;
    const report = await readTaskBoundaryReport(app, { globalFilter: '#task', taskFormat: 'dataview' });
    expect(report.workbenchTasks).toEqual([{ path: board.path, line: 3, markdown: '- [ ] #task Existing ^existing' }]);
    expect(report.settingDifferences).toEqual([{ key: 'globalFilter', current: '#task', original: '#todo' }]);
  });

  it('refuses checklist writes after the workbench marker is removed', async () => {
    const target = file('board.md');
    const board = parse(generateDefaultMarkdown());
    const column = board.columns.find(column => column.cards.some(card => card.tasks.length))!;
    let disk = serialize(board);
    const app = { vault: { getFileByPath: () => target, read: async () => disk, on: () => ({}), offref: () => undefined,
      modify: async (_file: TFile, content: string) => { disk = content; },
      adapter: { exists: async () => true, write: async () => undefined, list: async () => ({ files: [], folders: [] }) } } } as unknown as App;
    registerApexHost({ app, checklistsInWorkbenchOnly: true } as never);
    const sync = new SyncEngine(app, { ...DEFAULT_SETTINGS, dashboardFile: 'board' });
    try {
      await sync.init();
      disk = disk.replace('dashboard: true', 'dashboard: false');
      const external = disk;
      await expect(sync.toggleTask(column.cards[0]!.id, [0], true)).rejects.toThrow('清单只能读写');
      expect(disk).toBe(external);
    } finally { sync.destroy(); }
  });

  it('rechecks the actual destination before appending a task', async () => {
    const target = file('destination.md');
    let disk = '---\ndashboard: true\n---\nUser content';
    const app = { vault: { process: async (_file: TFile, transform: (value: string) => string) => { disk = transform(disk); } } } as unknown as App;
    await expect(new VaultNoteService(app).appendTaskToNote(target, '- [ ] Action')).rejects.toThrow('不能保存 Tasks');
    expect(disk).toBe('---\ndashboard: true\n---\nUser content');
  });

  it.each(['tasksPluginEmoji', 'dataview'])('date shortcuts write the selected %s format', async taskFormat => {
    await configureTasks({ taskFormat });
    const target = file('dates.md');
    let disk = '- [ ] Action [owner:: me] ^dates';
    const task = scanFileTasks(target, disk)[0]!;
    const app = { vault: { process: async (_file: TFile, transform: (value: string) => string) => { disk = transform(disk); } } } as unknown as App;
    await updateTaskDatesInFile(app, task, { due: '2026-10-20 09:30' });
    expect(disk).toContain(taskFormat === 'dataview' ? '[due:: 2026-10-20]' : '📅 2026-10-20');
    expect(disk).toContain('[owner:: me]');
    expect(scanFileTasks(target, disk)[0]).toMatchObject({ due: '2026-10-20', dueTime: '09:30', blockId: 'dates' });
  });
});

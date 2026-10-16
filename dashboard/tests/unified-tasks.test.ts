import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { configureTasks, executeTaskQuery, parseTaskLine, changeTaskStatus, cloneTaskLines, applyTaskStatusTypes } from '../tasks-generated/core.js';
import { scanFileTasks, toggleTaskInFile, isTaskSourcePath, replaceTaskInFile } from '../apex/src/alltasks-scan.js';

const file = (path = 'projects/demo/project.md') => Object.assign(new (TFile as unknown as new (path: string) => TFile)(path),
  { stat: { mtime: 1, ctime: 1, size: 1 } });

beforeEach(async () => { await configureTasks({ globalFilter: '#task' }); });

describe('unified Tasks semantics', () => {
  it('completes a recurring task exactly once and retains history, links and extensions', async () => {
    const target = file();
    let text = '- [ ] #task Review [[lesson]] 🔁 every week ⏳ 2026-10-13 ⏰ 2026-10-13 09:00 ^review';
    const task = scanFileTasks(target, text)[0]!;
    const app = { vault: { process: async (_file: TFile, write: (text: string) => string) => { text = write(text); } } } as unknown as App;
    expect(task.recurrence).toContain('every week');
    expect(await toggleTaskInFile(app, task, true)).toBe(true);
    const tasks = scanFileTasks(target, text);
    expect(tasks).toHaveLength(2);
    expect(tasks.filter(item => !item.checked)).toHaveLength(1);
    expect(tasks.find(item => !item.checked)).toMatchObject({ scheduled: '2026-10-20', reminder: '2026-10-20 09:00' });
    expect(tasks.find(item => item.checked)?.completion).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(text).toContain('[[lesson]]');
    expect(await toggleTaskInFile(app, task, true)).toBe(false);
    expect(scanFileTasks(target, text)).toHaveLength(2);
  });

  it('supports custom statuses, priorities and dependency queries', () => {
    const a = parseTaskLine('- [/] #task Write report ⏫ 🆔 report', 'projects/a.md')!;
    const b = parseTaskLine('- [ ] #task Send report ⛔ report', 'projects/b.md')!;
    const c = parseTaskLine('- [-] #task Cancelled', 'projects/c.md')!;
    expect(a.isDone).toBe(false);
    expect(c.isDone).toBe(true);
    expect(b.isBlocked([a, b])).toBe(true);
    const result = executeTaskQuery('not done\nis not blocked\nsort by priority\ngroup by path', [a, b, c]);
    expect(result.totalTasksCount).toBe(1);
    expect(result.groups[0]?.tasks[0]?.description).toContain('Write report');
  });

  it('reads mixed legacy fields and preserves time and unknown metadata during completion', () => {
    const line = '- [ ] #task Read [owner:: me] [scheduled:: 2026-10-13 10:30] [due:: 2026-10-15] ^read';
    const parsed = parseTaskLine(line)!;
    expect(parsed.scheduledDate?.format('YYYY-MM-DD')).toBe('2026-10-13');
    const completed = changeTaskStatus(line, 'note.md', 'x')[0]!;
    expect(completed).toContain('[owner:: me]');
    expect(completed).toContain('[okf-scheduled-time:: 10:30]');
    expect(completed).toContain('^read');
    expect(scanFileTasks(file(), completed)[0]).toMatchObject({ scheduledTime: '10:30', due: '2026-10-15' });
  });

  it('keeps local checklist completion distinct from formal task recurrence', async () => {
    const target = file('工作台/临时.md');
    let text = '---\ndashboard: true\n---\n- [ ] Buy milk';
    const task = scanFileTasks(target, text)[0]!;
    const app = { vault: { process: async (_file: TFile, write: (text: string) => string) => { text = write(text); } } } as unknown as App;
    await toggleTaskInFile(app, task, true);
    expect(text).toBe('---\ndashboard: true\n---\n- [x] Buy milk');
  });

  it('rejects stale complete edits while supporting moved source lines', async () => {
    const target = file();
    const task = scanFileTasks(target, '- [ ] #task Original ^stable')[0]!;
    let text = 'intro\n- [ ] #task Changed externally ^stable';
    const app = { vault: { process: async (_file: TFile, write: (text: string) => string) => { text = write(text); } } } as unknown as App;
    expect(await replaceTaskInFile(app, task, ['- [ ] #task Edited ^stable'])).toBe(false);
    expect(text).toContain('Changed externally');
    text = 'intro\n- [ ] #task Original ^stable';
    expect(await replaceTaskInFile(app, task, ['- [ ] #task Edited ^stable'])).toBe(true);
  });

  it('excludes projections, source material, templates and backup copies', () => {
    for (const path of ['index.md', '.dashboard-backup/board.md', 'system/templates/sample.md', 'system/views/Tasks.md']) {
      expect(isTaskSourcePath(path)).toBe(false);
    }
    const source = scanFileTasks(file('sources/texts/a.md'), '---\ntype: Source Text\n---\n- [ ] #task quoted');
    expect(source[0]?.formal).toBe(false);
  });

  it('preserves parent and heading context in the shared query index', () => {
    const tasks = scanFileTasks(file(), '# Project\n\n## Report\n\n- [ ] Local steps\n    - [ ] #task Draft\n');
    const child = tasks.find(task => task.text === 'Draft')!;
    expect(child.upstream?.parent?.description).toContain('Local steps');
    expect(child.upstream?.parent?.isTask).toBe(false);
    expect(executeTaskQuery('heading includes Report', [child.upstream!]).totalTasksCount).toBe(1);
  });

  it('clones independent task identities while retaining internal and external dependencies', () => {
    const copied = cloneTaskLines(['- [ ] #task Draft 🆔 draft ^draft', '- [ ] #task Send ⛔ draft,outside ^send'], 'note.md');
    const a = parseTaskLine(copied[0]!)!;
    const b = parseTaskLine(copied[1]!)!;
    expect(a.id).not.toBe('draft');
    expect(b.dependsOn).toEqual([a.id, 'outside']);
    expect(copied.join('\n')).not.toContain('^draft');
  });

  it('uses the same custom-state classification in projections and queries', () => {
    applyTaskStatusTypes({ '!': 'NON_TASK', '?': 'ON_HOLD', ' ': 'TODO', x: 'DONE' });
    const tasks = scanFileTasks(file(), '- [!] #task Annotation\n- [?] #task Waiting');
    expect(tasks[0]?.formal).toBe(false);
    expect(tasks[1]).toMatchObject({ formal: true, checked: false, statusType: 'ON_HOLD' });
  });

  it('preserves unfinished children when completion deletes their parent', async () => {
    const target = file();
    let text = '- [ ] #task Parent 🏁 delete ^parent\n    - [ ] #task Child ^child\n';
    const task = scanFileTasks(target, text)[0]!;
    const app = { vault: { process: async (_file: TFile, write: (text: string) => string) => { text = write(text); } } } as unknown as App;
    await toggleTaskInFile(app, task, true);
    expect(text).toContain('- [ ] #task Child ^child');
    expect(scanFileTasks(target, text).filter(task => task.formal && !task.checked)).toHaveLength(1);
  });

  it('keeps original children with original occurrence when the new occurrence goes below it', async () => {
    await configureTasks({ globalFilter: '#task', recurrenceOnNextLine: true });
    const target = file();
    let text = '- [ ] #task Parent 🔁 every week ⏳ 2026-10-13 ^parent\n    - [ ] #task Child ^child\n';
    const task = scanFileTasks(target, text)[0]!;
    const app = { vault: { process: async (_file: TFile, write: (text: string) => string) => { text = write(text); } } } as unknown as App;
    await toggleTaskInFile(app, task, true);
    expect(text.indexOf('^child')).toBeLessThan(text.indexOf('2026-10-20'));
    const next = scanFileTasks(target, text).find(item => item.scheduled === '2026-10-20')!;
    expect(next.blockId).toMatch(/^task-/u);
  });

  it('follows the configured next status for checkbox operations', async () => {
    await configureTasks({ statusSettings: { coreStatuses: [
      { symbol: ' ', name: 'Todo', nextStatusSymbol: '/', availableAsCommand: true, type: 'TODO' },
      { symbol: 'x', name: 'Done', nextStatusSymbol: ' ', availableAsCommand: true, type: 'DONE' },
    ], customStatuses: [{ symbol: '/', name: 'In Progress', nextStatusSymbol: 'x', availableAsCommand: true, type: 'IN_PROGRESS' }] } });
    const next = parseTaskLine('- [ ] #task Action')!.toggleWithRecurrenceInUsersOrder()[0]!;
    expect(next.status.symbol).toBe('/');
    expect(next.isDone).toBe(false);
  });

  it('uses upstream global-filter and tag-query semantics', () => {
    const task = scanFileTasks(file(), '- [ ] #task Action')[0]!;
    expect(task.formal).toBe(true);
    expect(executeTaskQuery('not done\ntags include #task', [task.upstream!]).totalTasksCount).toBe(0);
    expect(executeTaskQuery('no tags', [task.upstream!]).totalTasksCount).toBe(1);
    expect(scanFileTasks(file(), '- [ ] #task/subtag Action')[0]?.formal).toBe(true);
  });
});

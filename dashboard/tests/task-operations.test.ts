import { describe, expect, it } from 'vitest';
import { TFile, type App } from 'obsidian';
import { moveTaskToNote, copyTaskSubtree } from '../apex/src/task-operations.js';
import { parseTaskLine } from '../tasks-generated/core.js';
import { scanFileTasks } from '../apex/src/alltasks-scan.js';

function fixture() {
  const file = (path: string) => new (TFile as unknown as new (path: string) => TFile)(path);
  const source = file('source.md');
  const destination = file('destination.md');
  const daily = file('daily.md');
  const documents = new Map([[source.path, '# Tasks\n- [ ] Parent\n    - [ ] #task Action [due:: 2026-10-15] ^action\n        - [ ] Child\n- [ ] Sibling'],
    [destination.path, '# Destination'], [daily.path, 'See [[source#^action|Action]]']]);
  const files = [source, destination, daily];
  let conflict = false;
  const app = {
    vault: { getMarkdownFiles: () => files, getAbstractFileByPath: (path: string) => files.find(file => file.path === path),
      read: async (file: TFile) => documents.get(file.path)!,
      process: async (file: TFile, write: (text: string) => string) => {
        if (conflict && file.path === source.path) documents.set(source.path, `${documents.get(source.path)}\nExternal edit`);
        documents.set(file.path, write(documents.get(file.path)!));
      } },
    metadataCache: { getFileCache: (file: TFile) => file.path === daily.path ? { links: [{ link: 'source#^action', original: '[[source#^action|Action]]', displayText: 'Action',
      position: { start: { offset: 4 }, end: { offset: documents.get(daily.path)!.length } } }] } : {},
      getFirstLinkpathDest: () => source },
    fileManager: { generateMarkdownLink: (_file: TFile, _path: string, subpath: string, display: string) => `[[destination${subpath}|${display}]]` },
  } as unknown as App;
  return { app, source, destination, documents, conflict: () => { conflict = true; } };
}

describe('moving authoritative tasks', () => {
  it('copies the complete subtree with independent identity, dependencies and inherited context', async () => {
    const { app, source, documents } = fixture();
    const original = '---\nproject: /projects/demo/project.md\ncourse: /learning/courses/demo/course.md\n---\n- [ ] #task Parent 🆔 parent ^parent\n    Explanation stays.\n    - [ ] #task Child 🆔 child ⛔ parent,outside ^child\n';
    documents.set(source.path, original);
    const task = scanFileTasks(source, original)[0]!;
    const copied = await copyTaskSubtree(app, task);
    expect(documents.get(source.path)).toBe(original);
    expect(copied).toContain('Explanation stays.');
    const tasks = scanFileTasks(source, copied);
    expect(tasks).toHaveLength(2);
    expect(tasks.every(task => task.project === '/projects/demo/project.md' && task.course === '/learning/courses/demo/course.md')).toBe(true);
    expect(tasks.map(task => task.blockId)).not.toContain('parent');
    expect(tasks.map(task => task.blockId)).not.toContain('child');
    const parent = parseTaskLine(tasks[0]!.originalLine)!;
    const child = parseTaskLine(tasks[1]!.originalLine)!;
    expect(parent.id).not.toBe('parent');
    expect(child.dependsOn).toEqual([parent.id, 'outside']);
  });
  it('moves the entire subtree, keeps fields and identity, dedents and updates references', async () => {
    const { app, source, destination, documents } = fixture();
    const task = scanFileTasks(source, documents.get(source.path)!)[1]!;
    await moveTaskToNote(app, task, destination.path);
    expect(documents.get(source.path)).toContain('Parent');
    expect(documents.get(source.path)).not.toContain('^action');
    expect(documents.get(destination.path)).toContain('\n- [ ] #task Action [due:: 2026-10-15] ^action\n    - [ ] Child');
    expect(documents.get('daily.md')).toBe('See [[destination#^action|Action]]');
    expect(documents.get(destination.path)).not.toContain('okf-task-move');
  });

  it('preserves a concurrent source edit and removes only the unfinished destination insertion', async () => {
    const { app, source, destination, documents, conflict } = fixture();
    const task = scanFileTasks(source, documents.get(source.path)!)[1]!;
    conflict();
    await expect(moveTaskToNote(app, task, destination.path)).rejects.toThrow('移动已取消');
    expect(documents.get(source.path)).toContain('External edit');
    expect(documents.get(source.path)).toContain('^action');
    expect(documents.get(destination.path)).not.toContain('^action');
  });
});

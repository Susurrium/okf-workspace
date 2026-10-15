import { TFile, parseLinktext, type App } from 'obsidian';
import { isTaskSourcePath, invalidatePath, scanFileTasks, type VaultTask } from './alltasks-scan';
import MarkdownIt from 'markdown-it';
import { cloneTaskLines, matchesTaskFilter } from '../../tasks-generated/core.js';
import { taskSourceKind } from './task-source';

export async function copyTaskSubtree(app: App, task: VaultTask): Promise<string> {
  const content = await app.vault.read(task.file);
  const records = content.split('\n');
  const candidates = records.flatMap((line, index) => line === task.originalLine ? [index] : []);
  const start = records[task.line] === task.originalLine ? task.line : candidates.length === 1 ? candidates[0]! : -1;
  if (start < 0) throw new Error('任务已经变化，无法唯一定位');
  const item = new MarkdownIt('commonmark').parse(content, {}).find(token => token.type === 'list_item_open' && token.map?.[0] === start);
  if (!item?.map) throw new Error('无法读取任务的完整子树');
  const block = records.slice(start, item.map[1]);
  const positions = block.flatMap((line, index) => /^\s*[-*+]\s+\[.\]/u.test(line) ? [index] : []);
  const sources = new Map(scanFileTasks(task.file, content).map(item => [item.line, item]));
  const originals = positions.map(index => {
    let line = block[index]!;
    const source = sources.get(start + index);
    if (source?.formal) {
      const suffix = /\s+\^[\w-]+\s*$/u.exec(line)?.[0] ?? '';
      let body = suffix ? line.slice(0, -suffix.length) : line;
      for (const key of ['course', 'project'] as const) if (source[key] && !new RegExp(`\\[${key}::`, 'u').test(body)) body += ` [${key}:: ${source[key]}]`;
      line = body + suffix;
    }
    return line;
  });
  const cloned = cloneTaskLines(originals, task.path);
  positions.forEach((position, index) => { block[position] = cloned[index]!; });
  const indentation = /^[\t ]*/u.exec(block[0]!)![0].replace(/\t/gu, '    ').length;
  return block.map(line => {
    const prefix = /^[\t ]*/u.exec(line)![0];
    return `${' '.repeat(Math.max(0, prefix.replace(/\t/gu, '    ').length - indentation))}${line.slice(prefix.length)}`;
  }).join('\n');
}

export async function rewriteTaskReferences(app: App, source: string, destination: TFile, ids: readonly string[]): Promise<void> {
  const identities = new Set(ids);
  for (const file of app.vault.getMarkdownFiles()) {
    if (!isTaskSourcePath(file.path)) continue;
    const links = app.metadataCache.getFileCache(file)?.links ?? [];
    const edits = links.flatMap(link => {
      const parsed = parseLinktext(link.link);
      if (!parsed.subpath.startsWith('#^') || !identities.has(parsed.subpath.slice(2))) return [];
      const original = app.metadataCache.getFirstLinkpathDest(parsed.path, file.path);
      if (original?.path !== source) return [];
      const replacement = app.fileManager.generateMarkdownLink(destination, file.path, parsed.subpath, link.displayText);
      return [{ start: link.position.start.offset, end: link.position.end.offset, original: link.original, replacement }];
    });
    if (!edits.length) continue;
    await app.vault.process(file, content => {
      let next = content;
      for (const edit of edits.sort((left, right) => right.start - left.start)) {
        if (next.slice(edit.start, edit.end) !== edit.original) throw new Error(`引用文件已经变化，请重试：${file.path}`);
        next = `${next.slice(0, edit.start)}${edit.replacement}${next.slice(edit.end)}`;
      }
      return next;
    });
  }
}

export async function moveTaskToNote(app: App, task: VaultTask, destinationPath: string): Promise<void> {
  const path = destinationPath.trim().replace(/\\/gu, '/').replace(/^\//u, '');
  if (!isTaskSourcePath(path) || path.split('/').some(part => ['.', '..'].includes(part) || part.includes(':'))) throw new Error('目标笔记路径无效');
  const destination = app.vault.getAbstractFileByPath(path.endsWith('.md') ? path : `${path}.md`);
  if (!(destination instanceof TFile)) throw new Error('目标笔记不存在，请选择已有笔记');
  if (destination.path === task.path) return;
	if (taskSourceKind(destination.path, app.metadataCache.getFileCache(destination)?.frontmatter ?? {}) !== 'tasks') throw new Error('目标笔记不能保存 Tasks 任务');
  const original = await app.vault.read(task.file);
  const lines = original.split('\n');
  let start = lines[task.line] === task.originalLine ? task.line : -1;
  if (start < 0) {
    const matches = lines.flatMap((line, index) => line === task.originalLine ? [index] : []);
    if (matches.length === 1) start = matches[0]!;
  }
  if (start < 0) throw new Error('任务已经变化，无法唯一定位');
  const indentation = /^[\t ]*/u.exec(lines[start]!)![0].replace(/\t/gu, '    ').length;
  const item = new MarkdownIt('commonmark').parse(original, {}).find(token => token.type === 'list_item_open' && token.map?.[0] === start);
  if (!item?.map) throw new Error('无法确定任务的完整 Markdown 范围');
  const end = item.map[1];
  const metadata = app.metadataCache.getFileCache(task.file)?.frontmatter ?? {};
  const metadataCourse: unknown = metadata.course;
  const metadataProject: unknown = metadata.project;
  const course = task.course ?? (typeof metadataCourse === 'string' ? metadataCourse : undefined) ?? (/^learning\/courses\/([^/]+)\//u.exec(task.path)?.[1]
    ? `/learning/courses/${task.path.split('/')[2]}/course.md` : undefined);
  const project = task.project ?? (typeof metadataProject === 'string' ? metadataProject : undefined) ?? (/^projects\/([^/]+)\//u.exec(task.path)?.[1]
    ? `/projects/${task.path.split('/')[1]}/project.md` : undefined);
  const block = lines.slice(start, end).map(line => {
    const prefix = /^[\t ]*/u.exec(line)![0];
    const spaces = prefix.replace(/\t/gu, '    ').length;
    let moved = `${' '.repeat(Math.max(0, spaces - indentation))}${line.slice(prefix.length)}`;
		if (matchesTaskFilter(moved)) {
      const suffix = /\s+\^[\w-]+\s*$/u.exec(moved)?.[0] ?? '';
      let body = suffix ? moved.slice(0, -suffix.length) : moved;
      for (const [key, value] of [['project', project], ['course', course]]) {
        if (typeof value === 'string' && value && !new RegExp(`\\[${key}::`, 'u').test(body)) body += ` [${key}:: ${value}]`;
      }
      moved = body + suffix;
    }
    return moved;
  }).join('\n');
  const marker = `<!-- okf-task-move:${crypto.randomUUID()} -->`;
  const payload = `${marker}\n${block}\n${marker}`;
  await app.vault.process(destination, content => `${content.trimEnd()}\n\n${payload}\n`);
  try {
    await app.vault.process(task.file, content => {
      if (content !== original) throw new Error('任务来源在移动期间已经变化，移动已取消');
      return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
    });
  } catch (error) {
    await app.vault.process(destination, content => {
      if (!content.includes(payload)) throw new Error('目标任务已被编辑，无法撤销未完成的移动');
      return content.replace(payload, '');
    });
    throw error;
  }
  await app.vault.process(destination, content => content.replaceAll(marker, ''));
  invalidatePath(task.path);
  invalidatePath(destination.path);
  const ids = [...block.matchAll(/\s\^([a-zA-Z0-9-]+)\s*$/gmu)].map(match => match[1]!);
  await rewriteTaskReferences(app, task.path, destination, ids);
}

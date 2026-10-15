import { App, TFile, type CachedMetadata, type ListItemCache, type HeadingCache } from 'obsidian';
import { normalizeExcludeFolders, isUnderExcludedFolder } from './exclude-folders';
import { parseTaskLine, indexTaskFile, matchesTaskFilter, readTaskIndex, executeTaskQuery, getSettings, validateTaskDate, type UpstreamTask } from '../../tasks-generated/core.js';
import { taskSourceKind, readTaskSourceKind } from './task-source';
import { parse as parseYaml } from 'yaml';
import MarkdownIt from 'markdown-it';

/** Recognized task priority levels (parsed from `[priority:: ...]`). */
export type Priority = 'high' | 'medium' | 'low';
/** Grouping dimension for the aggregated task view. */
export type TaskGroupBy = 'date' | 'priority' | 'none';

/**
 * One checkbox task located somewhere in the vault. Carries enough context to
 * display it, bucket it, and write the toggle back to its exact source line.
 */
export interface VaultTask {
	calendarEventKind?: CalendarDayKind;
	file: TFile;
	path: string;
	/** 0-based line index of the checkbox in the source file. */
	line: number;
	/** Full raw source line (indent + `- [ ]`/`- [x]` + text + markers), kept verbatim so toggling can match it exactly even if the file shifted. */
	originalLine: string;
	/** Stable Markdown block identity when the task line ends in `^id`. */
	blockId?: string;
	/** True only for explicit user tasks outside Source/Digest artifacts. */
	formal: boolean;
	eligible?: boolean;
	checklist?: boolean;
	checked: boolean;
	status?: string;
	statusType?: string;
	upstream?: UpstreamTask;
	created?: string;
	cancelled?: string;
	recurrence?: string;
	dependencyId?: string;
	dependsOn?: string[];
	project?: string;
	course?: string;
	/** Display text with all markers (collapsed/reminder/due/priority) stripped. */
	text: string;
	/** Raw `⏰ YYYY-MM-DD( HH:MM)` reminder value, if present (time optional). */
	reminder?: string;
	/** Canonical due date `YYYY-MM-DD` (from ⏰ / `[due::]` / 📅), if any. */
	due?: string;
	/** Multi-day event start `YYYY-MM-DD` (from `[start::]` / 🛫), if any. */
	start?: string;
	/** Multi-day event end `YYYY-MM-DD` (from `[end::]` / 🛬), if any. */
	end?: string;
	/** Scheduled date `YYYY-MM-DD` (from ⏳ / `[scheduled::]`), if any. */
	scheduled?: string;
	/** `HH:MM` carried by the scheduled marker (`[scheduled::]` field form only). */
	scheduledTime?: string;
	/** Completion date `YYYY-MM-DD` (from ✅ / `[completion::]`), if any. */
	completion?: string;
	/** `HH:MM` carried by the completion marker (`[completion::]` field form only). */
	completionTime?: string;
	/** Start time-of-day `HH:MM` (from ⏰ / `[due::]` / `[start::]` when a time is present). */
	time?: string;
	startTime?: string;
	dueTime?: string;
	/** End time-of-day `HH:MM` (from `[end::]` when a time is present). */
	endTime?: string;
	priority?: Priority;
	mtime: number;
	ctime: number;
}

interface CacheEntry {
	file: TFile;
	mtime: number;
	size: number;
	tasks: VaultTask[];
}

const moduleCache = new Map<string, CacheEntry>();
const markdown = new MarkdownIt('commonmark');

const COLLAPSED_REGEX = /\s*<!--collapsed-->\s*$/;
/** Plugin's own reminder marker: `⏰ YYYY-MM-DD( HH:MM)` (time optional). */
const REMINDER_REGEX = /\s*⏰\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/;
/** Dataview-style due date inline field, anywhere in the text. */
const DUE_FIELD_REGEX = /\s*\[due::\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)\s*\]/i;
/** Tasks-plugin calendar emoji due date, anywhere in the text. */
const CALENDAR_REGEX = /\s*📅\s*(\d{4}-\d{2}-\d{2})/;
/** Dataview-style start-date inline field, anywhere in the text. */
const START_FIELD_REGEX = /\s*\[start::\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)\s*\]/i;
/** Tasks-plugin start emoji. */
const START_EMOJI_REGEX = /\s*🛫\s*(\d{4}-\d{2}-\d{2})/;
/** Dataview-style end-date inline field, anywhere in the text. */
const END_FIELD_REGEX = /\s*\[end::\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)\s*\]/i;
/** Tasks-plugin end emoji. */
const END_EMOJI_REGEX = /\s*🛬\s*(\d{4}-\d{2}-\d{2})/;
/** Dataview-style scheduled-date inline field, anywhere in the text. */
const SCHEDULED_FIELD_REGEX = /\s*\[scheduled::\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)\s*\]/i;
/** Tasks-plugin scheduled emoji. */
const SCHEDULED_EMOJI_REGEX = /\s*⏳\s*(\d{4}-\d{2}-\d{2})/;
/** Any checkbox line, allowing leading indentation so subtasks are aggregated too. */
const TASK_LINE_REGEX = /^(\s*)[-*+][\t ]+\[(.)\][\t ]*(.+?)\r?$/;

function frontmatterEnd(lines: string[]): number {
	if (lines[0]?.trim() !== '---') return -1;
	for (let index = 1; index < lines.length; index++) {
		if (lines[index]?.trim() === '---') return index;
	}
	return -1;
}


/** `HH:MM` from a `YYYY-MM-DD HH:MM`-shaped value (undefined if no time part). */
function hhmm(s: string | undefined): string | undefined {
	return s && s.length >= 16 ? s.slice(11, 16) : undefined;
}

/**
 * Scan authoritative Markdown task lines. Invalid source data is reported.
 */
export function scanFileTasks(file: TFile, content: string, cache: CachedMetadata = {}): VaultTask[] {
	const lines = content.split('\n');
	if (!lines.some(line => TASK_LINE_REGEX.test(line))) return [];
	const yamlEnd = frontmatterEnd(lines);
	if (lines[0]?.trim() === '---' && yamlEnd < 0) throw new Error(`任务来源 YAML 缺少结束标记：${file.path}`);
	const yaml = yamlEnd > 0 ? lines.slice(1, yamlEnd).join('\n') : '';
	const metadata = yaml ? (parseYaml(yaml) ?? {}) as Record<string, unknown> : {};
	if (metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) throw new Error(`待办来源 YAML 必须为对象：${file.path}`);
	if (metadata.type !== undefined && typeof metadata.type !== 'string') throw new Error(`待办来源 type 必须为字符串：${file.path}`);
	const kind = taskSourceKind(file.path, metadata);
	const excludesFormalTasks = kind !== 'tasks';
	const out: VaultTask[] = [];
	const ignored = new Set<number>();
	const tokens = markdown.parse(lines.slice(yamlEnd + 1).join('\n'), {});
	for (const token of tokens) {
		if (['fence', 'code_block'].includes(token.type) && token.map) {
			for (let line = token.map[0]; line < token.map[1]; line++) ignored.add(line + yamlEnd + 1);
		}
	}
	const items: ListItemCache[] = [];
	const stack: number[] = [];
	const headings: HeadingCache[] = [];
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
	const position = (line: number) => ({ line, col: 0, offset: offsets[line] ?? content.length });
	for (const [index, token] of tokens.entries()) {
		if (token.type === 'heading_open' && token.map) headings.push({ heading: tokens[index + 1]?.content ?? '',
			level: Number(token.tag.slice(1)), position: { start: position(token.map[0] + yamlEnd + 1), end: position(token.map[1] + yamlEnd) } });
		if (token.type === 'list_item_close') stack.pop();
		if (token.type !== 'list_item_open' || !token.map) continue;
		const line = token.map[0] + yamlEnd + 1;
		const mark = TASK_LINE_REGEX.exec(lines[line] ?? '')?.[2];
		items.push({ parent: stack.at(-1) ?? -1, ...(mark !== undefined ? { task: mark } : {}),
			position: { start: position(line), end: position(token.map[1] + yamlEnd) } });
		stack.push(line);
	}
	const snapshot: CachedMetadata = { ...cache, frontmatter: metadata, headings,
		sections: cache.sections?.length ? cache.sections : [{ type: 'list', position: { start: position(yamlEnd + 1), end: position(lines.length - 1) } }] };
	const indexed = new Map(indexTaskFile(file, content, snapshot, items).map(task => [task.lineNumber, task]));
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		if (i <= yamlEnd) continue;
		if (ignored.has(i)) continue;
		const m = raw.match(TASK_LINE_REGEX);
		if (!m) continue;
		const upstream = indexed.get(i) ?? parseTaskLine(raw, file.path, i, metadata);
		if (!upstream) continue;
		const formal = !excludesFormalTasks && matchesTaskFilter(raw) && upstream.status.type !== 'NON_TASK';
		out.push(projectTask(file, raw, upstream, metadata, formal, kind === 'checklists'));
	}
	return out;
}

function projectTask(file: TFile, raw: string, upstream: UpstreamTask, metadata: Record<string, unknown>, formal: boolean, checklist = false): VaultTask {
		const blockId = upstream.blockLink.trim().replace(/^\^/u, '') || undefined;
		const rm = raw.match(REMINDER_REGEX);
		const reminder = rm ? (rm[2] ? `${rm[1]} ${rm[2]}` : rm[1]) : undefined;
		const endValue = (raw.match(END_FIELD_REGEX) ?? raw.match(END_EMOJI_REGEX))?.[1];
		const end = endValue?.slice(0, 10);
		const iso = (date: UpstreamTask['dueDate']): string | undefined => date?.isValid() ? date.format('YYYY-MM-DD') : undefined;
		const extensionTime = (name: string): string | undefined =>
			new RegExp(`\\[okf-${name}-time::\\s*(\\d{2}:\\d{2})\\s*\\]`, 'u').exec(raw)?.[1]
			?? hhmm(new RegExp(`\\[${name}::\\s*([^\\]]+)\\]`, 'iu').exec(raw)?.[1]);
		const start = iso(upstream.startDate);
		const due = iso(upstream.dueDate);
		const time = extensionTime('start') ?? hhmm(reminder) ?? extensionTime('due');
		const endTime = hhmm(endValue) ?? (start && (due ?? reminder?.slice(0, 10)) === start ? hhmm(reminder) ?? extensionTime('due') : undefined);
		const text = upstream.description
			.replace(REMINDER_REGEX, '').replace(END_FIELD_REGEX, '').replace(END_EMOJI_REGEX, '')
			.replace(/\s*\[okf-(?:start|due|scheduled|completion)-time::[^\]]+\]/gu, '')
			.replace(/\s*\[(?:project|course)::[^\]]+\]/gu, '')
			.replace(COLLAPSED_REGEX, '').trim();
		return {
			file,
			path: file.path,
			line: upstream.lineNumber,
			originalLine: raw,
			blockId,
			formal,
			eligible: formal,
			checklist,
			checked: checklist ? /^\s*[-*+]\s+\[[xX]\]/u.test(raw) : upstream.isDone,
			status: upstream.status.symbol,
			statusType: upstream.status.type,
			upstream,
			created: iso(upstream.createdDate), cancelled: iso(upstream.cancelledDate),
			project: /\[project::\s*([^\]]+)\]/u.exec(raw)?.[1]?.trim() ?? (typeof metadata.project === 'string' ? metadata.project : /^projects\/[^/]+\//u.test(file.path) ? `/projects/${file.path.split('/')[1]}/project.md` : undefined),
			course: /\[course::\s*([^\]]+)\]/u.exec(raw)?.[1]?.trim() ?? (typeof metadata.course === 'string' ? metadata.course : /^learning\/courses\/[^/]+\//u.test(file.path) ? `/learning/courses/${file.path.split('/')[2]}/course.md` : undefined),
			recurrence: upstream.recurrence?.toText(), dependencyId: upstream.id, dependsOn: upstream.dependsOn,
			text: taskDisplayText(text),
			reminder,
			due,
			start,
			end,
			scheduled: iso(upstream.scheduledDate),
			scheduledTime: extensionTime('scheduled'),
			completion: iso(upstream.doneDate),
			completionTime: extensionTime('completion'),
			time,
			startTime: extensionTime('start'),
			dueTime: extensionTime('due'),
			endTime,
			priority: ({ '0': 'high', '1': 'high', '2': 'medium', '4': 'low', '5': 'low' } as Record<string, Priority>)[upstream.priority],
			mtime: file.stat?.mtime ?? 0,
			ctime: file.stat?.ctime ?? 0,
		};
}

function taskDisplayText(text: string): string {
  const filter = String(getSettings().globalFilter ?? '');
  return (filter ? text.replace(filter, '') : text).trim();
}

export function isTaskSourcePath(path: string): boolean {
	const parts = path.replace(/\\/gu, '/').split('/');
	return !parts.some(part => part.startsWith('.')) && path !== 'index.md' && path !== 'AGENTS.md'
		&& !(parts[0] === 'system' && ['contracts', 'reports', 'templates', 'views'].includes(parts[1] ?? ''));
}

/**
 * Collect every checkbox task across the vault, skipping excluded folders,
 * using an mtime-keyed cache so unchanged files are not re-parsed each render.
 *
 * `alwaysIncludePath` (with or without `.md`) is exempt from the exclusion
 * check: pass the dashboard file, whose checkbox tasks are the user's live
 * todo list and the destination the calendar's day-agenda writes into. Without
 * the exemption, excluding the dashboard's parent folder (e.g. 'assets') hides
 * the dashboard's tasks from the calendar AND makes every calendar-added task
 * vanish on the next re-scan.
 */
export async function collectVaultTasks(
	app: App,
	excludeFolders: string[] = [],
	alwaysIncludePath?: string,
	applyGlobalQuery = true,
): Promise<VaultTask[]> {
	const indexed = readTaskIndex();
	if (indexed) {
		const tasks = indexed.flatMap(task => {
			const file = app.vault.getAbstractFileByPath(task.path);
			if (!(file instanceof TFile) || isUnderExcludedFolder(task.path, normalizeExcludeFolders(excludeFolders))) return [];
			const metadata = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
			if (taskSourceKind(task.path, metadata) !== 'tasks' || task.status.type === 'NON_TASK') return [];
			return [projectTask(file, task.originalMarkdown, task, metadata, true)];
		});
		return applyGlobalQuery ? applyTaskGlobalQuery(tasks) : tasks;
	}
	const normalized = normalizeExcludeFolders(excludeFolders);
	const rawAlways = (alwaysIncludePath ?? '').trim().toLowerCase();
	const alwaysFile = rawAlways ? (rawAlways.endsWith('.md') ? rawAlways : `${rawAlways}.md`) : '';
	const files = app.vault.getMarkdownFiles();
	const stale = new Set(moduleCache.keys());
	const all: VaultTask[] = [];

	for (let i = 0; i < files.length; i++) {
		const file = files[i]!;
		// Yield to the UI thread periodically so scanning a large vault doesn't
		// freeze the app (especially on mobile) — this is what made the section
		// feel stuck/unresponsive and the phone overheat while it churned through
		// every file.
		if (i > 0 && i % 50 === 0) await new Promise<void>(r => window.setTimeout(r, 0));

		if (!isTaskSourcePath(file.path)) { stale.delete(file.path); continue; }
		const exempt = alwaysFile !== '' && file.path.toLowerCase() === alwaysFile;
		if (!exempt && isUnderExcludedFolder(file.path, normalized)) { stale.delete(file.path); continue; }
		stale.delete(file.path);

		const cached = moduleCache.get(file.path);
		if (cached && cached.file === file && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
			all.push(...cached.tasks.filter(task => task.formal));
			continue;
		}

		// Cheap pre-filter via the metadata cache: skip files Obsidian has already
		// parsed that contain no checkbox tasks at all (the common case — most notes
		// have none). This avoids reading + regex-parsing the vast majority of notes.
		// (Don't cache the empty result: re-checking the metadata cache each scan is
		// cheap and self-heals if the cache was briefly stale after a write.)
		const fc = app.metadataCache?.getFileCache(file);
		if (fc && !fc.listItems?.some(li => li.task !== undefined)) {
			continue;
		}

		let content: string;
		try {
			// When a known file changes, bypass Obsidian's read cache. External
			// editors can update stat/metadata before cachedRead observes the new
			// bytes, which would otherwise pin stale tasks under the new fingerprint.
			const directRead = (app.vault as typeof app.vault & { read?: (target: TFile) => Promise<string> }).read;
			content = cached && typeof directRead === 'function'
				? await directRead.call(app.vault, file)
				: await app.vault.cachedRead(file);
		} catch (error) {
			throw new Error(`无法读取待办来源：${file.path}`, { cause: error });
		}
		const tasks = scanFileTasks(file, content, fc ?? {});
		moduleCache.set(file.path, { file, mtime: file.stat.mtime, size: file.stat.size, tasks });
		all.push(...tasks.filter(task => task.formal));
	}
	for (const path of stale) moduleCache.delete(path);
	return applyGlobalQuery ? applyTaskGlobalQuery(all) : all;
}

function applyTaskGlobalQuery(tasks: VaultTask[]): VaultTask[] {
	if (!getSettings().globalQuery) return tasks;
	const results = executeTaskQuery('', tasks.flatMap(task => task.upstream ? [task.upstream] : []));
	const visible = new Set(results.groups.flatMap(group => group.tasks).map(task => `${task.path}:${task.lineNumber}`));
	return tasks.filter(task => visible.has(`${task.path}:${task.line}`));
}

/** Drop cache entries for a path (e.g. after a failed toggle) so the next scan re-reads. */
export function invalidatePath(path: string): void {
	moduleCache.delete(path);
}

export function invalidateAllTasks(): void { moduleCache.clear(); }

function replaceTaskAndPreserveChildren(lines: string[], index: number, replacements: string[]): string {
	const tokens = markdown.parse(lines.join('\n'), {});
	const item = tokens.find(token => token.type === 'list_item_open' && token.map?.[0] === index);
	if (!item?.map) throw new Error('无法确定任务与子项的范围');
	const end = item.map[1];
	const children = lines.slice(index + 1, end);
	if (!replacements.length) {
		const parentIndent = /^[\t ]*/u.exec(lines[index]!)![0].replace(/\t/gu, '    ').length;
		const childIndents = tokens.filter(token => token.type === 'list_item_open' && token.map && token.map[0] > index && token.map[0] < end)
			.map(token => /^[\t ]*/u.exec(lines[token.map![0]]!)![0].replace(/\t/gu, '    ').length - parentIndent).filter(indent => indent > 0);
		const delta = childIndents.length ? Math.min(...childIndents) : 0;
		const promoted = children.map(line => {
			const prefix = /^[\t ]*/u.exec(line)![0];
			return `${' '.repeat(Math.max(0, prefix.replace(/\t/gu, '    ').length - delta))}${line.slice(prefix.length)}`;
		});
		lines.splice(index, end - index, ...promoted);
	} else if (replacements.length > 1 && parseTaskLine(replacements[0]!)?.isDone && !parseTaskLine(replacements[1]!)?.isDone) {
		// 后续项排在完成项之后时，原子项继续属于原执行记录。
		lines.splice(index, end - index, replacements[0]!, ...children, ...replacements.slice(1));
	} else lines.splice(index, 1, ...replacements);
	return lines.join('\n');
}

/** 所有完整任务编辑共用定位与原子写入，避免用过期编辑覆盖外部修改。 */
export async function replaceTaskInFile(app: App, task: Pick<VaultTask, 'file' | 'line' | 'originalLine' | 'path'>, replacements: string[]): Promise<boolean> {
	let wrote = false;
	await app.vault.process(task.file, data => {
		if (readTaskSourceKind(task.path, data) !== 'tasks') throw new Error('任务来源已经变化，不能写入工作台或排除范围');
		const lines = data.split('\n');
		let index = lines[task.line] === task.originalLine ? task.line : -1;
		if (index < 0) {
			const matches = lines.flatMap((line, number) => line === task.originalLine ? [number] : []);
			if (matches.length === 1) index = matches[0]!;
		}
		if (index < 0) return data;
		if (replacements.some(line => !TASK_LINE_REGEX.test(line))) throw new Error('替换内容必须为完整的 Markdown 任务行');
		const identified = replacements.map(line => matchesTaskFilter(line) && !/\s+\^[\w-]+\s*$/u.test(line)
			? `${line.trimEnd()} ^task-${crypto.randomUUID()}` : line);
		wrote = true;
		return replaceTaskAndPreserveChildren(lines, index, identified);
	});
	if (wrote) invalidatePath(task.path);
	return wrote;
}

/**
 * Atomically flip a task's checkbox in its source file. Matches the exact
 * original line at its recorded position, then (if the file shifted) by a
 * unique full-line match; refuses to write if the line can't be located
 * unambiguously.
 */
export async function toggleTaskInFile(app: App, task: VaultTask, nextChecked: boolean): Promise<boolean> {
	let wrote = false;
	try {
		await app.vault.process(task.file, (data: string) => {
			const kind = readTaskSourceKind(task.path, data);
			if (task.formal ? kind !== 'tasks' : !task.checklist || kind !== 'checklists') throw new Error('任务来源已经变化，请刷新后重试');
			const lines = data.split('\n');
			const target = task.originalLine;
			let idx = lines[task.line] === target ? task.line : -1;
			if (idx === -1 && task.blockId) {
				const escaped = task.blockId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
				const block = new RegExp(`\\^${escaped}\\s*$`, 'u');
				const hits = lines.flatMap((line, index) => block.test(line) ? [index] : []);
				if (hits.length === 1) idx = hits[0]!;
			}
			if (idx === -1) {
				const hits: number[] = [];
				for (let i = 0; i < lines.length; i++) {
					if (lines[i] === target) hits.push(i);
				}
				if (hits.length === 1) idx = hits[0]!;
			}
			if (idx === -1) {
				wrote = false;
				return data;
			}
			const current = lines[idx]!;
			if (task.formal && !matchesTaskFilter(current)) throw new Error('任务过滤条件已经变化，请刷新后重试');
			if (task.formal && task.status !== undefined && parseTaskLine(current, task.path)?.status.symbol !== task.status) return data;
			const replacements = task.formal
				? parseTaskLine(current, task.path)!.toggleWithRecurrenceInUsersOrder().map(next => {
					const line = next.toFileLineString();
					return task.blockId && !next.blockLink ? `${line.trimEnd()} ^task-${crypto.randomUUID()}` : line;
				})
				: [current.replace(/([-*+][\t ]+)\[.\]/u, `$1[${nextChecked ? 'x' : ' '}]`)];
			if (replacements.length === 1 && replacements[0] === current) {
				wrote = false;
				return data;
			}
			wrote = true;
			return replaceTaskAndPreserveChildren(lines, idx, replacements);
		});
	} catch (err) {
		console.error('[Dashboard] alltasks toggle failed:', err);
		throw err;
	}
	return wrote;
}

export interface TaskDateFields {
	reminder?: string;
	due?: string;
	scheduled?: string;
	start?: string;
	end?: string;
}


/** Replace only the three independently editable date markers on a task line. */
export function updateTaskDateFields(line: string, fields: TaskDateFields): string {
	const current = parseTaskLine(line);
	const start = Object.hasOwn(fields, 'start') ? fields.start : current?.startDate?.format('YYYY-MM-DD');
	const end = Object.hasOwn(fields, 'end') ? fields.end : (line.match(END_FIELD_REGEX) ?? line.match(END_EMOJI_REGEX))?.[1];
	if (start && end && end.slice(0, 10) < start.slice(0, 10)) throw new Error('结束日期不能早于开始日期');
	const suffixMatch = line.match(/(\s+\^[a-zA-Z0-9-]+)?(\s*<!--collapsed-->)?\s*$/u);
	const suffix = suffixMatch?.[0] ?? '';
	let body = suffix ? line.slice(0, -suffix.length) : line;
	const rules: Record<keyof TaskDateFields, RegExp[]> = {
		reminder: [REMINDER_REGEX], due: [DUE_FIELD_REGEX, CALENDAR_REGEX], scheduled: [SCHEDULED_FIELD_REGEX, SCHEDULED_EMOJI_REGEX],
		start: [START_FIELD_REGEX, START_EMOJI_REGEX], end: [END_FIELD_REGEX, END_EMOJI_REGEX],
	};
	const markers: string[] = [];
	for (const key of Object.keys(fields) as Array<keyof TaskDateFields>) {
		const value = fields[key]?.trim() ?? '';
		if (value && !validateTaskDate(value)) throw new Error(`${key} 必须为有效的 YYYY-MM-DD 或 YYYY-MM-DD HH:MM`);
		for (const rule of rules[key]) body = body.replace(rule, '');
		body = body.replace(new RegExp(`\\s*\\[okf-${key}-time::[^\\]]+\\]`, 'gu'), '');
		if (value) markers.push(key === 'reminder' ? `⏰ ${value}` : `[${key}:: ${value}]`);
	}
	body = body.trimEnd();
	return `${body}${markers.length > 0 ? ` ${markers.join(' ')}` : ''}${suffix}`;
}

/** Update task dates after re-locating the task by stable block ID or an unambiguous original line. */
export async function updateTaskDatesInFile(
	app: App,
	task: VaultTask,
	fields: TaskDateFields,
): Promise<boolean> {
	let wrote = false;
	await app.vault.process(task.file, (data: string) => {
		if (readTaskSourceKind(task.path, data) !== 'tasks') throw new Error('任务来源已经变化，请刷新后重试');
		const lines = data.split('\n');
		let idx = lines[task.line] === task.originalLine ? task.line : -1;
		if (idx === -1 && task.blockId) {
			const escaped = task.blockId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
			const block = new RegExp(`\\^${escaped}\\s*(?:<!--collapsed-->\\s*)?$`, 'u');
			const hits = lines.flatMap((line, index) => block.test(line) ? [index] : []);
			if (hits.length === 1) idx = hits[0]!;
		}
		if (idx === -1) {
			const hits = lines.flatMap((line, index) => line === task.originalLine ? [index] : []);
			if (hits.length === 1) idx = hits[0]!;
		}
		if (idx === -1) return data;
		const updated = updateTaskDateFields(lines[idx]!, fields);
		const parsed = parseTaskLine(updated, task.path);
		if (!parsed) throw new Error('任务格式已经变化，日期尚未保存');
		const replacement = parsed.toFileLineString();
		if (replacement === lines[idx]) return data;
		lines[idx] = fields.reminder && !task.blockId && !/\s+\^[\w-]+\s*$/u.test(replacement)
			? `${replacement} ^task-${crypto.randomUUID()}` : replacement;
		wrote = true;
		return lines.join('\n');
	});
	if (wrote) invalidatePath(task.path);
	return wrote;
}

/* ----------------------------- bucketing ----------------------------- */

export type DateBucket = 'overdue' | 'today' | 'week' | 'later' | 'nodue';
export type PriorityBucket = Priority | 'none';

export const DATE_BUCKET_ORDER: DateBucket[] = ['overdue', 'today', 'week', 'later', 'nodue'];
export const PRIORITY_BUCKET_ORDER: PriorityBucket[] = ['high', 'medium', 'low', 'none'];

/** i18n key suffix for each date bucket. */
export const DATE_BUCKET_I18N: Record<DateBucket, string> = {
	overdue: 'Overdue',
	today: 'Today',
	week: 'ThisWeek',
	later: 'Later',
	nodue: 'NoDue',
};
/** i18n key suffix for each priority bucket. */
export const PRIORITY_BUCKET_I18N: Record<PriorityBucket, string> = {
	high: 'High',
	medium: 'Medium',
	low: 'Low',
	none: 'None',
};

function parseDueDate(s: string): Date | null {
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
	if (!m) return null;
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? '0'), Number(m[5] ?? '0'));
}

function startOfDay(d: Date): Date {
	const x = new Date(d);
	x.setHours(0, 0, 0, 0);
	return x;
}

/** Classify a task's due date into a bucket relative to `now` (local time). */
export function dateBucketOf(due: string | undefined, now: Date = new Date()): DateBucket {
	if (!due) return 'nodue';
	const d = parseDueDate(due);
	if (!d) return 'nodue';
	const today = startOfDay(now).getTime();
	const dueDay = startOfDay(d).getTime();
	if (dueDay < today) return 'overdue';
	if (dueDay === today) return 'today';
	const daysSinceMonday = (now.getDay() + 6) % 7;
	const monday = today - daysSinceMonday * 86400000;
	const nextMonday = monday + 7 * 86400000;
	if (dueDay >= monday && dueDay < nextMonday) return 'week';
	return 'later';
}

export function priorityBucketOf(task: VaultTask): PriorityBucket {
	return task.priority ?? 'none';
}

export interface TaskGroup {
	key: string;
	tasks: VaultTask[];
}

/** Group tasks by the chosen dimension, returning every bucket in fixed order. */
export function groupTasks(tasks: VaultTask[], groupBy: TaskGroupBy): TaskGroup[] {
	if (groupBy === 'none') {
		return [{ key: 'all', tasks }];
	}
	if (groupBy === 'priority') {
		return PRIORITY_BUCKET_ORDER.map(key => ({
			key,
			tasks: tasks.filter(t => priorityBucketOf(t) === key),
		}));
	}
	return DATE_BUCKET_ORDER.map(key => ({
		key,
		tasks: tasks.filter(t => dateBucketOf(t.due) === key),
	}));
}

/* --------------------------- calendar support --------------------------- */

/** Max number of days a multi-day span may cover (guards against pathological ranges). */
const MAX_SPAN_DAYS = 366;

/**
 * A task is calendar-relevant if it carries any recognized calendar date.
 * Completion alone does NOT capture: a done checkbox whose only date marker
 * is ✅ / `[completion::]` is history, not a schedule. Tasks that also carry
 * a due/start/end/scheduled date keep every anchor, including their
 * completion-day one (see indexTasksByDay).
 */
export function isCalendarRelevant(task: VaultTask): boolean {
	return Boolean(task.reminder || task.due || task.start || task.end || task.scheduled);
}

/** Why a task occupies a given calendar day. Renderers use this to pick the
 * time label and origin marker. Marker precedence: completion > reminder >
 * scheduled > due > span (the most specific fact for that day wins). */
export type CalendarDayKind = 'completion' | 'cancelled' | 'reminder' | 'scheduled' | 'due' | 'span';

export function taskDayKind(task: VaultTask, iso: string): CalendarDayKind {
	if (task.calendarEventKind) return task.calendarEventKind;
	if (task.completion && task.completion === iso) return 'completion';
	if (task.cancelled && task.cancelled === iso) return 'cancelled';
	if (task.reminder && task.reminder.slice(0, 10) === iso) return 'reminder';
	if (task.scheduled && task.scheduled === iso) return 'scheduled';
	if (task.due && task.due === iso) return 'due';
	return 'span';
}

/**
 * Inclusive [start, end] day range (YYYY-MM-DD) a task occupies on a calendar.
 * Falls back to the due date as a single day when no start/end window exists.
 * Returns null for tasks with no date at all.
 */
export function calendarSpan(task: VaultTask): { start: string; end: string } | null {
	if (task.start && task.end) {
		return task.start <= task.end ? { start: task.start, end: task.end } : { start: task.end, end: task.start };
	}
	if (task.start) return { start: task.start, end: task.start };
	if (task.end) return { start: task.end, end: task.end };
	if (task.due) return { start: task.due, end: task.due };
	return null;
}

function addDaysIso(iso: string, days: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(y!, (m ?? 1) - 1, d ?? 1);
	dt.setDate(dt.getDate() + days);
	const yy = dt.getFullYear();
	const mm = String(dt.getMonth() + 1).padStart(2, '0');
	const dd = String(dt.getDate()).padStart(2, '0');
	return `${yy}-${mm}-${dd}`;
}

/**
 * Index calendar-relevant tasks by every day they occupy. A task's days are the
 * union of: its start/end span (capped at MAX_SPAN_DAYS), its scheduled day,
 * its due day, and its completion day — a task with both a scheduled and a due
 * date shows on both days; same-day overlaps dedup via the Set. Tasks with no
 * date are skipped.
 */
export function indexTasksByDay(tasks: VaultTask[]): Map<string, VaultTask[]> {
	const byDay = new Map<string, VaultTask[]>();
	for (const task of tasks) {
		const days = new Set<string>();
		const span = calendarSpan(task);
		if (span) {
			let cursor = span.start;
			let guard = 0;
			while (guard <= MAX_SPAN_DAYS) {
				days.add(cursor);
				if (cursor >= span.end) break;
				cursor = addDaysIso(cursor, 1);
				guard++;
			}
		}
		if (task.scheduled) days.add(task.scheduled);
		if (task.due) days.add(task.due);
		if (task.reminder) days.add(task.reminder.slice(0, 10));
		if (task.completion) days.add(task.completion);
		if (task.cancelled) days.add(task.cancelled);
		for (const iso of days) {
			const list = byDay.get(iso);
			if (list) list.push(task);
			else byDay.set(iso, [task]);
		}
	}
	return byDay;
}

/** "YYYY-MM-DD" for a given local Date. */
export function toIsoDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

/* ------------------------- task view filters ------------------------- */

/** Mutually-exclusive task filters for the full-screen calendar. */
export type CalendarTaskFilter = 'formal' | 'all' | 'due' | 'start' | 'active' | 'open';
/** Display order of the filter options. */
export const CALENDAR_TASK_FILTERS: readonly CalendarTaskFilter[] = ['formal', 'all', 'due', 'start', 'active', 'open'];

/**
 * Task-level filter predicate. `todayIso` (YYYY-MM-DD) is injected so the
 * 'active' boundary is testable and recomputed on every render.
 *  - all: everything
 *  - due: has a due date (⏰ / 📅 / `[due::]` — the scanner folds ⏰ into due)
 *  - start: has a start date (🛫 / `[start::]`)
 *  - active: unchecked, started, and today ∈ [start, end] (no end = ongoing
 *    until checked off)
 *  - open: unchecked
 */
export function matchesCalendarFilter(task: VaultTask, filter: CalendarTaskFilter, todayIso: string): boolean {
	switch (filter) {
		case 'formal': return task.formal;
		case 'all': return true;
		case 'due': return Boolean(task.due);
		case 'start': return Boolean(task.start);
		case 'active': {
			if (task.checked) return false;
			const start = task.start;
			if (!start) return false;
			const end = task.end;
			return start <= todayIso && (!end || end >= todayIso);
		}
		case 'open': return !task.checked;
	}
}

/**
 * Task-level view over a day-indexed map: keeps every day entry of tasks that
 * pass the filter and drops now-empty days. 'all' returns the same map
 * (zero-copy). Filtering selects tasks, not anchors — a kept task shows all
 * its day anchors and span bars.
 */
export function filterTasksByDay(
	byDay: Map<string, VaultTask[]>,
	filter: CalendarTaskFilter,
	todayIso: string,
): Map<string, VaultTask[]> {
	if (filter === 'all') return byDay;
	const out = new Map<string, VaultTask[]>();
	for (const [iso, tasks] of byDay) {
		const kept = tasks.filter(task => matchesCalendarFilter(task, filter, todayIso));
		if (kept.length > 0) out.set(iso, kept);
	}
	return out;
}

/* ------------------------- task line building ------------------------- */

/** One optional time group of the calendar add-task form: a date
 *  (YYYY-MM-DD), a time-of-day (HH:MM), or both. An empty group (no date, no
 *  time) writes no marker at all. */
export interface TaskTimeInput {
	date?: string;
	time?: string;
}

/** Normalize one group into a `YYYY-MM-DD( HH:MM)` marker value; undefined
 *  when the group is empty. A time-only group anchors to `dayIso`. */
function markerValue(input: TaskTimeInput | undefined, dayIso: string): string | undefined {
	if (!input) return undefined;
	const date = (input.date ?? '').trim();
	const time = (input.time ?? '').trim();
	if (!date && !time) return undefined;
	return `${date || dayIso}${time ? ` ${time}` : ''}`;
}

/**
 * Assemble the checkbox line the calendar's add-task form writes:
 * `- [ ] <title>` plus `[start:: …]` / `[due:: …]` / `[scheduled:: …]`
 * markers for every non-empty group, in that order. Field forms (not the
 * 🛫/⏳/📅 emoji) because only they carry a time-of-day.
 *
 * A task with NO group keeps the historical date-only anchor `📅 <dayIso>`
 * so it still lands on the clicked calendar day.
 */
export function buildTaskLine(
	title: string,
	dayIso: string,
	times: { start?: TaskTimeInput; due?: TaskTimeInput; scheduled?: TaskTimeInput },
	defaultDate: 'due' | 'scheduled' = 'due',
): string {
	const parts: string[] = [];
	const start = markerValue(times.start, dayIso);
	const due = markerValue(times.due, dayIso);
	const scheduled = markerValue(times.scheduled, dayIso);
	if (start) parts.push(`[start:: ${start}]`);
	if (due) parts.push(`[due:: ${due}]`);
	if (scheduled) parts.push(`[scheduled:: ${scheduled}]`);
	if (parts.length === 0) parts.push(`${defaultDate === 'scheduled' ? '⏳' : '📅'} ${dayIso}`);
	return `- [ ] ${title} ${parts.join(' ')}`;
}

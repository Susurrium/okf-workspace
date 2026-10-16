import { App, Menu, Modal, Notice, setIcon } from 'obsidian';
import type { TFile } from 'obsidian';
import { t } from './i18n';
import { renderTextWithLinks } from './renderer';
import { renderMonthGrid, renderWeekTimeGrid, mondayOf, taskDayTimeRange, byDayTaskTime, appendDayOriginMark } from './calendar-grid';
import {
	CALENDAR_TASK_FILTERS,
	filterTasksByDay,
	toIsoDate,
	buildTaskLine,
	type CalendarTaskFilter,
	type TaskTimeInput,
	type VaultTask,
} from './alltasks-scan';
import { insertTaskForDay, type TaskInsertTarget } from './daily-notes';
import { createTaskNote } from './calendar-task-note';
import { renderTaskCheckbox } from './task-checkbox';
import { applyModalTheme } from './modal-theme';
import { getRegisteredApexHost } from './host';
import type { DashboardSettings } from './types';
import { calendarScopeControls, readCalendarScope, filterCalendarScope, calendarTimeEvents, type CalendarScope } from './calendar-scope';
import { scanFileTasks, indexTasksByDay } from './alltasks-scan';

interface CalendarModalCallbacks {
	onToggle: (task: VaultTask, nextChecked: boolean) => Promise<boolean | void> | boolean | void;
	/** Open a task's source note, optionally scrolling to the task's line. */
	onOpenNote?: (file: TFile, line?: number) => void;
}

/** Minimal plugin surface needed to persist the calendar task filter. */
type DashboardPluginHandle = {
	settings?: DashboardSettings;
	saveSettings?: () => Promise<void>;
};

/** Live plugin lookup (same pattern as renderer.ts's countdown settings path). */
function lookupDashboardPlugin(app: App): DashboardPluginHandle | undefined {
	const registered = getRegisteredApexHost();
	if (registered) return registered;
	return (app as unknown as { plugins?: { plugins?: Record<string, DashboardPluginHandle> } })
		.plugins?.plugins?.['apex-dashboard'];
}

/** Current persisted filter; unknown or hand-edited values normalize to 'all'.
 *  Shared with the calendar section (the choice applies to both surfaces). */
export function readCalendarTaskFilter(app: App): CalendarTaskFilter {
	const raw = lookupDashboardPlugin(app)?.settings?.calendarTaskFilter;
	return raw !== undefined && CALENDAR_TASK_FILTERS.includes(raw) ? raw : 'all';
}

/** Persist the filter (spread-replace + save). When the plugin can't be
 *  reached the in-view choice still applies for this session. */
export function writeCalendarTaskFilter(app: App, filter: CalendarTaskFilter): void {
	const plugin = lookupDashboardPlugin(app);
	if (!plugin?.settings) return;
	plugin.settings = { ...plugin.settings, calendarTaskFilter: filter };
	void plugin.saveSettings?.();
}

export function readCalendarScopeForApp(app: App): CalendarScope { return readCalendarScope({ ...lookupDashboardPlugin(app)?.settings }); }
export async function writeCalendarScopeForApp(app: App, scope: CalendarScope): Promise<void> {
	const plugin = lookupDashboardPlugin(app);
	if (!plugin?.settings || !plugin.saveSettings) throw new Error('日历配置尚未初始化');
	plugin.settings = { ...plugin.settings, ...scope };
	await plugin.saveSettings();
}

/** User-pinned destination override (undefined = the daily-note chain). */
function readTaskTarget(app: App): import('./types').CalendarTaskTarget | undefined {
	const target = lookupDashboardPlugin(app)?.settings?.calendarTaskTarget;
	return target && target.path?.trim() && (target.kind === 'file' || target.kind === 'folder' || target.kind === 'note')
		? target
		: undefined;
}

/** Where calendar-added tasks land in the day's note; anything but 'end'
 *  (including an unreachable plugin) keeps the historical 'start' behavior. */
function readTaskInsertPosition(app: App): 'start' | 'end' {
	return lookupDashboardPlugin(app)?.settings?.calendarTaskInsertPosition === 'end' ? 'end' : 'start';
}

/**
 * Full-screen month grid: navigate any month, toggle tasks inline (writes back
 * via onToggle), click a task to open its source note. Receives a fully indexed
 * day map so navigation across months needs no re-scan.
 */
export class CalendarMonthModal extends Modal {
	private readonly byDay: Map<string, VaultTask[]>;
	private year: number;
	private month: number;
	private view: 'month' | 'week';
	private weekStart: Date;
	private readonly cb: CalendarModalCallbacks;
	/** Vault path of the dashboard file, forwarded to day agendas opened from
	 *  bar clicks (their add-task fallback destination). */
	private readonly dashboardFile?: string;
	/** Active task filter (which tasks may occupy the grid), persisted in
	 *  plugin settings so the choice survives across sessions. */
	private filter: CalendarTaskFilter;
	private calendarScope: CalendarScope;

	constructor(
		app: App,
		byDay: Map<string, VaultTask[]>,
		cb: CalendarModalCallbacks,
		initialView: 'month' | 'week' = 'month',
		initialWeekStart?: Date,
		dashboardFile?: string,
	) {
		super(app);
		this.byDay = byDay;
		this.cb = cb;
		this.dashboardFile = dashboardFile;
		this.filter = readCalendarTaskFilter(app);
		this.calendarScope = readCalendarScopeForApp(app);
		const now = new Date();
		this.year = now.getFullYear();
		this.month = now.getMonth();
		this.view = initialView;
		this.weekStart = initialWeekStart ?? mondayOf(now);
	}

	onOpen(): void {
		const { contentEl, containerEl, modalEl } = this;
		contentEl.empty();
		contentEl.addClass('dashboard-calendar-fullscreen');
		modalEl.addClass('dashboard-calendar-fullscreen-modal');
		applyModalTheme(containerEl);
		containerEl.addClass('modal--dashboard');
		containerEl.setCssProps({
			background: 'transparent',
			backgroundColor: 'transparent',
			border: 'none',
			boxShadow: 'none',
		});
		this.scope.register([], 'ArrowLeft', () => { this.shift(-1); return false; });
		this.scope.register([], 'ArrowRight', () => { this.shift(1); return false; });
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const container = contentEl.createDiv({ cls: 'dashboard-modal dashboard-calendar-fullscreen-inner' });

		const header = container.createDiv({ cls: 'dashboard-modal-header dashboard-calendar-nav' });
		const prev = header.createDiv({ cls: 'dashboard-calendar-nav-btn' });
		setIcon(prev, 'chevron-left');
		prev.addEventListener('click', () => this.shift(-1));
		const labelEl = header.createDiv({ cls: 'dashboard-modal-title dashboard-calendar-nav-label' });
		const next = header.createDiv({ cls: 'dashboard-calendar-nav-btn' });
		setIcon(next, 'chevron-right');
		next.addEventListener('click', () => this.shift(1));

		// Month | Week toggle
		const viewToggle = header.createDiv({ cls: 'dashboard-library-view-toggle dashboard-calendar-view-toggle' });
		(['month', 'week'] as const).forEach((v) => {
			const btn = viewToggle.createDiv({
				cls: 'dashboard-library-view-btn' + (v === this.view ? ' active' : ''),
				attr: { 'aria-label': v === 'month' ? t('calendar.viewMonth') : t('calendar.viewWeek') },
			});
			setIcon(btn, v === 'month' ? 'calendar' : 'calendar-range');
			btn.addEventListener('click', () => {
				if (this.view === v) return;
				this.view = v;
				if (v === 'week') this.weekStart = mondayOf(new Date());
				this.render();
			});
		});

		const todayBtn = header.createEl('button', { cls: 'dashboard-modal-btn dashboard-modal-btn--cancel', text: t('calendar.today') });
		todayBtn.addEventListener('click', () => {
			const now = new Date();
			this.year = now.getFullYear();
			this.month = now.getMonth();
			this.weekStart = mondayOf(now);
			this.render();
		});

		// Task filter: narrows WHICH tasks occupy the grid (kept tasks show all
		// their anchors). Dropdown via Obsidian's Menu — native checkmark,
		// dismiss and mobile behavior, no custom popover lifecycle to manage.
		const filterBtn = header.createEl('button', {
			cls: 'dashboard-modal-btn dashboard-modal-btn--cancel dashboard-calendar-filter-btn'
				+ (this.filter !== 'all' ? ' is-filtered' : ''),
			attr: { 'aria-haspopup': 'menu', 'aria-label': t('calendar.filter'), type: 'button' },
		});
		setIcon(filterBtn, 'filter');
		filterBtn.createSpan({ cls: 'dashboard-calendar-filter-label', text: t(`calendar.filter.${this.filter}`) });
		const caret = filterBtn.createSpan({ cls: 'dashboard-calendar-filter-caret' });
		setIcon(caret, 'chevron-down');
		filterBtn.addEventListener('click', (e) => this.showFilterMenu(e, filterBtn));
		calendarScopeControls(header, this.app, this.calendarScope, async scope => {
			await writeCalendarScopeForApp(this.app, scope); this.calendarScope = scope; this.render();
		});

		// Filtered day view, recomputed every render (nav, view switch, toggle
		// and filter changes all re-render) so the 'active' today-boundary and
		// checked-drops-out behavior stay fresh.
		const viewByDay = filterCalendarScope(filterTasksByDay(this.byDay, this.filter, toIsoDate(new Date())), this.calendarScope);

		const body = container.createDiv({ cls: 'dashboard-modal-body dashboard-calendar-fullscreen-body' });
		const gridOpts = {
			compact: false as const,
			app: this.app,
			onToggle: (task: VaultTask, next: boolean) => { void this.toggle(task, next); },
			onOpenNote: this.cb.onOpenNote,
			onBarClick: (iso: string) => {
				new DayAgendaModal(this.app, iso, viewByDay.get(iso) ?? [], this.cb, this.dashboardFile).open();
			},
			// Day numbers (month) / day headers (week): open the day agenda with
			// the add-task input focused, so tap-type-Enter adds in one flow.
			onDayNumClick: (iso: string) => {
				new DayAgendaModal(this.app, iso, viewByDay.get(iso) ?? [], this.cb, this.dashboardFile, true).open();
			},
		};
		const { label } = this.view === 'week'
			? renderWeekTimeGrid(body, this.weekStart, calendarTimeEvents(viewByDay, this.calendarScope.calendarDateFact), gridOpts)
			: renderMonthGrid(body, this.year, this.month, viewByDay, gridOpts);
		labelEl.textContent = label;
	}

	private shift(delta: number): void {
		if (this.view === 'week') {
			const d = new Date(this.weekStart);
			d.setDate(this.weekStart.getDate() + delta * 7);
			this.weekStart = d;
		} else {
			let m = this.month + delta;
			let y = this.year;
			while (m < 0) { m += 12; y -= 1; }
			while (m > 11) { m -= 12; y += 1; }
			this.month = m;
			this.year = y;
		}
		this.render();
	}

	/** Open the filter dropdown anchored to its button. The Menu owns its own
	 *  Escape / click-outside dismissal, so the modal's key scope (and its
	 *  ArrowLeft/Right paging) is never involved. */
	private showFilterMenu(evt: MouseEvent, anchor: HTMLElement): void {
		const menu = new Menu();
		for (const f of (['formal', 'all', ...(!['formal', 'all'].includes(this.filter) ? [this.filter] : [])] as CalendarTaskFilter[])) {
			menu.addItem(item => item
				.setTitle(t(`calendar.filter.${f}`))
				.setChecked(f === this.filter)
				.onClick(() => this.applyFilter(f)));
		}
		anchor.setAttribute('aria-expanded', 'true');
		menu.onHide(() => anchor.setAttribute('aria-expanded', 'false'));
		menu.showAtMouseEvent(evt);
	}

	/** Switch the active filter, persist it, and re-render the grid. */
	private applyFilter(filter: CalendarTaskFilter): void {
		if (filter === this.filter) return;
		this.filter = filter;
		writeCalendarTaskFilter(this.app, filter);
		this.render();
	}

	private async toggle(task: VaultTask, nextChecked: boolean): Promise<boolean> {
		if (await this.cb.onToggle(task, nextChecked) === false) return false;
		task.checked = nextChecked;
		this.render();
		return true;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Compact single-day agenda: lists one day's tasks with checkboxes + open buttons. */
export class DayAgendaModal extends Modal {
	private readonly iso: string;
	private tasks: VaultTask[];
	private readonly cb: CalendarModalCallbacks;
	/** Vault path (no .md required) of the dashboard file, used as the fallback
	 *  destination when the day has no daily note yet. */
	private readonly dashboardFile?: string;
	/** Focus the add-task input on open — for entries that imply "add something"
	 *  (calendar day-number clicks) rather than "browse the day" (bar clicks). */
	private readonly focusAddInput: boolean;

	constructor(app: App, iso: string, tasks: VaultTask[], cb: CalendarModalCallbacks, dashboardFile?: string, focusAddInput = false) {
		super(app);
		this.iso = iso;
		this.tasks = tasks;
		this.cb = cb;
		this.dashboardFile = dashboardFile;
		this.focusAddInput = focusAddInput;
	}

	onOpen(): void {
		const { contentEl, containerEl } = this;
		contentEl.empty();
		contentEl.addClass('dashboard-library-config-modal');
		containerEl.addClass('modal--dashboard');
		containerEl.parentElement?.addClass('modal-bg--dashboard');
		applyModalTheme(containerEl);
		containerEl.setCssProps({
			background: 'transparent',
			backgroundColor: 'transparent',
			border: 'none',
			boxShadow: 'none',
		});

		const container = contentEl.createDiv({ cls: 'dashboard-modal dashboard-modal--compact' });
		const header = container.createDiv({ cls: 'dashboard-modal-header' });
		header.createDiv({ cls: 'dashboard-modal-title', text: `${this.iso} · ${t('calendar.dayAgenda')}` });

		const body = container.createDiv({ cls: 'dashboard-modal-body' });

		// Add-task row: optional time (HH:MM) + title + Add. Goes into this
		// day's daily note (top or bottom, per the calendar setting), else —
		// when that day has no note yet (e.g. a future date) — into today's
		// daily note, the date markers keeping the task on its calendar days;
		// see insertTaskForDay.
		const addRow = body.createDiv({ cls: 'dashboard-cal-day-add' });
		const titleInput = addRow.createEl('input', {
			cls: 'dashboard-modal-input dashboard-cal-day-add-title',
			attr: { type: 'text', placeholder: t('calendar.addTaskPlaceholder') },
		});
		// Optional time groups: start / deadline / scheduled, each date+time.
		// A time-only group anchors to this day; leave all empty for a plain
		// date-only task on this day. buildTaskLine assembles the markers.
		const timesRow = body.createDiv({ cls: 'dashboard-cal-day-times' });
		const groups: Array<{ key: 'start' | 'due' | 'scheduled'; date: HTMLInputElement; time: HTMLInputElement }> = [];
		for (const key of ['start', 'due', 'scheduled'] as const) {
			const group = timesRow.createDiv({ cls: 'dashboard-cal-day-times-group' });
			group.createDiv({ cls: 'dashboard-cal-day-times-label', text: t(`calendar.taskTime.${key}`) });
			const date = group.createEl('input', {
				cls: 'dashboard-modal-input dashboard-cal-day-times-date',
				attr: { type: 'date', 'aria-label': `${t(`calendar.taskTime.${key}`)} · ${t('calendar.taskDate')}` },
			});
			const time = group.createEl('input', {
				cls: 'dashboard-modal-input dashboard-cal-day-times-time',
				attr: { type: 'time', 'aria-label': `${t(`calendar.taskTime.${key}`)} · ${t('calendar.taskTime')}` },
			});
			groups.push({ key, date, time });
		}
		const addTask = (): Promise<void> => this.addTask(titleInput, groups);
		titleInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); void addTask(); }
		});
		const addBtn = addRow.createEl('button', {
			cls: 'dashboard-modal-btn dashboard-modal-btn--confirm dashboard-cal-day-add-btn',
			text: t('calendar.addTask'),
		});
		addBtn.addEventListener('click', () => void addTask());
		const registered = getRegisteredApexHost();
		if (registered?.createTask) addRow.createEl('button', { text: '完整新建', attr: { type: 'button' } }).addEventListener('click', () => registered.createTask?.(this.iso));

		if (this.tasks.length === 0) {
			body.createDiv({ cls: 'dashboard-library-empty', text: t('calendar.noEvents') });
		} else {
			const list = body.createDiv({ cls: 'dashboard-alltasks-list' });
			for (const task of [...this.tasks].sort(byDayTaskTime(this.iso))) {
				list.appendChild(this.renderRow(task));
			}
		}

		const footer = container.createDiv({ cls: 'dashboard-modal-footer' });
		footer.createEl('button', {
			cls: 'dashboard-modal-btn dashboard-modal-btn--cancel',
			text: t('common.close'),
		}).addEventListener('click', () => this.close());

		if (this.focusAddInput) titleInput.focus();
	}

	private renderRow(task: VaultTask): HTMLElement {
		const row = createDiv();
		row.className = 'dashboard-alltasks-row' + (task.checked ? ' is-done' : '');
		renderTaskCheckbox(row, { text: task.text, checked: task.checked, className: 'dashboard-alltasks-check',
			toggle: checked => this.toggle(task, checked), notifyConflict: false, notify: message => new Notice(message) });

		const tm = taskDayTimeRange(task, this.iso);
		if (tm) row.createDiv({ cls: 'dashboard-calendar-event-time', text: tm });
		appendDayOriginMark(row, task, this.iso);

		if (task.priority) {
			row.createDiv({ cls: `dashboard-alltasks-prio dashboard-alltasks-prio--${task.priority}`, text: task.priority[0]!.toUpperCase() });
		}
		const bodyEl = row.createDiv({ cls: 'dashboard-alltasks-body' });
		const textEl = bodyEl.createDiv({ cls: 'dashboard-alltasks-text' });
		renderTextWithLinks(textEl, task.text, this.app);
		const registered = getRegisteredApexHost();
		if (registered?.editTask && task.formal) {
			textEl.setAttribute('role', 'button'); textEl.setAttribute('tabindex', '0');
			textEl.addEventListener('click', event => { if ((event.target as HTMLElement).closest('a')) return; event.stopPropagation(); void registered.editTask?.(task).catch(error => new Notice(String(error))); });
			textEl.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void registered.editTask?.(task).catch(error => new Notice(String(error))); } });
		}
		if (registered?.editTaskDates) row.createEl('button', { text: '安排', attr: { type: 'button' } }).addEventListener('click', event => { event.stopPropagation(); registered.editTaskDates?.(task); });

		const source = row.createDiv({ cls: 'dashboard-alltasks-source' });
		const chip = source.createDiv({ cls: 'dashboard-alltasks-chip', text: task.file.basename });
		chip.title = task.path;
		chip.setAttribute('role', 'button');
		chip.addEventListener('click', (e) => { e.stopPropagation();
			if (registered?.openTaskSource) void registered.openTaskSource(task).catch(error => new Notice(String(error)));
			else this.cb.onOpenNote?.(task.file, task.line); });

		// 来源跳转保留；任务标题和日期按钮分别打开对应编辑界面。
		if (this.cb.onOpenNote) {
			row.addClass('is-jumpable');
			row.addEventListener('click', (e) => {
				const target = e.target as HTMLElement;
				if (target.tagName === 'INPUT' || target.closest('a,button,[role=button]')) return;
				this.cb.onOpenNote?.(task.file, task.line);
			});
		}
		return row;
	}

	/** Add the entered task for this day. Time groups (start / deadline /
	 *  scheduled, each an optional date + time) become [start::]/[due::]/
	 *  [scheduled::] markers — a time-only group anchors to this day, and a
	 *  日期未指定时使用宿主声明的默认日期含义。Destination per
	 *  the calendar settings (default daily-note chain / pinned file or
	 *  folder / a new note per task). */
	private async addTask(
		titleInput: HTMLInputElement,
		groups: Array<{ key: 'start' | 'due' | 'scheduled'; date: HTMLInputElement; time: HTMLInputElement }>,
	): Promise<void> {
		const title = titleInput.value.trim();
		if (!title) return;
		const times: { start?: TaskTimeInput; due?: TaskTimeInput; scheduled?: TaskTimeInput } = {};
		for (const g of groups) {
			times[g.key] = { date: g.date.value, time: g.time.value };
		}
		const rawLine = buildTaskLine(title, this.iso, times, getRegisteredApexHost()?.calendarDefaultDate ?? 'due');
		const line = getRegisteredApexHost()?.prepareTaskLine?.(rawLine) ?? rawLine;

		let target: TaskInsertTarget | null = null;
		try {
			const host = getRegisteredApexHost();
			// 'note' target: every task gets its own brand-new note (optionally
			// template-seeded); the file/folder/default kinds go through the
			// shared daily-note chain.
			const targetCfg = readTaskTarget(this.app);
			if (targetCfg && targetCfg.kind !== 'note') {
				const path = targetCfg.kind === 'folder' ? `${targetCfg.path}/${this.iso}.md` : targetCfg.path.endsWith('.md') ? targetCfg.path : `${targetCfg.path}.md`;
				const file = this.app.vault.getFileByPath(path);
				if (file && host?.canWriteTaskTarget && !host.canWriteTaskTarget(file)) throw new Error('此日历目标不能保存人工待办');
			}
			const position = readTaskInsertPosition(this.app);
			if (!targetCfg && host?.insertCalendarTask) {
				target = await host.insertCalendarTask(this.iso, line, position);
			} else if (targetCfg?.kind === 'note') {
				const res = await createTaskNote(this.app, {
					iso: this.iso,
					taskLine: line,
					folder: targetCfg.path,
					templatePath: targetCfg.templatePath,
					untitled: t('calendar.taskUntitled'),
				});
				if (res.templateMissing) {
					new Notice(t('calendar.taskNoteTemplateMissing'), 4000);
				}
				target = res;
			} else {
				target = await insertTaskForDay(this.app, this.iso, line, this.dashboardFile, position, targetCfg);
			}
		} catch (err) {
			console.error('[Dashboard] add task failed:', err);
			new Notice(t('calendar.taskAddFailed'), 4000);
			return;
		}
		if (!target) {
			new Notice(t('calendar.dailyNotesDisabled'), 5000);
			return;
		}
		new Notice(t(
			target.kind === 'dashboard-list' ? 'calendar.taskAddedDashboard'
				: target.kind === 'note-created' ? 'calendar.taskAddedNote'
					: 'calendar.taskAddedDaily',
			{ path: target.file.path },
		), 3000);

		// Optimistic: show the new task immediately at its time slot. The
		// calendar section also re-scans automatically on the vault write event.
		// The row mirrors what scanFileTasks will parse back from the line; a
		// task anchored entirely to OTHER days (cross-day groups) shows there,
		// not in this agenda, so it is not appended here.
		try {
			const actual = scanFileTasks(target.file, await this.app.vault.read(target.file)).find(task => task.originalLine === target.writtenLine);
			if (!actual) throw new Error('无法重新读取实际任务');
			if (indexTasksByDay([actual]).has(this.iso)) this.tasks = [...this.tasks, actual].sort(byDayTaskTime(this.iso));
		} catch (error) {
			new Notice(`任务已写入 ${target.file.path}，界面刷新失败：${error instanceof Error ? error.message : String(error)}`, 8000);
			return;
		}
		titleInput.value = '';
		for (const g of groups) { g.date.value = ''; g.time.value = ''; }
		this.onOpen();
	}

	private async toggle(task: VaultTask, nextChecked: boolean): Promise<boolean> {
		if (await this.cb.onToggle(task, nextChecked) === false) return false;
		task.checked = nextChecked;
		this.onOpen();
		return true;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export { toIsoDate };

import { App, Menu, Notice, Platform, setIcon, TFile } from 'obsidian';
import { t } from './i18n';
import type { DashboardSettings } from './types';
import {
	CALENDAR_TASK_FILTERS,
	collectVaultTasks,
	filterTasksByDay,
	indexTasksByDay,
	invalidatePath,
	isCalendarRelevant,
	toIsoDate,
	toggleTaskInFile,
	type CalendarTaskFilter,
	type VaultTask,
} from './alltasks-scan';
import { renderMonthGrid, renderWeekTimeGrid, mondayOf } from './calendar-grid';
import { DayAgendaModal, readCalendarTaskFilter, writeCalendarTaskFilter } from './calendar-modal';
import { closeDayPreview, scheduleDayPreview } from './calendar-widget';
import { calendarScopeControls, filterCalendarScope, readCalendarScope, calendarTimeEvents } from './calendar-scope';
import { writeCalendarScopeForApp } from './calendar-modal';

/** Per-section reload functions keyed by the section's host element, so vault
 *  task changes refresh the grid in place (re-scan + re-render into the live
 *  body) without rebuilding the section — month/week navigation and the active
 *  filter survive. WeakMap: discarded section DOM releases its entry.
 *  Mirrors the sidebar widget's widgetReloaders discipline. */
const sectionReloaders = new WeakMap<HTMLElement, () => Promise<void>>();

/** Re-scan tasks and re-render every live calendar section's grid in place.
 *  Returns true when at least one section was refreshed. */
export function refreshCalendarSections(kanban: HTMLElement): boolean {
	let any = false;
	const sections = kanban.querySelectorAll<HTMLElement>('.dashboard-calendar-section');
	for (let i = 0; i < sections.length; i++) {
		const el = sections[i]!;
		const reload = sectionReloaders.get(el);
		if (!reload) continue;
		void reload();
		any = true;
	}
	return any;
}

/**
 * Calendar section: the sidebar calendar widget's enlarged view (full month
 * grid with multi-day bars / week time grid) embedded as a board section.
 * Behavior is identical to the full-screen modal: navigate any month or week,
 * toggle tasks inline (writes back to the source note), click a task to open
 * its note, click a day number / bar to open that day's agenda and add tasks
 * (into the day's daily note, falling back per insertTaskForDay).
 *
 * Pure presentation aside from task toggles: the vault-event debounce in the
 * view calls refreshCalendarSections, so external edits re-render the grid
 * here exactly like the sidebar widget's dots.
 */
export function renderCalendarSection(
	el: HTMLElement,
	app: App,
	settings: DashboardSettings,
	onOpenNote?: (file: TFile, line?: number) => void,
	initialView: 'month' | 'week' = 'month',
	config: Record<string, unknown> = {},
	setConfig?: (config: Record<string, unknown>) => void | Promise<void>,
): void {
	const excludeFolders = settings.calendarExcludeFolders ?? [];

	const host = el.createDiv({ cls: 'dashboard-calendar-section' });

	// Nav bar: prev / label / next, month|week toggle, today, task filter —
	// same controls in the same order as the full-screen modal's header.
	const nav = host.createDiv({ cls: 'dashboard-calendar-nav dashboard-calendar-section-nav' });
	const prev = nav.createDiv({ cls: 'dashboard-calendar-nav-btn' });
	setIcon(prev, 'chevron-left');
	const labelEl = nav.createDiv({ cls: 'dashboard-calendar-nav-label' });
	const next = nav.createDiv({ cls: 'dashboard-calendar-nav-btn' });
	setIcon(next, 'chevron-right');

	const now = new Date();
	let year = now.getFullYear();
	let month = now.getMonth();
	let view: 'month' | 'week' = initialView;
	let weekStart: Date = mondayOf(now);
	if (typeof config.calendarYear === 'number') year = config.calendarYear;
	if (typeof config.calendarMonth === 'number') month = config.calendarMonth;
	if (typeof config.calendarWeekStart === 'string') {
		const value = window.moment(config.calendarWeekStart, 'YYYY-MM-DD', true);
		if (!value.isValid()) throw new Error('日历周起始日期无效');
		weekStart = value.toDate();
	}
	/** Persisted task filter, shared with the full-screen modal. */
	let filter: CalendarTaskFilter = readCalendarTaskFilter(app);
	if (typeof config.calendarTaskFilter === 'string' && CALENDAR_TASK_FILTERS.includes(config.calendarTaskFilter as CalendarTaskFilter)) filter = config.calendarTaskFilter as CalendarTaskFilter;
	let scope = readCalendarScope({ ...settings, ...config });
	/** Latest unfiltered scan (the filter is applied per render, like the modal). */
	let byDay = new Map<string, VaultTask[]>();

	// Month | Week segmented toggle (both buttons visible, active one accented).
	const viewToggle = nav.createDiv({ cls: 'dashboard-library-view-toggle dashboard-calendar-view-toggle' });
	const viewBtns: Record<'month' | 'week', HTMLElement> = {} as Record<'month' | 'week', HTMLElement>;
	for (const v of ['month', 'week'] as const) {
		const btn = viewToggle.createDiv({
			cls: 'dashboard-library-view-btn',
			attr: { 'aria-label': v === 'month' ? t('calendar.viewMonth') : t('calendar.viewWeek') },
		});
		setIcon(btn, v === 'month' ? 'calendar' : 'calendar-range');
		btn.addEventListener('click', () => {
			if (view === v) return;
			view = v;
			if (v === 'week') weekStart = mondayOf(new Date());
			syncChrome();
			renderGrid();
			persistNavigation();
		});
		viewBtns[v] = btn;
	}

	const todayBtn = nav.createEl('button', {
		cls: 'dashboard-modal-btn dashboard-modal-btn--cancel',
		text: t('calendar.today'),
		attr: { type: 'button' },
	});
	todayBtn.addEventListener('click', () => {
		const now2 = new Date();
		year = now2.getFullYear();
		month = now2.getMonth();
		weekStart = mondayOf(now2);
		renderGrid();
		persistNavigation();
	});

	// Task filter: narrows WHICH tasks occupy the grid. Dropdown via Obsidian's
	// Menu, same as the modal (native checkmark, dismiss and mobile behavior).
	const filterBtn = nav.createEl('button', {
		cls: 'dashboard-modal-btn dashboard-modal-btn--cancel dashboard-calendar-filter-btn',
		attr: { 'aria-haspopup': 'menu', 'aria-label': t('calendar.filter'), type: 'button' },
	});
	const filterIcon = filterBtn.createSpan({ cls: 'dashboard-calendar-filter-icon' });
	setIcon(filterIcon, 'filter');
	const filterLabel = filterBtn.createSpan({ cls: 'dashboard-calendar-filter-label' });
	const caret = filterBtn.createSpan({ cls: 'dashboard-calendar-filter-caret' });
	setIcon(caret, 'chevron-down');
	filterBtn.addEventListener('click', (e) => {
		const menu = new Menu();
		for (const f of (['formal', 'all', ...(!['formal', 'all'].includes(filter) ? [filter] : [])] as CalendarTaskFilter[])) {
			menu.addItem(item => item
				.setTitle(t(`calendar.filter.${f}`))
				.setChecked(f === filter)
				.onClick(() => { void applyFilter(f); }));
		}
		filterBtn.setAttribute('aria-expanded', 'true');
		menu.onHide(() => filterBtn.setAttribute('aria-expanded', 'false'));
		menu.showAtMouseEvent(e);
	});
	calendarScopeControls(nav, app, scope, async next => {
		if (setConfig) await saveSectionConfig({ ...next });
		else await writeCalendarScopeForApp(app, next);
		scope = next; renderGrid();
	}, Boolean(setConfig));

	const body = host.createDiv({ cls: 'dashboard-calendar-section-body' });

	// Hover preview (desktop only — no hover on touch): resting the pointer on
	// a month cell pops the day's complete task list beside it. Cells cap their
	// visible rows, so this surfaces everything at a glance.
	const hoverEnabled = !Platform.isMobile;

	/** Refresh active/filtered chrome states in place (no nav rebuild). */
	function syncChrome(): void {
		for (const v of ['month', 'week'] as const) {
			viewBtns[v].toggleClass('active', view === v);
		}
		filterBtn.toggleClass('is-filtered', filter !== 'all');
		filterLabel.textContent = t(`calendar.filter.${filter}`);
	}

	async function saveSectionConfig(changes: Record<string, unknown> = {}): Promise<void> {
		const updated = { ...config, ...scope, calendarTaskFilter: filter, initialView: view,
			calendarYear: year, calendarMonth: month, calendarWeekStart: toIsoDate(weekStart), ...changes };
		await setConfig?.(updated);
		config = updated;
	}

	function persistNavigation(): void {
		if (setConfig) void saveSectionConfig().catch(error => new Notice(error instanceof Error ? error.message : '日历位置保存失败'));
	}

	async function applyFilter(next: CalendarTaskFilter): Promise<void> {
		if (next === filter) return;
		const previous = filter;
		filter = next;
		try {
			if (setConfig) await saveSectionConfig();
			else writeCalendarTaskFilter(app, filter);
		} catch (error) {
			filter = previous;
			new Notice(error instanceof Error ? error.message : '日历内容范围保存失败');
		}
		syncChrome();
		renderGrid();
	}

	const onToggle = async (task: VaultTask, nextChecked: boolean): Promise<boolean> => {
		try {
			if (!await toggleTaskInFile(app, task, nextChecked)) {
				new Notice(t('alltasks.toggleFailed'));
				return false;
			}
			invalidatePath(task.path);
		} catch {
			new Notice(t('alltasks.toggleFailed'));
			return false;
		}
		// Optimistic flip; the vault-event debounce re-scans for the truth.
		task.checked = nextChecked;
		renderGrid();
		return true;
	};

	async function rescan(): Promise<void> {
		// Always include the dashboard file itself: its checkbox lists are the
		// user's live todos AND the day-agenda's fallback write destination (same
		// rationale as the sidebar widget).
		const tasks = (await collectVaultTasks(app, excludeFolders, settings.dashboardFile)).filter(task => isCalendarRelevant(task) || task.completion || task.cancelled);
		byDay = indexTasksByDay(tasks);
	}

	function renderGrid(): void {
		// Cells are about to be replaced (nav, toggle, reload); any open hover
		// preview is anchored to a cell that's being discarded.
		closeDayPreview();
		// Filtered day view recomputed every render so the 'active' today-boundary
		// and checked-drops-out behavior stay fresh (same as the modal).
		const viewByDay = filterCalendarScope(filterTasksByDay(byDay, filter, toIsoDate(new Date())), scope);
		const gridOpts = {
			compact: false as const,
			app,
			onToggle: (task: VaultTask, next: boolean) => { void onToggle(task, next); },
			onOpenNote,
			onDayHover: hoverEnabled
				? (iso: string, anchor: HTMLElement): void => {
					const tasks = viewByDay.get(iso) ?? [];
					if (tasks.length === 0) return;
					scheduleDayPreview(anchor, iso, tasks, app);
				}
				: undefined,
			onDayLeave: hoverEnabled ? (): void => closeDayPreview() : undefined,
			onBarClick: (iso: string) => {
				new DayAgendaModal(app, iso, viewByDay.get(iso) ?? [], { onToggle, onOpenNote }, settings.dashboardFile).open();
			},
			// Day numbers (month) / day headers (week): open the day agenda with
			// the add-task input focused — tap-type-Enter adds in one flow.
			onDayNumClick: (iso: string) => {
				new DayAgendaModal(app, iso, viewByDay.get(iso) ?? [], { onToggle, onOpenNote }, settings.dashboardFile, true).open();
			},
		};
		const { label } = view === 'week'
			? renderWeekTimeGrid(body, weekStart, calendarTimeEvents(viewByDay, scope.calendarDateFact), gridOpts)
			: renderMonthGrid(body, year, month, viewByDay, gridOpts);
		labelEl.textContent = label;
	}

	/** Navigate by one month (month view) or one week (week view). */
	function shift(delta: number): void {
		if (view === 'week') {
			const d = new Date(weekStart);
			d.setDate(weekStart.getDate() + delta * 7);
			weekStart = d;
		} else {
			let m = month + delta;
			let y = year;
			while (m < 0) { m += 12; y -= 1; }
			while (m > 11) { m -= 12; y += 1; }
			month = m;
			year = y;
		}
		renderGrid();
		persistNavigation();
	}

	prev.addEventListener('click', () => shift(-1));
	next.addEventListener('click', () => shift(1));

	async function initialLoad(): Promise<void> {
		try {
			await rescan();
		} catch (err) {
			console.error('[Dashboard] calendar section scan failed:', err);
			body.createDiv({ cls: 'dashboard-library-empty', text: t('calendar.noEvents') });
			return;
		}
		syncChrome();
		renderGrid();
		// In-place reload entry point for vault task changes: re-scan and
		// re-render the grid only (navigation + filter state live in this closure).
		sectionReloaders.set(host, async (): Promise<void> => {
			try {
				await rescan();
			} catch {
				return; // keep the last good grid on a transient scan failure
			}
			renderGrid();
		});
	}

	void initialLoad();
}

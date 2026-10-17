// Minimal `obsidian` stub so test bundles can import modules that pull in
// `requestUrl` at runtime. Only what the scripts under test need; network
// paths are never exercised by these checks.
import { El } from './mini-dom';
import realMoment from 'moment';

// 任务格式与日期仍由真实 Tasks 模型和 Moment 处理；这里只隔离 Obsidian 宿主。
Object.assign(globalThis, { window: Object.assign(globalThis, { moment: realMoment }) });
export const getLanguage = (): string => 'zh';
export const getIconIds = (): string[] => ['lucide-calendar-clock', 'lucide-file-text', 'lucide-search', 'lucide-square-check-big', 'custom-brand'];
export const parseFrontMatterTags = (metadata: { tags?: string | string[] }): string[] => {
	const value = metadata?.tags;
	const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[ ,]+/) : [];
	return values.map(tag => tag.startsWith('#') ? tag : `#${tag}`);
};
export const getAllTags = (cache: { tags?: Array<{ tag: string }>; frontmatter?: { tags?: string | string[] } }): string[] =>
	[...(cache.tags ?? []).map(tag => tag.tag), ...parseFrontMatterTags(cache.frontmatter ?? {})];
export const prepareSimpleSearch = (query: string) => (text: string) => {
	const at = text.toLowerCase().indexOf(query.toLowerCase());
	return at < 0 ? null : { score: 0, matches: [[at, at + query.length]] };
};
export function debounce<T extends (...args: never[]) => unknown>(callback: T, timeout: number): T & { cancel(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const invoke = (...args: Parameters<T>) => { clearTimeout(timer); timer = setTimeout(() => callback(...args), timeout); };
	return Object.assign(invoke, { cancel: () => clearTimeout(timer) }) as T & { cancel(): void };
}

export const requestUrl = async (): Promise<{ json: unknown }> => ({ json: {} });

// Modal base for config-modal tests: wire contentEl/containerEl to mini-DOM
// nodes, with `parentElement` staying null so optional-chained parent calls
// (e.g. `containerEl.parentElement?.addClass(...)`) short-circuit like a
// top-level modal in Obsidian.
export class Modal {
	app: unknown;
	contentEl: El;
	containerEl: El;
	/** Most recently OPENED modal instance (same pattern as Menu.last) — lets
	 *  verification scripts capture modals a UI under test spawns internally. */
	static last: Modal | null = null;

	constructor(app: unknown) {
		this.app = app;
		this.contentEl = new El('div');
		this.containerEl = new El('div');
	}

	open(): void { Modal.last = this; }
	close(): void {}
}

// Runtime markers for value imports in modules under test.
export class TFolder {}
export class App {}
export class TFile {}
export class Notice {
	/** Every message ever shown, in order — lets verification scripts assert
	 *  on notice text without a real toast. */
	static messages: string[] = [];
	constructor(message: string) { Notice.messages.push(message); }
	show() {}
	hide() {}
}
// Functional Menu stub: records items (title + click) so scripts can drive
// native menus without a DOM — click an item to fire its onClick, `dismiss()`
// to fire the onHide callback (menu closed without a pick). `Menu.last`
// exposes the most recently created menu to the test.
export interface StubMenuItem {
	title: string;
	disabled?: boolean;
	click(): void;
}
export class Menu {
	static last: Menu | null = null;
	items: StubMenuItem[] = [];
	separators: number[] = [];
	private hideCb: (() => void) | null = null;

	constructor() {
		Menu.last = this;
	}

	addItem(cb: (item: unknown) => void): this {
		let clickFn: (() => void) | null = null;
		const item = {
			title: '',
			disabled: false,
			setTitle(t: string) { this.title = t; return this; },
			setIcon(_icon: string) { return this; },
			setChecked(_checked: boolean) { return this; },
			setDisabled(disabled: boolean) { this.disabled = disabled; return this; },
			setWarning(_warning: boolean) { return this; },
			onClick(fn: () => void) { clickFn = fn; return this; },
			click: () => { clickFn?.(); },
		};
		cb(item);
		this.items.push(item);
		return this;
	}

	addSeparator(): this { this.separators.push(this.items.length); return this; }

	showAtMouseEvent(_e: unknown): this { return this; }
	showAtPosition(_pos: unknown): this { return this; }
	onHide(cb: () => void): this { this.hideCb = cb; return this; }
	dismiss(): void { this.hideCb?.(); }
}
export function normalizePath(path: string): string { return path; }
export const Platform = { isMobile: false, isMobileApp: false };
export function setIcon(_el: unknown, _icon: string): void {}

// Component base for MarkdownRenderer.render's lifecycle argument (the real
// one is the ItemView). Trivial here — nothing in the scripts loads children.
export class Component {}

// MarkdownRenderer stand-in: records the exact markdown source it was handed
// as a CHILD ELEMENT (appendText's text slot would be invisible to
// textContent once the container has element children), so verify scripts can
// assert what the memo view would render and that the swap moved real nodes.
export const MarkdownRenderer = {
	render: async (_app: unknown, markdown: string, el: unknown): Promise<void> => {
		(el as unknown as { createDiv(o?: { text?: string }): void }).createDiv({ text: `[md]${markdown}` });
	},
};

// FuzzySuggestModal base for modules that import it: the verify scripts never
// open one (the studio's image browser only mounts on a browse click), so a
// bare class with the Modal surface is enough for the bundle to resolve.
export class FuzzySuggestModal<T> {
	app: unknown;
	constructor(app: unknown) { this.app = app; }
	setPlaceholder(_text: string): void {}
	open(): void {}
	close(): void {}
	// Narrow the unused-generic warning; the stand-in never items items.
	getItems(): T[] { return []; }
	getItemText(_item: T): string { return ''; }
	onChooseItem(_item: T): void {}
}

// Minimal moment() for date-only code paths (daily-notes computes note paths
// and "today" via momentOf/nowMoment + .format('YYYY-MM-DD')). Only the
// surface datetime.ts declares; calendar units are granular enough for the
// scripts that rely on them.
type StubMoment = {
	format(fmt?: string): string;
	startOf(unit: string): StubMoment;
	subtract(amount: number, unit: string): StubMoment;
	clone(): StubMoment;
	valueOf(): number;
	isValid(): boolean;
};
export function moment(input?: number | string, _format?: string, _strict?: boolean): StubMoment {
	const date = input == null
		? new Date()
		: typeof input === 'number'
			? new Date(input)
			: new Date(/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00` : input);
	const wrap = (d: Date): StubMoment => ({
		format: (fmt = 'YYYY-MM-DD') => fmt
			.replace('YYYY', String(d.getFullYear()))
			.replace('MM', String(d.getMonth() + 1).padStart(2, '0'))
			.replace('DD', String(d.getDate()).padStart(2, '0'))
			.replace('HH', String(d.getHours()).padStart(2, '0'))
			.replace('mm', String(d.getMinutes()).padStart(2, '0'))
			.replace('ss', String(d.getSeconds()).padStart(2, '0')),
		startOf: (unit) => wrap(startOfUnit(d, unit)),
		subtract: (amount, unit) => wrap(addUnit(d, -amount, unit)),
		clone: () => wrap(new Date(d.getTime())),
		valueOf: () => d.getTime(),
		isValid: () => !isNaN(d.getTime()),
	});
	return wrap(date);
}
function startOfUnit(d: Date, unit: string): Date {
	const out = new Date(d.getTime());
	if (unit.startsWith('day')) out.setHours(0, 0, 0, 0);
	else if (unit.startsWith('month')) { out.setDate(1); out.setHours(0, 0, 0, 0); }
	else if (unit.startsWith('year')) { out.setMonth(0, 1); out.setHours(0, 0, 0, 0); }
	else if (unit.startsWith('hour')) out.setMinutes(0, 0, 0);
	else if (unit.startsWith('minute')) out.setSeconds(0, 0);
	return out;
}
function addUnit(d: Date, amount: number, unit: string): Date {
	const out = new Date(d.getTime());
	if (unit.startsWith('day')) out.setDate(out.getDate() + amount);
	else if (unit.startsWith('month')) out.setMonth(out.getMonth() + amount);
	else if (unit.startsWith('year')) out.setFullYear(out.getFullYear() + amount);
	else if (unit.startsWith('hour')) out.setHours(out.getHours() + amount);
	else if (unit.startsWith('minute')) out.setMinutes(out.getMinutes() + amount);
	return out;
}

/** Minimal Setting stand-in: verify scripts never instantiate it — the export
 *  only needs to exist so bundles importing it from 'obsidian' resolve. */
export class Setting {
	constructor(_container?: unknown) {}
	setName() { return this; }
	setDesc() { return this; }
	setHeading() { return this; }
	addText() { return this; }
	addToggle() { return this; }
	addDropdown() { return this; }
	addSlider() { return this; }
	addButton() { return this; }
	addExtraButton() { return this; }
}

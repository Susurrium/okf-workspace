import { t } from './i18n';

export interface SectionRailEntry { id: string; name: string }

/** 导航属于当前 pane；每次定位重新查找 DOM，兼容分区局部替换。 */
export function mountSectionRail(host: HTMLElement, entries: readonly SectionRailEntry[]): () => void {
	if (entries.length < 2) return () => {};
	const doc = host.ownerDocument;
	const win = doc.defaultView;
	if (!win) throw new Error('工作台导航缺少所属窗口');
	const rail = host.createDiv({ cls: 'dashboard-section-rail', attr: { role: 'navigation', 'aria-label': t('rail.sections') } });
	const rowFor = (id: string): HTMLElement | undefined => Array.from(host.querySelectorAll<HTMLElement>('.dashboard-section-row'))
		.find(row => row.dataset.column === id);
	const scrollerFor = (row: HTMLElement): HTMLElement => {
		for (let element = row.parentElement; element && host.contains(element); element = element.parentElement) {
			if (/(auto|scroll)/.test(win.getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight) return element;
			if (element === host) break;
		}
		return host;
	};
	const buttons = entries.map(entry => {
		const button = rail.createDiv({ cls: 'dashboard-section-rail-item', attr: {
			role: 'button', tabindex: '0', 'data-name': entry.name, 'data-section-id': entry.id, 'aria-label': entry.name,
		} });
		button.createDiv({ cls: 'dashboard-section-rail-dash' });
		const locate = (): void => {
			const row = rowFor(entry.id);
			if (!row) return;
			const scroller = scrollerFor(row);
			const target = row.getBoundingClientRect();
			const viewport = scroller.getBoundingClientRect();
			scroller.scrollBy({ top: target.top - viewport.top - 12, behavior: win.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
		};
		button.addEventListener('click', locate);
		button.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); locate(); }
		});
		return button;
	});
	const update = (): void => {
		let best = -1;
		let overlap = 0;
		entries.forEach((entry, index) => {
			const row = rowFor(entry.id);
			if (!row) return;
			const rect = row.getBoundingClientRect();
			const view = scrollerFor(row).getBoundingClientRect();
			const visible = Math.max(0, Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top));
			if (visible > overlap) { overlap = visible; best = index; }
		});
		buttons.forEach((button, index) => {
			button.toggleClass('is-active', index === best);
			if (index === best) button.setAttribute('aria-current', 'location');
			else button.removeAttribute('aria-current');
		});
	};
	let frame: number | null = null;
	const schedule = (): void => {
		if (frame !== null) return;
		frame = win.requestAnimationFrame(() => { frame = null; update(); });
	};
	const reveal = (event: MouseEvent): void => {
		const edge = host.getBoundingClientRect().right;
		rail.toggleClass('is-revealed', event.clientX >= edge - 64 && event.clientX <= edge + 2);
	};
	const conceal = (): void => { if (!rail.contains(doc.activeElement)) rail.removeClass('is-revealed'); };
	const focus = (): void => rail.addClass('is-revealed');
	host.addEventListener('scroll', schedule, { capture: true, passive: true });
	host.addEventListener('mousemove', reveal, { passive: true });
	host.addEventListener('mouseleave', conceal);
	rail.addEventListener('focusin', focus);
	rail.addEventListener('focusout', conceal);
	win.addEventListener('resize', schedule);
	update();
	return () => {
		if (frame !== null) win.cancelAnimationFrame(frame);
		host.removeEventListener('scroll', schedule, { capture: true });
		host.removeEventListener('mousemove', reveal);
		host.removeEventListener('mouseleave', conceal);
		win.removeEventListener('resize', schedule);
		rail.remove();
	};
}

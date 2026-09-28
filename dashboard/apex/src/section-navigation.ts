import { sectionRef, type DashboardData } from './types';

/** Locate a section owned by Apex, preserving its configured title and type. */
export function revealSectionType(
	data: DashboardData | null,
	container: HTMLElement,
	collapsedSections: Set<string>,
	sectionType: string,
): boolean {
	const column = data?.columns.find((item) => item.sectionType === sectionType);
	if (!column) return false;
	const rows = container.querySelectorAll<HTMLElement>('.dashboard-section-row');
	const row = Array.from(rows).find((item) => item.dataset.column === sectionRef(column));
	if (!row) return false;
	if (row.hasClass('dashboard-section-row--collapsed')) {
		row.removeClass('dashboard-section-row--collapsed');
		collapsedSections.delete(sectionRef(column));
		collapsedSections.delete(column.name);
	}
	row.scrollIntoView({ behavior: 'smooth', block: 'start' });
	const title = row.querySelector<HTMLElement>('.dashboard-section-title');
	if (title) {
		title.tabIndex = -1;
		title.focus({ preventScroll: true });
	}
	return true;
}

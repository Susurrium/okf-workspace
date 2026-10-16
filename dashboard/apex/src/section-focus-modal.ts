import { Modal, type App } from 'obsidian';
import { applyModalTheme } from './modal-theme';
import { destroyMediaSection } from './media-section';
import { captureRootScrollState, restoreRootScrollState } from './scroll-preserve';
import { captureSectionSearch, restoreSectionSearch, type SectionSearchState } from './section-browse-state';

export class SectionFocusModal extends Modal {
	private unsubscribe?: () => void;
	private restoreSearch?: () => void;
	constructor(app: App, private readonly renderSection: () => HTMLElement, private readonly subscribe: (update: () => void) => () => void,
		private readonly eventTarget: () => HTMLElement | null, private search: SectionSearchState[] = [], private readonly disposed?: () => void) { super(app); }
	onOpen(): void {
		this.modalEl.addClass('modal--dashboard', 'dashboard-section-focus-modal');
		this.containerEl.querySelector('.modal-bg')?.addClass('modal-bg--dashboard');
		applyModalTheme(this.modalEl);
		this.contentEl.addClass('apex-dashboard-root', 'dashboard-section-focus');
		for (const type of ['dashboard-library-config', 'dashboard-library-new-note', 'dashboard-ticktick-view', 'dashboard-ticktick-filter', 'dashboard-ticktick-resize']) {
			this.contentEl.addEventListener(type, event => {
				this.eventTarget()?.dispatchEvent(new CustomEvent(type, { detail: (event as CustomEvent<unknown>).detail, bubbles: true }));
			});
		}
		this.refresh();
		this.unsubscribe = this.subscribe(() => this.refresh());
	}
	private refresh(): void {
		const scroll = captureRootScrollState(this.contentEl);
		if (this.contentEl.querySelector('.dashboard-section-row')) this.search = captureSectionSearch(this.contentEl);
		this.restoreSearch?.();
		destroyMediaSection(this.contentEl);
		this.contentEl.empty();
		this.contentEl.appendChild(this.renderSection());
		this.restoreSearch = restoreSectionSearch(this.contentEl, this.search);
		restoreRootScrollState(this.contentEl, scroll);
	}
	onClose(): void { this.unsubscribe?.(); this.unsubscribe = undefined; this.restoreSearch?.(); destroyMediaSection(this.contentEl); this.contentEl.empty(); this.disposed?.(); }
}

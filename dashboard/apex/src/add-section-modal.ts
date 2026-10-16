import { Modal, setIcon } from 'obsidian';
import { t } from './i18n';
import { applyModalTheme } from './modal-theme';
import { registeredSectionDefinitions } from './section-registry';
import { SECTION_TYPE_OPTIONS, SECTION_GROUPS, groupedSectionOptions, sectionGroupLabel, sectionOptionLabel, type SectionTypeOption } from './section-catalog';

export { SECTION_TYPE_OPTIONS, type SectionTypeOption } from './section-catalog';

export class AddSectionModal extends Modal {
	private selectedType: string;
	private nameInput: HTMLInputElement | null = null;
	private selectedLabel: HTMLElement | null = null;
	private query = '';
	private group = '';
	private customName = false;
	private saving = false;
	private errorEl: HTMLElement | null = null;

	constructor(app: import('obsidian').App, private readonly onAdd: (name: string, sectionType: string) => void | Promise<void>, initialType = 'workspace-today') {
		super(app);
		this.selectedType = initialType;
	}

	onOpen(): void {
		const { contentEl, containerEl } = this;
		contentEl.empty();
		contentEl.addClass('dashboard-library-config-modal');
		this.modalEl.addClass('modal--dashboard', 'dashboard-section-picker-modal');
		containerEl.querySelector('.modal-bg')?.addClass('modal-bg--dashboard');
		applyModalTheme(this.modalEl);
		const options = this.options();
		if (!options.some(option => option.value === this.selectedType)) this.selectedType = options[0]!.value;
		const container = contentEl.createDiv({ cls: 'dashboard-modal dashboard-section-picker' });
		const header = container.createDiv({ cls: 'dashboard-modal-header' });
		header.createDiv({ cls: 'dashboard-modal-title', text: t('section.addTitle') });
		const search = header.createEl('input', { cls: 'dashboard-section-picker-search', attr: { type: 'search', placeholder: t('section.search'), 'aria-label': t('section.search') } });
		const categories = container.createDiv({ cls: 'dashboard-section-picker-categories', attr: { 'aria-label': t('section.categories') } });
		const grid = container.createDiv({ cls: 'dashboard-section-picker-options' });
		const renderCategories = (): void => {
			categories.empty();
			for (const id of ['', ...SECTION_GROUPS.map(group => group.id)]) {
				const button = categories.createEl('button', { text: id ? sectionGroupLabel(id) : t('section.allTypes'),
					cls: this.group === id ? 'is-active' : '', attr: { type: 'button', 'aria-pressed': String(this.group === id) } });
				button.addEventListener('click', () => { this.group = id; renderCategories(); this.renderTypeGrid(grid); });
			}
		};
		search.addEventListener('input', () => { this.query = search.value; this.renderTypeGrid(grid); });
		renderCategories();
		this.renderTypeGrid(grid);
		const footer = container.createDiv({ cls: 'dashboard-section-picker-footer' });
		this.selectedLabel = footer.createDiv({ cls: 'dashboard-section-picker-selection' });
		this.errorEl = footer.createDiv({ cls: 'dashboard-section-picker-error', attr: { role: 'alert' } });
		const nameRow = footer.createEl('label', { cls: 'dashboard-add-section-name-row' });
		nameRow.createSpan({ text: t('section.nameLabel') });
		this.nameInput = nameRow.createEl('input', { cls: 'dashboard-task-input dashboard-section-name-input', attr: { type: 'text', 'aria-label': t('section.nameLabel') } });
		this.nameInput.addEventListener('input', () => { this.customName = Boolean(this.nameInput?.value.trim()); });
		this.nameInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void this.tryConfirm(); } });
		const actions = footer.createDiv({ cls: 'dashboard-modal-footer' });
		actions.createEl('button', { cls: 'dashboard-modal-btn dashboard-modal-btn--cancel', text: t('common.cancel'), attr: { type: 'button' } }).addEventListener('click', () => this.close());
		actions.createEl('button', { cls: 'dashboard-modal-btn dashboard-modal-btn--confirm', text: t('section.confirmAdd'), attr: { type: 'button' } }).addEventListener('click', () => { void this.tryConfirm(); });
		this.updateSelection();
		window.setTimeout(() => search.focus(), 0);
	}

	private renderTypeGrid(grid: HTMLElement): void {
		grid.empty();
		const groups = groupedSectionOptions(this.options(), this.query, this.group);
		if (!groups.length) grid.createDiv({ cls: 'dashboard-section-picker-empty', text: t('section.noMatch') });
		for (const group of groups) {
			const host = grid.createDiv({ cls: 'dashboard-section-type-group' });
			host.createEl('h4', { text: sectionGroupLabel(group.id) });
			const items = host.createDiv({ cls: 'dashboard-add-section-grid', attr: { role: 'group', 'aria-label': sectionGroupLabel(group.id) } });
			for (const option of group.options) {
				const card = items.createEl('button', { cls: 'dashboard-add-section-card' + (option.value === this.selectedType ? ' active' : ''),
					attr: { type: 'button', 'data-type': option.value, 'aria-pressed': String(option.value === this.selectedType), 'aria-label': sectionOptionLabel(option) } });
				setIcon(card.createDiv({ cls: 'dashboard-add-section-card-icon' }), option.icon);
				card.createDiv({ cls: 'dashboard-add-section-card-name', text: sectionOptionLabel(option) });
				card.addEventListener('click', () => {
					this.selectedType = option.value;
					for (const button of Array.from(grid.querySelectorAll<HTMLButtonElement>('.dashboard-add-section-card'))) {
						const selected = button.dataset.type === this.selectedType;
						button.toggleClass('active', selected);
						button.setAttribute('aria-pressed', String(selected));
					}
					this.updateSelection();
				});
				card.addEventListener('keydown', event => {
					const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>('.dashboard-add-section-card'));
					const index = buttons.indexOf(card);
					const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
					if (next !== undefined) { event.preventDefault(); buttons[(next + buttons.length) % buttons.length]?.focus(); }
				});
			}
		}
	}

	private updateSelection(): void {
		const option = this.options().find(option => option.value === this.selectedType)!;
		const name = option.defaultName ?? sectionOptionLabel(option);
		this.selectedLabel?.setText(`${t('section.selectedType')}：${sectionOptionLabel(option)}`);
		if (this.nameInput && !this.customName) this.nameInput.value = name;
	}

	private options(): SectionTypeOption[] {
		return [...SECTION_TYPE_OPTIONS, ...registeredSectionDefinitions().filter(definition => !definition.hidden).map(definition => ({
			value: definition.type, icon: definition.icon, label: definition.label, defaultName: definition.defaultName, group: definition.group,
		}))];
	}

	private async tryConfirm(): Promise<void> {
		if (this.saving) return;
		const option = this.options().find(option => option.value === this.selectedType);
		if (!option) return;
		this.saving = true;
		this.errorEl?.setText('');
		const controls = Array.from(this.contentEl.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'));
		controls.forEach(control => { control.disabled = true; });
		try {
			await this.onAdd(this.nameInput?.value.trim() || option.defaultName || sectionOptionLabel(option), this.selectedType);
			this.close();
		} catch (error) { this.errorEl?.setText(error instanceof Error ? error.message : String(error)); }
		finally { this.saving = false; controls.forEach(control => { control.disabled = false; }); }
	}

	onClose(): void { this.contentEl.empty(); }
}

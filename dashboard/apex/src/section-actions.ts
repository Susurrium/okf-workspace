import { Menu, Notice, setIcon } from 'obsidian';
import { t } from './i18n';

export type SectionActionPlacement = 'header' | 'content' | 'menu';
export interface SectionAction {
	id: string;
	label: string;
	icon: string;
	run(): void | Promise<void>;
	placement?: SectionActionPlacement;
}

/** 分区只声明操作，公共外壳负责排列、菜单和执行反馈。 */
export class SectionActions {
	readonly element: HTMLElement;
	private readonly content: HTMLElement;
	private readonly menuButton: HTMLButtonElement;
	private readonly menuItems: HTMLButtonElement[] = [];
	private readonly actions = new Map<string, HTMLButtonElement>();

	constructor(header: HTMLElement, section: HTMLElement) {
		this.element = header.createDiv({ cls: 'dashboard-section-header-actions' });
		this.content = section.createDiv({ cls: 'dashboard-section-toolbar' });
		this.menuButton = this.element.createEl('button', { cls: 'dashboard-section-action', attr: {
			type: 'button', 'aria-label': t('section.more'), title: t('section.more'), 'aria-haspopup': 'menu',
		} });
		setIcon(this.menuButton, 'ellipsis');
		this.menuButton.addEventListener('click', event => {
			event.stopPropagation();
			const menu = new Menu();
			for (const button of this.menuItems) menu.addItem(item => item
				.setTitle(button.getAttribute('aria-label') ?? button.title)
				.setDisabled(button.disabled)
				.onClick(() => button.click()));
			this.menuButton.setAttribute('aria-expanded', 'true');
			menu.onHide(() => this.menuButton.setAttribute('aria-expanded', 'false'));
			const anchor = this.menuButton.getBoundingClientRect();
			menu.showAtPosition({ x: anchor.left, y: anchor.bottom + 4 });
		});
	}

	createButton(placement: SectionActionPlacement, options: { cls?: string; attr?: Record<string, string>; text?: string }): HTMLButtonElement {
		const button = (placement === 'content' ? this.content : this.element).createEl('button', {
			...options, cls: `${options.cls ?? ''} dashboard-section-action`, attr: { type: 'button', ...options.attr },
		});
		button.title = options.attr?.['aria-label'] ?? options.text ?? '';
		if (placement === 'menu') {
			button.remove();
			if ([t('section.settings'), t('section.pageSettings')].includes(options.attr?.['aria-label'] ?? '')) this.menuItems.unshift(button);
			else this.menuItems.push(button);
		}
		else if (placement === 'header') this.element.insertBefore(button, this.menuButton);
		return button;
	}

	set(action: SectionAction): void {
		let button = this.actions.get(action.id);
		if (!button) {
			button = this.createButton(action.placement ?? 'header', { attr: { 'data-action': action.id, 'aria-label': action.label } });
			this.actions.set(action.id, button);
		}
		button.setAttribute('aria-label', action.label);
		button.title = action.label;
		setIcon(button, action.icon);
		button.onclick = async event => {
			event.stopPropagation();
			button.disabled = true;
			button.setAttribute('aria-busy', 'true');
			try { await action.run(); }
			catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); }
			finally { button.disabled = false; button.removeAttribute('aria-busy'); }
		};
	}
}

export function sectionOpenKind(type: string): 'tab' | 'enlarge' {
	return ['calendar', 'library', 'folder', 'images', 'videos', 'dataview'].includes(type) ? 'tab' : 'enlarge';
}

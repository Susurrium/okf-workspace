import { t } from './i18n';
import { applyModalTheme } from './modal-theme';

export interface ChoiceDialogOption {
	id: string;
	label: string;
	description?: string;
}

/** Small keyboard-accessible chooser used before creating a hosted workspace. */
export function showChoiceDialog(
	options: readonly ChoiceDialogOption[],
	title: string,
): Promise<string | null> {
	return new Promise((resolve) => {
		let resolved = false;
		const overlay = activeDocument.body.createDiv({ cls: 'dashboard-confirm-overlay' });
		const dialog = overlay.createDiv({ cls: 'dashboard-confirm-card dashboard-choice-card' });
		applyModalTheme(dialog);
		dialog.createEl('h3', { text: title, cls: 'dashboard-confirm-title' });
		const list = dialog.createDiv({ cls: 'dashboard-choice-list' });

		function finish(value: string | null): void {
			if (resolved) return;
			resolved = true;
			overlay.remove();
			activeDocument.removeEventListener('keydown', onKeydown);
			resolve(value);
		}
		function onKeydown(event: KeyboardEvent): void {
			if (event.key === 'Escape') finish(null);
		}

		for (const [index, option] of options.entries()) {
			const button = list.createEl('button', {
				cls: 'dashboard-choice-option',
				attr: { type: 'button' },
			});
			button.createEl('strong', { text: option.label });
			if (option.description) button.createSpan({ text: option.description });
			button.addEventListener('click', () => finish(option.id));
			if (index === 0) window.setTimeout(() => button.focus(), 0);
		}

		const actions = dialog.createDiv({ cls: 'dashboard-confirm-actions' });
		actions.createEl('button', {
			text: t('common.cancel'),
			cls: 'dashboard-confirm-cancel',
		}).addEventListener('click', () => finish(null));
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) finish(null);
		});
		activeDocument.addEventListener('keydown', onKeydown);
	});
}

import { t } from './i18n';
import { applyModalTheme } from './modal-theme';

/**
 * Reminder-time choice for the pomodoro stopwatch (Rae): at each reminder
 * cadence the user picks whether to keep counting or end the run. Every
 * passive dismissal — Escape, overlay click, Enter (the focused default) —
 * CONTINUES the stopwatch, per "no answer keeps counting"; the run only ends
 * on the explicit end button.
 *
 * Resolves true ONLY for that explicit "end and record" click.
 */
export function showStopwatchReminderDialog(minutes: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	const doc = activeDocument;
	return new Promise((resolve) => {
		let resolved = false;
		const done = (end: boolean): void => {
			if (resolved) return;
			resolved = true;
			doc.removeEventListener('keydown', onKeydown);
			signal?.removeEventListener('abort', cancel);
			overlay.remove();
			resolve(end);
		};

		const cancel = (): void => done(false);
		const overlay = doc.body.createDiv({ cls: 'dashboard-confirm-overlay' });
		const dialog = overlay.createDiv({
			cls: 'dashboard-confirm-card',
			attr: { role: 'dialog', 'aria-modal': 'true' },
		});
		applyModalTheme(dialog);

		dialog.createEl('h3', { text: t('pomodoro.reminderTitle'), cls: 'dashboard-confirm-title' });
		dialog.createEl('p', {
			text: t('pomodoro.reminderMessage', { minutes: String(minutes) }),
			cls: 'dashboard-confirm-message',
		});

		const actions = dialog.createDiv({ cls: 'dashboard-confirm-actions' });
		const continueBtn = actions.createEl('button', {
			text: t('pomodoro.reminderContinue'),
			cls: 'dashboard-confirm-primary',
		});
		continueBtn.addEventListener('click', () => done(false));
		const endBtn = actions.createEl('button', {
			text: t('pomodoro.reminderEnd'),
			cls: 'dashboard-confirm-delete',
		});
		endBtn.addEventListener('click', () => done(true));

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) done(false);
		});

		// Escape continues (passive = keep counting); Enter runs the focused
		// default. The press-outside guard mirrors showConfirmDialog: without
		// the preventDefault, the page button that armed us re-fires on Enter.
		const onKeydown = (e: KeyboardEvent): void => {
			if (e.isComposing) return;
			if (e.key === 'Escape') {
				e.preventDefault();
				done(false);
				return;
			}
			if (e.key === 'Enter' && !dialog.contains(e.target as Node | null)) {
				e.preventDefault();
				done(false);
			}
		};
		doc.addEventListener('keydown', onKeydown);
		signal?.addEventListener('abort', cancel, { once: true });
		continueBtn.focus();
	});
}

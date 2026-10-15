export interface NoteRowOptions {
  title: string;
  metadata?: string;
  badge?: string;
  actionLabel?: string;
  onOpen: () => void;
  openWholeRow?: boolean;
  className?: string;
  classes?: Partial<Record<'main' | 'title' | 'metadata' | 'badge' | 'action', string>>;
}

export function renderNoteRow(parent: HTMLElement, options: NoteRowOptions): HTMLElement {
  const row = parent.createDiv({ cls: options.className ?? 'dashboard-note-row' });
  const main = row.createDiv({ cls: options.classes?.main ?? 'dashboard-note-row-main' });
  const title = main.createEl('button', { text: options.title,
    cls: options.classes?.title ?? 'dashboard-note-row-title', attr: { type: 'button' } });
  title.addEventListener('click', options.onOpen);
  if (options.openWholeRow) {
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.addEventListener('click', event => {
      if (!(event.target as HTMLElement).closest('button, a, input, select')) options.onOpen();
    });
    row.addEventListener('keydown', event => {
      if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); options.onOpen(); }
    });
  }
  if (options.metadata) main.createDiv({ cls: options.classes?.metadata ?? 'dashboard-note-row-meta', text: options.metadata });
  if (options.badge) row.createSpan({ cls: options.classes?.badge ?? 'dashboard-note-row-badge', text: options.badge });
  if (options.actionLabel) {
    row.createEl('button', { text: options.actionLabel, cls: options.classes?.action ?? 'dashboard-note-row-action', attr: { type: 'button' } })
      .addEventListener('click', options.onOpen);
  }
  return row;
}

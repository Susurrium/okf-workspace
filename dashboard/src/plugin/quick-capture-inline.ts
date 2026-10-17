import { Notice, Platform, setIcon } from 'obsidian';
import type { CaptureSession } from './capture-session.js';

export function mountQuickCapture(container: HTMLElement, session: CaptureSession, expand: () => Promise<void>, options?: { compact?: boolean }): () => void {
  const widget = container.createDiv({ cls: 'dashboard-sidebar-widget okf-capture-inline' });
  if (options?.compact) widget.addClass('okf-capture-inline--compact');
  widget.createDiv({ text: '快速记录', cls: 'okf-capture-heading' });
  const input = widget.createEl('textarea', { attr: { rows: '1', placeholder: '记下一个想法…', 'aria-label': '快速记录内容' } });
  const actions = widget.createDiv({ cls: 'okf-capture-actions' });
  const open = actions.createEl('button', { text: '展开', attr: { type: 'button', 'aria-label': '展开快速记录' } });
  const submit = actions.createEl('button', { text: '保存', attr: { type: 'button', 'aria-label': '保存到收集箱' } });
  if (options?.compact) { open.setText(''); submit.setText(''); setIcon(open, 'maximize-2'); setIcon(submit, 'corner-down-left'); open.title = '展开快速记录'; submit.title = '保存到收集箱'; input.title = 'Enter 保存 · Shift+Enter 换行'; }
  const hint = widget.createDiv({ cls: 'okf-capture-hint', text: Platform.isMobile ? '保存到收集箱' : 'Enter 保存 · Shift+Enter 换行' });
  const feedback = widget.createDiv({ cls: 'okf-capture-feedback', attr: { role: 'status', 'aria-live': 'polite' } });
  const report = (error: unknown): void => { new Notice(error instanceof Error ? error.message : String(error), 10000); };
  const resize = (): void => {
    input.style.height = 'auto';
    // scrollHeight 不含边框，额外留一个像素处理缩放时的取整。
    const border = input.offsetHeight - input.clientHeight;
    input.style.height = `${Math.min(160, Math.max(36, input.scrollHeight + border + 1))}px`;
  };
  input.addEventListener('input', () => {
    try { session.setText(input.value); resize(); } catch (error) { report(error); input.value = session.snapshot().text; }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !Platform.isMobile) {
      event.preventDefault(); void session.submit().catch(report);
    }
  });
  submit.addEventListener('click', () => { void session.submit().catch(report); });
  open.addEventListener('click', () => { void expand().catch(report); });
  const unsubscribe = session.subscribe(state => {
    if (input.value !== state.text) { input.value = state.text; resize(); }
    input.disabled = state.busy; input.readOnly = state.locked;
    open.disabled = state.busy; submit.disabled = state.busy;
    submit.setAttribute('aria-busy', String(state.busy));
    feedback.setText(state.error);
    hint.setText(state.relation.course || state.relation.project ? '已有课程／项目关联，展开可调整' : Platform.isMobile ? '保存到收集箱' : 'Enter 保存 · Shift+Enter 换行');
  });
  return unsubscribe;
}

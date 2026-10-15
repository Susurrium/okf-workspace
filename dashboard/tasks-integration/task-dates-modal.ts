import { Modal, type App } from 'obsidian';
import { mount, unmount } from 'svelte';
import TaskDates from './TaskDates.svelte';
import { applyModalTheme } from '../apex/src/modal-theme';

export class TaskDatesModal extends Modal {
  private component: ReturnType<typeof mount> | undefined;
  constructor(app: App, private readonly label: string, private readonly values: Record<string, string>,
    private readonly submit: (values: Record<string, string>) => Promise<void>) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('okf-task-editor-modal');
    applyModalTheme(this.modalEl);
    this.titleEl.setText(`安排日期 · ${this.label}`);
    this.component = mount(TaskDates, { target: this.contentEl, props: { values: this.values,
      submit: async (values: Record<string, string>) => { await this.submit(values); this.close(); }, cancel: () => this.close() } });
  }
  onClose(): void { if (this.component) { void unmount(this.component); this.component = undefined; } }
}

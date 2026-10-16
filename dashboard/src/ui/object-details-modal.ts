import { Modal, type App, type EventRef } from "obsidian";
import { applyModalTheme } from "../../apex/src/modal-theme.js";

export class ObjectDetailsModal extends Modal {
  private timer: number | undefined;
  private opened = false;
  private updateEvent: EventRef | undefined;
  private poll: number | undefined;
  private previousFocus: HTMLElement | undefined;
  public constructor(app: App, private readonly title: string,
    private readonly render: (container: HTMLElement, close: () => void) => void | Promise<void>,
    private readonly cleanup?: () => void, private readonly pollMs?: number) { super(app); }

  public async onOpen(): Promise<void> {
    this.modalEl.addClass("okf-detail-modal", "okf-workflow-modal");
    if (this.modalEl.ownerDocument) applyModalTheme(this.modalEl);
    const active = this.modalEl.ownerDocument?.activeElement;
    if (active && "focus" in active) this.previousFocus = active as HTMLElement;
    this.opened = true;
    this.titleEl.setText(this.title);
    await this.refresh();
    if (this.opened && this.app.vault?.on) this.updateEvent = this.app.vault.on("modify", () => this.scheduleRefresh());
    if (this.opened && this.pollMs) this.poll = window.setInterval(() => this.scheduleRefresh(), this.pollMs);
  }

  private scheduleRefresh(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      if (!this.opened) return;
      const active = this.contentEl.ownerDocument?.activeElement;
      if (active && this.contentEl.contains(active) && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) { this.scheduleRefresh(); return; }
      if (this.contentEl.querySelector('button:disabled') || (this.contentEl.ownerDocument?.querySelectorAll('.modal').length ?? 0) > 1) { this.scheduleRefresh(); return; }
      this.cleanup?.();
      void this.refresh();
    }, 400);
  }

  private async refresh(): Promise<void> {
    const scroll = this.contentEl.scrollTop;
    this.contentEl.empty();
    const loading = this.contentEl.createDiv({ text: "正在读取…", cls: "okf-dashboard__muted" });
    try { await this.render(this.contentEl, () => this.close()); }
    catch (error) {
      this.contentEl.createDiv({ cls: "okf-dashboard__error", text: error instanceof Error ? error.message : "无法读取详情" });
    } finally { loading.remove(); this.contentEl.scrollTop = scroll; if (!this.opened) this.cleanup?.(); }
  }

  public onClose(): void {
    this.opened = false;
    window.clearTimeout(this.timer);
    window.clearInterval(this.poll);
    if (this.updateEvent) this.app.vault.offref(this.updateEvent);
    this.updateEvent = undefined;
    this.cleanup?.();
    this.contentEl.empty();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    this.previousFocus = undefined;
  }
}

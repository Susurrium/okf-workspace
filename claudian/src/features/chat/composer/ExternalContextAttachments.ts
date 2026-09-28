import type { ComposerContextTray } from '../ui/ComposerContextTray';

/** Draft-only file path attachments supplied by an external host such as Dashboard. */
export class ExternalContextAttachments {
  private paths: string[] = [];

  constructor(private readonly tray: ComposerContextTray) {}

  getPaths(): readonly string[] {
    return [...this.paths];
  }

  setPaths(paths: readonly string[]): void {
    this.paths = [...new Set(paths)];
    this.#render();
  }

  removePaths(paths: readonly string[]): void {
    const removed = new Set(paths);
    this.paths = this.paths.filter(path => !removed.has(path));
    this.#render();
  }

  destroy(): void {
    this.paths = [];
    this.tray.clearItems('external-context');
  }

  #render(): void {
    this.tray.setItems('external-context', this.paths.map(path => ({
      id: path,
      kind: 'content',
      label: path.split('/').at(-1) || path,
      icon: 'paperclip',
      ariaLabel: path,
      onRemove: () => this.removePaths([path]),
    })));
  }
}

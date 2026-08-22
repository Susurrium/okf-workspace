import type { ComposerContextTray } from '../../ComposerContextTray';

export interface FileChipsViewCallbacks {
  describeFile: (path: string, fallbackLabel: string) => string;
  onRemoveAttachment: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export class FileChipsView {
  private contextTray: ComposerContextTray;
  private callbacks: FileChipsViewCallbacks;

  constructor(contextTray: ComposerContextTray, callbacks: FileChipsViewCallbacks) {
    this.contextTray = contextTray;
    this.callbacks = callbacks;
  }

  destroy(): void {
    this.contextTray.clearItems('current-note');
    this.contextTray.clearItems('referenced-files');
  }

  renderCurrentNote(filePath: string | null): void {
    if (!filePath) {
      this.contextTray.clearItems('current-note');
      return;
    }

    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || filePath;
    const label = this.callbacks.describeFile(normalizedPath, filename);
    this.contextTray.setItems('current-note', [{
      id: filePath,
      kind: 'note',
      label,
      icon: 'file-text',
      title: filePath,
      ariaLabel: `Linked note: ${filePath}`,
      onActivate: () => this.callbacks.onOpenFile(filePath),
      onRemove: () => this.callbacks.onRemoveAttachment(filePath),
    }]);
  }

  renderReferencedFiles(filePaths: readonly string[], currentNotePath: string | null): void {
    const referencedPaths = filePaths.filter(filePath => filePath !== currentNotePath);
    const described = referencedPaths.map((filePath) => {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const fallbackLabel = shortestUniqueSuffix(normalizedPath, referencedPaths);
      return {
        filePath,
        normalizedPath,
        label: this.callbacks.describeFile(normalizedPath, fallbackLabel),
      };
    });
    const labelCounts = new Map<string, number>();
    for (const item of described) {
      const key = item.label.toLocaleLowerCase();
      labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
    }

    const items = described
      .map(({ filePath, normalizedPath, label: candidateLabel }) => {
        const duplicateLabel = (labelCounts.get(candidateLabel.toLocaleLowerCase()) ?? 0) > 1;
        const label = duplicateLabel
          ? `${candidateLabel} · ${shortestUniqueSuffix(normalizedPath, referencedPaths)}`
          : candidateLabel;
        return {
          id: filePath,
          kind: 'note' as const,
          label,
          icon: 'paperclip',
          title: filePath,
          ariaLabel: `Referenced file: ${filePath}`,
          onActivate: () => this.callbacks.onOpenFile(filePath),
          onRemove: () => this.callbacks.onRemoveAttachment(filePath),
        };
      });
    this.contextTray.setItems('referenced-files', items);
  }
}

function shortestUniqueSuffix(filePath: string, allPaths: readonly string[]): string {
  const segments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const filename = segments.at(-1) || filePath;
  const matching = allPaths
    .map(path => path.replace(/\\/g, '/').split('/').filter(Boolean))
    .filter(parts => parts.at(-1)?.toLocaleLowerCase() === filename.toLocaleLowerCase());
  if (matching.length <= 1) return filename;

  for (let depth = 2; depth <= segments.length; depth++) {
    const suffix = segments.slice(-depth).join('/').toLocaleLowerCase();
    const matches = matching.filter(parts => (
      parts.slice(-depth).join('/').toLocaleLowerCase() === suffix
    ));
    if (matches.length === 1) return segments.slice(-depth).join(' / ');
  }
  return segments.join(' / ');
}

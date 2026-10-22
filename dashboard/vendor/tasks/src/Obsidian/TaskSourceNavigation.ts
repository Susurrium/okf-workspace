import type { App, PaneType, TFile } from 'obsidian';

export type TaskSourceOpener = (file: TFile, line: number) => Promise<void>;
export type PrepareTaskSourceNavigation = (newLeaf?: PaneType | boolean) => TaskSourceOpener;

export function prepareTaskSourceNavigation(app: App, newLeaf: PaneType | boolean = false): TaskSourceOpener {
    return (file, line) => app.workspace.getLeaf(newLeaf).openFile(file, { eState: { line } });
}

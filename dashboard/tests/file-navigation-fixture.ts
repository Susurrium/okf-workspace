import type { App, TFile as ObsidianFile, WorkspaceLeaf } from 'obsidian';
import { vi, type Mock } from 'vitest';
import { TFile } from './obsidian-runtime.js';

interface NavigationLeaf {
  parent: object;
  activeTime: number;
  isDeferred: boolean;
  pinned: boolean;
  getViewState(): { type: string; state: { file?: string } };
  getRoot(): object;
  openFile: Mock<(file: ObsidianFile, options?: unknown) => Promise<void>>;
  loadIfDeferred: Mock<() => Promise<void>>;
  setEphemeralState: Mock;
  detach: Mock<() => void>;
}

export function navigationFixture() {
  const files = new Map<string, ObsidianFile>();
  const leaves: NavigationLeaf[] = [];
  const group = {};
  function makeLeaf(path?: string, parent = group): NavigationLeaf {
    const state = { type: path ? 'markdown' : 'apex-dashboard-view', state: { file: path } };
    const leaf: NavigationLeaf = { parent, activeTime: 0, isDeferred: false, pinned: false,
      getViewState: () => state,
      getRoot: () => parent,
      openFile: vi.fn(async (file: ObsidianFile, _options?: unknown) => { state.state.file = file.path; state.type = 'markdown'; }),
      loadIfDeferred: vi.fn(async () => { leaf.isDeferred = false; }),
      setEphemeralState: vi.fn(),
      detach: vi.fn(() => { const at = leaves.indexOf(leaf); if (at >= 0) leaves.splice(at, 1); }),
    };
    leaves.push(leaf);
    return leaf;
  }
  const source = makeLeaf();
  const workspace = {
    leftSplit: {}, rightSplit: {},
    focusNewTab: true,
    activeLeaf: source as ReturnType<typeof makeLeaf> | null,
    iterateRootLeaves: (visit: (leaf: unknown) => void) => [...leaves].forEach(visit),
    iterateAllLeaves: (visit: (leaf: unknown) => void) => [...leaves].forEach(visit),
    getMostRecentLeaf: () => workspace.activeLeaf,
    createLeafInParent: vi.fn((parent: object, _index: number) => {
      const leaf = makeLeaf(undefined, parent);
      workspace.activeLeaf = leaf;
      return leaf;
    }),
    getLeaf: vi.fn((mode?: unknown) => {
      const leaf = makeLeaf();
      if (workspace.focusNewTab || mode === 'split' || mode === 'window') workspace.activeLeaf = leaf;
      return leaf;
    }),
    revealLeaf: vi.fn(async (_leaf: unknown) => {}),
    setActiveLeaf: vi.fn((leaf: unknown) => { workspace.activeLeaf = leaf as typeof source; }),
  };
  const app = { workspace, vault: {
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    getFiles: () => [...files.values()],
  } } as unknown as App;
  const addFile = (path: string): ObsidianFile => { const file = new TFile(path) as unknown as ObsidianFile; files.set(path, file); return file; };
  return { app, workspace, files, leaves, source, makeLeaf, addFile,
    asLeaf: (leaf: ReturnType<typeof makeLeaf>) => leaf as unknown as WorkspaceLeaf };
}

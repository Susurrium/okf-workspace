import { describe, expect, it } from 'vitest';
import { beginFileNavigation, openFileInWorkspace } from '../apex/src/file-navigation.js';
import { openPinnedNote } from '../apex/src/quick-note-section.js';
import { navigationFixture } from './file-navigation-fixture.js';

describe('existing file navigation', () => {
  it('returns from the workbench twenty times without duplicating the file tab', async () => {
    const f = navigationFixture();
    const file = f.addFile('feeds/treehole/2026/一期.md');
    for (let i = 0; i < 20; i++) {
      f.workspace.activeLeaf = f.source;
      await openFileInWorkspace(f.app, file, { subpath: `#^item-${i}` });
    }
    expect(f.leaves).toHaveLength(2);
    expect(f.leaves[1]!.openFile).toHaveBeenCalledTimes(1);
    expect(f.leaves[1]!.setEphemeralState).toHaveBeenLastCalledWith({ subpath: '#^item-19', focus: true });
    expect(f.source.openFile).not.toHaveBeenCalled();
  });

  it('uses the real pinned-note entry and preserves an existing pinned tab and its position', async () => {
    const f = navigationFixture();
    const file = f.addFile('notes/固定.md');
    const target = f.makeLeaf(file.path);
    target.pinned = true;
    openPinnedNote(f.app, { id: 'pinned', icon: 'file', path: file.path, label: '固定' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.workspace.activeLeaf).toBe(target);
    expect(target.openFile).not.toHaveBeenCalled();
    expect(target.setEphemeralState).toHaveBeenCalledWith({ focus: true });
    expect(target.detach).not.toHaveBeenCalled();
  });

  it('loads a deferred tab, prefers the source group, and keeps existing duplicate tabs', async () => {
    const f = navigationFixture();
    const file = f.addFile('sources/originals/课件.pdf');
    const other = f.makeLeaf(file.path, {});
    other.activeTime = 100;
    const target = f.makeLeaf(file.path);
    target.isDeferred = true;
    await openFileInWorkspace(f.app, file, { line: 18 });
    expect(f.workspace.activeLeaf).toBe(target);
    expect(target.loadIfDeferred).toHaveBeenCalledOnce();
    expect(target.setEphemeralState).toHaveBeenCalledWith({ line: 18, focus: true });
    expect(other.detach).not.toHaveBeenCalled();
    expect(f.leaves).toHaveLength(3);
  });

  it('reuses a target in another window and does not conflate files with the same basename', async () => {
    const f = navigationFixture();
    const file = f.addFile('课程甲/笔记.md');
    const other = f.makeLeaf('课程乙/笔记.md');
    const target = f.makeLeaf(file.path, {});
    await openFileInWorkspace(f.app, file);
    expect(f.workspace.activeLeaf).toBe(target);
    expect(other.openFile).not.toHaveBeenCalled();
    expect(f.workspace.createLeafInParent).not.toHaveBeenCalled();
  });

  it('does not reuse a sidebar view showing the same file', async () => {
    const f = navigationFixture();
    const file = f.addFile('笔记.md');
    const sidebar = f.makeLeaf(file.path, f.workspace.leftSplit);
    await openFileInWorkspace(f.app, file);
    expect(f.workspace.activeLeaf).not.toBe(sidebar);
    expect(f.workspace.createLeafInParent).toHaveBeenCalledOnce();
  });

  it.each(['tab', 'split', 'window'] as const)('honors an explicit %s request', async mode => {
    const f = navigationFixture();
    const file = f.addFile('笔记.md');
    f.makeLeaf(file.path);
    await openFileInWorkspace(f.app, file, { newLeaf: mode });
    expect(f.workspace.getLeaf).toHaveBeenCalledWith(mode);
    expect(f.leaves).toHaveLength(3);
  });

  it('keeps every explicit new-tab request in a burst and focuses the last one', async () => {
    const f = navigationFixture();
    const file = f.addFile('笔记.md');
    const existing = f.makeLeaf(file.path);
    const first = beginFileNavigation(f.app, { newLeaf: 'tab' });
    const second = beginFileNavigation(f.app, { newLeaf: 'tab' });
    expect(await Promise.all([first.open(file), second.open(file)])).toEqual([true, true]);
    expect(f.leaves).toHaveLength(4);
    expect(existing.openFile).not.toHaveBeenCalled();
    expect(f.workspace.activeLeaf).toBe(f.leaves[3]);
    expect(f.leaves[2]!.setEphemeralState).not.toHaveBeenCalled();
  });

  it('preserves the native background-tab preference for every explicit request', async () => {
    const f = navigationFixture();
    f.workspace.focusNewTab = false;
    const file = f.addFile('笔记.md');
    const first = beginFileNavigation(f.app, { newLeaf: 'tab' });
    const second = beginFileNavigation(f.app, { newLeaf: 'tab' });
    expect(await Promise.all([first.open(file), second.open(file)])).toEqual([true, true]);
    expect(f.leaves).toHaveLength(3);
    expect(f.workspace.activeLeaf).toBe(f.source);
    expect(f.workspace.revealLeaf).not.toHaveBeenCalled();
  });

  it('ignores stale preparation and uses the last block request without duplicate creation', async () => {
    const f = navigationFixture();
    const file = f.addFile('汇总.md');
    const stale = beginFileNavigation(f.app);
    const latest = beginFileNavigation(f.app);
    expect(stale.isCurrent()).toBe(false);
    expect(latest.isCurrent()).toBe(true);
    await Promise.all([stale.open(file, { subpath: '#^old' }), latest.open(file, { subpath: '#^new' })]);
    expect(f.leaves).toHaveLength(2);
    expect(f.leaves[1]!.setEphemeralState).toHaveBeenLastCalledWith({ subpath: '#^new', focus: true });
  });

  it('shares an in-flight tab creation with a newer block request', async () => {
    const f = navigationFixture();
    const file = f.addFile('汇总.md');
    const target = f.makeLeaf();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    target.openFile.mockImplementationOnce(async opened => { await gate; target.getViewState().state.file = opened.path; });
    f.workspace.createLeafInParent.mockReturnValueOnce(target);
    const first = beginFileNavigation(f.app).open(file, { subpath: '#^first' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = beginFileNavigation(f.app).open(file, { subpath: '#^last' });
    release();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(f.workspace.createLeafInParent).toHaveBeenCalledTimes(1);
    expect(target.setEphemeralState).toHaveBeenCalledWith({ subpath: '#^last', focus: true });
  });

  it('keeps manual focus changes and closed modal requests while a deferred view loads', async () => {
    const f = navigationFixture();
    const file = f.addFile('汇总.md');
    const target = f.makeLeaf(file.path);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    target.loadIfDeferred.mockImplementationOnce(() => gate);
    let modalOpen = true;
    const pending = beginFileNavigation(f.app, { isValid: () => modalOpen }).open(file);
    await new Promise(resolve => setTimeout(resolve, 0));
    modalOpen = false;
    const manual = f.makeLeaf('其他.md');
    f.workspace.activeLeaf = manual;
    release();
    expect(await pending).toBe(false);
    expect(f.workspace.activeLeaf).toBe(manual);
    expect(f.workspace.revealLeaf).not.toHaveBeenCalled();
  });

  it('does not reopen a closed source or steal focus after a manual switch', async () => {
    const f = navigationFixture();
    const file = f.addFile('笔记.md');
    const closed = beginFileNavigation(f.app);
    f.source.detach();
    expect(closed.isCurrent()).toBe(false);
    await closed.open(file);
    expect(f.workspace.createLeafInParent).not.toHaveBeenCalled();
    const next = f.makeLeaf();
    f.workspace.activeLeaf = next;
    const switched = beginFileNavigation(f.app);
    f.workspace.activeLeaf = f.makeLeaf();
    await switched.open(file);
    expect(f.workspace.createLeafInParent).not.toHaveBeenCalled();
  });

  it('reports missing files and permits retry after a failed open', async () => {
    const f = navigationFixture();
    const file = f.addFile('笔记.md');
    f.files.delete(file.path);
    await expect(openFileInWorkspace(f.app, file)).rejects.toThrow('文件已不存在');
    f.files.set(file.path, file);
    const bad = f.makeLeaf();
    bad.detach();
    bad.detach.mockClear();
    bad.openFile.mockRejectedValueOnce(new Error('磁盘错误'));
    f.workspace.createLeafInParent.mockImplementationOnce(() => { f.leaves.push(bad); return bad; });
    await expect(openFileInWorkspace(f.app, file)).rejects.toThrow('磁盘错误');
    expect(bad.detach).toHaveBeenCalledOnce();
    await openFileInWorkspace(f.app, file);
    expect(f.workspace.activeLeaf!.getViewState().state.file).toBe(file.path);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { TFile, type App } from 'obsidian';
import { CaptureSession, type CaptureSessionOptions, type PreparedCapture } from '../src/plugin/capture-session.js';
import { VaultNoteService } from '../src/plugin/vault-note-service.js';
import type { CaptureRelation } from '../src/domain/capture-context.js';
import { QuickCaptureModal } from '../src/plugin/quick-capture-modal.js';
import { mountQuickCapture } from '../src/plugin/quick-capture-inline.js';
import { Platform, TestElement } from './obsidian-runtime.js';

function fixture() {
  const files = new Map<string, TFile>();
  const contents = new Map<string, string>();
  const folders = new Set<string>();
  const create = vi.fn(async (path: string, markdown: string) => {
    if (files.has(path)) throw new Error('文件已存在');
    const file = new (TFile as unknown as new (path: string) => TFile)(path);
    files.set(path, file); contents.set(path, markdown); return file;
  });
  const app = { vault: {
    getAbstractFileByPath: (path: string) => files.get(path) ?? (folders.has(path) ? { path } : null),
    adapter: { stat: async (path: string) => files.has(path) ? { type: 'file' } : folders.has(path) ? { type: 'folder' } : null },
    createFolder: async (path: string) => { folders.add(path); }, create,
    read: async (file: TFile) => contents.get(file.path), cachedRead: async (file: TFile) => contents.get(file.path),
  } } as unknown as App;
  const notes = new VaultNoteService(app);
  let draft: { text: string; relation: CaptureRelation; prepared?: PreparedCapture } = { text: '', relation: {} };
  const options: CaptureSessionOptions = {
    ...draft,
    persist: (text, relation, prepared) => { draft = { text, relation, prepared }; },
    flush: vi.fn(async () => undefined),
    prepare: (text, relation) => notes.prepareCapture(text.split('\n')[0]!, text, relation),
    write: request => notes.writePreparedCapture(request), refresh: vi.fn(async () => undefined), saved: vi.fn(),
  };
  return { app, notes, files, contents, create, options, draft: () => draft, session: () => new CaptureSession({ ...options, ...draft }) };
}

describe('unified Capture sessions', () => {
  it('publishes one Capture for simultaneous submissions and permits a later identical thought', async () => {
    const f = fixture(); const session = f.session(); session.setText('一个想法\n补充内容');
    const first = session.submit(); expect(session.submit()).toBe(first); await first;
    expect(f.create).toHaveBeenCalledTimes(1);
    const [path, markdown] = f.create.mock.calls[0]!;
    expect(path).toMatch(/^inbox\/captures\/\d{4}\/\d{2}\//u);
    expect(markdown).toContain('type: "Capture"'); expect(markdown).toContain('ingested_via: "direct-entry"');
    expect(markdown).toContain('补充内容'); expect(session.snapshot().text).toBe('');
    session.setText('一个想法\n补充内容'); await session.submit(); expect(f.create).toHaveBeenCalledTimes(2);
  });

  it('does not write when saving the retry target fails and preserves the draft', async () => {
    const f = fixture(); vi.mocked(f.options.flush).mockRejectedValueOnce(new Error('设置不可写'));
    const session = f.session(); session.setText('保留我'); await expect(session.submit()).rejects.toThrow('设置不可写');
    expect(f.create).not.toHaveBeenCalled(); expect(session.snapshot().text).toBe('保留我');
    await session.submit(); expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('retains content after a real writer failure and retries the same target', async () => {
    const f = fixture(); f.create.mockRejectedValueOnce(new Error('磁盘拒绝写入'));
    const session = f.session(); session.setText('稍后再保存');
    const root = new TestElement();
    const unsubscribe = mountQuickCapture(root as unknown as HTMLElement, session, async () => undefined);
    const input = root.descendants().find(el => el.tagName === 'textarea')!;
    await expect(session.submit()).rejects.toThrow('磁盘拒绝写入');
    expect(session.snapshot().text).toBe('稍后再保存');
    expect(input.disabled).toBe(false); expect(input.readOnly).toBe(true);
    const target = f.draft().prepared!.path; await session.submit();
    expect(f.create.mock.calls.map(call => call[0])).toEqual([target, target]); expect(f.files.size).toBe(1);
    expect(input.readOnly).toBe(false); unsubscribe();
  });

  it('restores an unfinished publication after restart without creating a duplicate', async () => {
    const f = fixture(); vi.mocked(f.options.refresh).mockRejectedValueOnce(new Error('刷新失败'));
    const session = f.session(); session.setText('已保存的想法');
    await expect(session.submit()).rejects.toThrow('记录已保存');
    expect(f.draft().prepared).toBeDefined();
    const restarted = f.session(); await restarted.submit();
    expect(f.create).toHaveBeenCalledTimes(1); expect(restarted.snapshot().text).toBe('');
  });

  it('retains the retry identity if clearing the saved draft fails', async () => {
    const f = fixture(); vi.mocked(f.options.flush).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('清理草稿失败'));
    const session = f.session(); session.setText('文件已经写入');
    await expect(session.submit()).rejects.toThrow('记录已保存');
    expect(f.draft().prepared).toBeDefined(); await f.session().submit(); expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('validates associations before publishing and allows correcting an invalid association', async () => {
    const f = fixture(); const session = f.session(); session.setText('关联检查');
    session.setRelation({ course: '/learning/courses/missing/course.md' });
    await expect(session.submit()).rejects.toThrow('关联目标不存在'); expect(f.create).not.toHaveBeenCalled();
    session.setRelation({}); await session.submit(); expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a changed retry target', async () => {
    const f = fixture(); vi.mocked(f.options.refresh).mockRejectedValueOnce(new Error('刷新失败'));
    const session = f.session(); session.setText('原内容'); await expect(session.submit()).rejects.toThrow();
    const path = f.draft().prepared!.path; f.contents.set(path, '用户后来编辑的内容');
    await expect(f.session().submit()).rejects.toThrow('内容不同'); expect(f.contents.get(path)).toBe('用户后来编辑的内容');
  });

  it('rechecks a removed association before writing and lets the user correct it', async () => {
    const f = fixture(); const course = 'learning/courses/os/course.md';
    f.files.set(course, new (TFile as unknown as new (path: string) => TFile)(course));
    f.options.write = async request => { f.files.delete(course); return f.notes.writePreparedCapture(request); };
    const session = f.session(); session.setText('关联目标发生变化'); session.setRelation({ course: `/${course}` });
    await expect(session.submit()).rejects.toThrow('关联目标不存在');
    expect(session.snapshot().locked).toBe(false); session.setRelation({}); await session.submit();
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('synchronizes inline and expanded editors and keeps the shared draft when closing', async () => {
    const f = fixture(); const session = f.session(); const root = new TestElement();
    const unsubscribe = mountQuickCapture(root as unknown as HTMLElement, session, async () => undefined);
    const inline = root.descendants().find(el => el.tagName === 'textarea')!;
    inline.value = '紧凑草稿'; inline.dispatch('input');
    const modal = new QuickCaptureModal(f.app, { courses: [], projects: [] }, {}, () => session.submit(), {
      text: session.snapshot().text, save: text => session.setText(text), saveRelation: relation => session.setRelation(relation),
    }, session);
    modal.open(); const expanded = (modal.contentEl as unknown as TestElement).descendants().find(el => el.tagName === 'textarea')!;
    expect(expanded.value).toBe('紧凑草稿'); expanded.value = '完整草稿\n第二行'; expanded.dispatch('input');
    expect(inline.value).toBe('完整草稿\n第二行'); modal.close(); expect(session.snapshot().text).toBe('完整草稿\n第二行');
    unsubscribe();
  });

  it('ignores IME confirmation and mobile Enter while an explicit save publishes', async () => {
    const f = fixture(); const session = f.session(); const root = new TestElement();
    const unsubscribe = mountQuickCapture(root as unknown as HTMLElement, session, async () => undefined);
    const input = root.descendants().find(el => el.tagName === 'textarea')!;
    input.value = '中文输入'; input.dispatch('input');
    input.dispatch('keydown', { key: 'Enter', isComposing: true, preventDefault: vi.fn() } as unknown as Event);
    input.dispatch('compositionstart');
    input.dispatch('keydown', { key: 'Enter', preventDefault: vi.fn() } as unknown as Event);
    input.dispatch('compositionend');
    input.dispatch('keydown', { key: 'Enter', keyCode: 229, preventDefault: vi.fn() } as unknown as Event);
    input.dispatch('keydown', { key: 'Enter', shiftKey: true, preventDefault: vi.fn() } as unknown as Event);
    Platform.isMobile = true;
    try { input.dispatch('keydown', { key: 'Enter', preventDefault: vi.fn() } as unknown as Event); expect(f.create).not.toHaveBeenCalled(); }
    finally { Platform.isMobile = false; }
    root.descendants().find(el => el.attributes.get('aria-label') === '保存到收集箱')!.click();
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1)); unsubscribe();
  });

  it('shares draft, busy state and successful clearing across compact and widget entries; unsubscribes on destruction', async () => {
    const f = fixture(); const session = f.session();
    const compact = new TestElement(); const widget = new TestElement();
    const stopCompact = mountQuickCapture(compact as unknown as HTMLElement, session, async () => undefined, { compact: true });
    const stopWidget = mountQuickCapture(widget as unknown as HTMLElement, session, async () => undefined);
    const topInput = compact.descendants().find(el => el.tagName === 'textarea')!;
    const widgetInput = widget.descendants().find(el => el.tagName === 'textarea')!;
    topInput.value = '共享草稿'; topInput.dispatch('input'); expect(widgetInput.value).toBe('共享草稿');
    const saving = session.submit(); expect(topInput.disabled).toBe(true); expect(widgetInput.disabled).toBe(true);
    expect(session.submit()).toBe(saving); await saving;
    expect(topInput.value).toBe(''); expect(widgetInput.value).toBe(''); expect(f.create).toHaveBeenCalledOnce();
    stopCompact(); session.setText('下一条'); expect(topInput.value).toBe(''); expect(widgetInput.value).toBe('下一条');
    stopWidget();
  });
});

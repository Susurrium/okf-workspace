import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { Notice, TestElement } from './obsidian-runtime.js';
import { assertApexSettingsPersisted, normalizeApexSettings, resolveApexStartupSettings } from '../src/plugin/apex-settings.js';
import { renderQuickNoteRegion } from '../apex/src/quick-note-section.js';
import { QuickNoteConfigModal } from '../apex/src/quick-note-config-modal.js';
import type { RenderCallbacks } from '../apex/src/types.js';
import type { ApexHost } from '../apex/src/host.js';

vi.mock('../apex/src/icon-picker-modal.js', () => ({ IconPickerModal: class {} }));
vi.mock('obsidian', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), setIcon: vi.fn(), moment: (await import('moment')).default }));

describe('顶部快速记录初始化', () => {
  it.each([null, undefined])('确认无现有配置与旧配置后启用并可持久保存默认值：%s', async raw => {
    const legacy = vi.fn(async () => undefined);
    const resolved = await resolveApexStartupSettings(raw, legacy);
    const settings = normalizeApexSettings(resolved.settings, resolved.firstInstall);
    expect(legacy).toHaveBeenCalledOnce(); expect(resolved.firstInstall).toBe(true);
    expect(settings.quickNotesEnabled).toBe(true); expect(settings.quickCaptureEnabled).toBe(true);
    expect(normalizeApexSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });
  it.each([{}, { apex: {} }, { apex: { quickNotesEnabled: false, quickCaptureEnabled: false, unknown: '保留' } }])('保留已有兼容默认值与关闭选择：%j', async raw => {
    const resolved = await resolveApexStartupSettings(raw, async () => undefined);
    const settings = normalizeApexSettings(resolved.settings, resolved.firstInstall);
    expect(resolved.firstInstall).toBe(false);
    expect(settings.quickNotesEnabled).toBe(false); expect(settings.quickCaptureEnabled).toBe(false);
    if ('apex' in raw && raw.apex && 'unknown' in raw.apex) expect(settings).toHaveProperty('unknown', '保留');
  });
  it('导入旧配置并保留关闭选择；读取失败时终止初始化', async () => {
    const legacy = { quickNotesEnabled: false, quickCaptureEnabled: true, unknown: { value: 1 } };
    const resolved = await resolveApexStartupSettings(null, async () => legacy);
    expect(resolved).toEqual({ settings: legacy, firstInstall: false, importedLegacy: true });
    expect(normalizeApexSettings(resolved.settings)).toMatchObject(legacy);
    await expect(resolveApexStartupSettings(null, async () => { throw new Error('EACCES'); })).rejects.toThrow('EACCES');
    await expect(resolveApexStartupSettings(null, async () => null)).rejects.toThrow('格式无效');
  });
});

describe('顶部快速记录显示与保存', () => {
  it('设置写入静默失败时通过回读拒绝确认保存', () => {
    const settings = normalizeApexSettings({ quickCaptureEnabled: true });
    expect(() => assertApexSettingsPersisted({ apex: settings }, JSON.stringify(settings))).not.toThrow();
    expect(() => assertApexSettingsPersisted({ apex: { ...settings, quickCaptureEnabled: false } }, JSON.stringify(settings))).toThrow('尚未实际保存');
    expect(() => assertApexSettingsPersisted(null, JSON.stringify(settings))).toThrow('尚未实际保存');
  });
  it('仅有共享输入框时隐藏空快捷行且不显示空配置提示', () => {
    const root = new TestElement(); const render = vi.fn();
    renderQuickNoteRegion(root as unknown as HTMLElement, normalizeApexSettings({ quickCaptureEnabled: true, quickDailyEnabled: false }), {
      managedCapture: true, renderManagedCapture: render,
    } as unknown as RenderCallbacks);
    expect(render).toHaveBeenCalledOnce();
    expect(root.descendants('dashboard-quicknote-empty')).toHaveLength(0);
    expect(root.descendants('dashboard-quicknote-nav')[0]).toHaveProperty('hidden', true);
  });
  it('配置快捷操作后保留快捷行；关闭输入框时不挂载 Capture', () => {
    const root = new TestElement(); const render = vi.fn();
    renderQuickNoteRegion(root as unknown as HTMLElement, normalizeApexSettings({ quickCaptureEnabled: false, quickDailyEnabled: true }), {
      managedCapture: true, renderManagedCapture: render,
    } as unknown as RenderCallbacks);
    expect(render).not.toHaveBeenCalled();
    expect(root.descendants('dashboard-quicknote-today')).toHaveLength(1);
    expect(root.descendants('dashboard-quicknote-empty')).toHaveLength(0);
  });
  it('配置窗口分别保存总开关、顶部和侧栏，保留未知字段与旧捕获目标', async () => {
    const saveSettings = vi.fn(async () => undefined); const refreshAllDashboards = vi.fn();
    const host = { settings: normalizeApexSettings({ quickNotesEnabled: false, quickCaptureEnabled: true, quickCaptureTarget: '旧笔记.md', future: 42 }), quickCapture: {}, saveSettings, refreshAllDashboards } as unknown as ApexHost;
    const modal = new QuickNoteConfigModal({} as App, host);
    const controls = modal as unknown as { renderCapture(root: HTMLElement): void; save(): Promise<void> };
    const root = new TestElement(); controls.renderCapture(root as unknown as HTMLElement);
    const toggles = root.descendants().filter(el => el.tagName === 'input');
    expect(toggles.map(el => el.attributes.get('id'))).toEqual(['qn-bar', 'qn-capture', 'qn-unified-capture']);
    Object.assign(toggles[2]!, { checked: false }); toggles[2]!.dispatch('change');
    await controls.save();
    expect(host.settings).toMatchObject({ quickNotesEnabled: false, quickCaptureEnabled: true, widgetQuickCaptureEnabled: false, quickCaptureTarget: '旧笔记.md', future: 42 });
    expect(refreshAllDashboards).toHaveBeenCalledOnce();
  });
  it('配置保存失败时明确提示、保持窗口和输入并恢复原设置', async () => {
    const host = { settings: normalizeApexSettings({ quickCaptureEnabled: true }), quickCapture: {}, saveSettings: vi.fn(async () => { throw new Error('EACCES'); }), refreshAllDashboards: vi.fn() } as unknown as ApexHost;
    const modal = new QuickNoteConfigModal({} as App, host);
    const controls = modal as unknown as { captureEnabled: boolean; renderActions(root: HTMLElement): void };
    controls.captureEnabled = false;
    const close = vi.spyOn(modal, 'close'); const root = new TestElement(); controls.renderActions(root as unknown as HTMLElement);
    const save = root.descendants('dashboard-modal-btn--confirm')[0]!;
    save.dispatch('click', { currentTarget: save } as unknown as Event);
    await vi.waitFor(() => expect(Notice.messages.at(-1)).toContain('EACCES'));
    expect(host.settings.quickCaptureEnabled).toBe(true); expect(controls.captureEnabled).toBe(false);
    expect(close).not.toHaveBeenCalled(); expect(host.refreshAllDashboards).not.toHaveBeenCalled(); expect(save.disabled).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { El, findByClass } from '../apex/scripts/mini-dom.js';
import { PomodoroService } from '../apex/src/pomodoro-service.js';
import { showStopwatchReminderDialog } from '../apex/src/pomodoro-reminder-dialog.js';
import { saveSettingsPatch } from '../apex/src/settings-transaction.js';
import { captureAppearanceSnapshot, customThemeSettingsSlice } from '../apex/src/appearance.js';
import { DEFAULT_SETTINGS, type CustomTheme } from '../apex/src/types.js';
import type { ApexHost } from '../apex/src/host.js';

const services: PomodoroService[] = [];
let body: El;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T10:00:00+08:00'));
  body = new El('body');
  const events = new EventTarget();
  vi.stubGlobal('activeDocument', {
    body, querySelector: () => null, visibilityState: 'visible',
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  });
});
afterEach(() => {
  for (const service of services.splice(0)) service.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function timer(reminder = 0) {
  const files = new Map<string, string>();
  const host = {
    settings: { ...DEFAULT_SETTINGS, pomodoroMode: 'stopwatch', pomodoroStopwatchReminderMinutes: reminder, pomodoroSoundEnabled: false },
    manifest: { id: 'okf-workspace-dashboard' },
    app: { vault: { configDir: '.obsidian', adapter: {
      exists: async (path: string) => files.has(path), read: async (path: string) => files.get(path)!,
      write: async (path: string, data: string) => { files.set(path, data); }, mkdir: async () => {},
    } } },
  } as unknown as ApexHost;
  const service = new PomodoroService(host);
  services.push(service);
  return { host, service, files };
}

describe('选择性 Apex 更新的保存与计时边界', () => {
  it('主题快照完整往返并保留其他设置', async () => {
    const settings = { ...DEFAULT_SETTINGS, stylePreset: 'aqua', bgImage: 'test.png', bgDim: 17, customColors: { accent: '#123456' }, fontScale: 'large' as const };
    const theme: CustomTheme = { id: 'theme-one', name: '测试主题', ...captureAppearanceSnapshot(settings) };
    let written = '';
    const host = { settings: { ...DEFAULT_SETTINGS, dashboardFile: '中文工作台' }, saveSettings: async () => { written = JSON.stringify(host.settings); } };
    await saveSettingsPatch(host, { ...customThemeSettingsSlice(theme), customThemes: [theme] });
    const reopened = JSON.parse(written);
    expect(captureAppearanceSnapshot(reopened)).toEqual(captureAppearanceSnapshot(settings));
    expect(reopened.dashboardFile).toBe('中文工作台');
    expect(reopened.customThemes).toEqual([theme]);
  });

  it('保存失败恢复本次设置，同时保留并发编辑及未知字段', async () => {
    let reject!: (reason: Error) => void;
    const host = {
      settings: { ...DEFAULT_SETTINGS, customThemes: [], activeCustomThemeId: '' },
      saveSettings: () => new Promise<void>((_resolve, failure) => { reject = failure; }),
    };
    const operation = saveSettingsPatch(host, { stylePreset: 'aqua', activeCustomThemeId: 'pending' });
    host.settings = { ...host.settings, stylePreset: 'matcha', futureField: 'kept' } as typeof host.settings;
    reject(new Error('disk unavailable'));
    await expect(operation).rejects.toThrow('disk unavailable');
    expect(host.settings.stylePreset).toBe('matcha');
    expect(host.settings.activeCustomThemeId).toBe('');
    expect((host.settings as unknown as Record<string, unknown>).futureField).toBe('kept');
  });

  it('暂停期间改配置不改变当前计时，重复结束只保存一次', async () => {
    const { host, service, files } = timer();
    await service.loadSessions();
    service.start();
    await vi.advanceTimersByTimeAsync(120_000);
    service.pause();
    host.settings.pomodoroMode = 'timer';
    await vi.advanceTimersByTimeAsync(60_000);
    service.start();
    expect(service.getState().mode).toBe('stopwatch');
    await vi.advanceTimersByTimeAsync(60_000);
    service.stopStopwatch();
    service.stopStopwatch();
    await service.flush();
    const data = JSON.parse(files.get('.obsidian/plugins/okf-workspace-dashboard/pomodoro.json')!);
    expect(data.sessions[0].records).toHaveLength(1);
    expect(data.sessions[0].records[0].duration).toBe(3);
    expect(service.getState().mode).toBe('timer');
  });

  it('周期提醒被动关闭继续计时，销毁服务清理提醒与定时器', async () => {
    const { service } = timer(1);
    await service.loadSessions();
    service.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(findByClass(body, 'dashboard-confirm-card')).toHaveLength(1);
    findByClass(body, 'dashboard-confirm-primary')[0]!.click();
    await Promise.resolve();
    expect(service.getState().status).toBe('running');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(findByClass(body, 'dashboard-confirm-card')).toHaveLength(1);
    service.destroy();
    await Promise.resolve();
    expect(findByClass(body, 'dashboard-confirm-card')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('提醒窗口取消信号按继续处理', async () => {
    const controller = new AbortController();
    const result = showStopwatchReminderDialog(1, controller.signal);
    controller.abort();
    await expect(result).resolves.toBe(false);
    expect(body.children).toHaveLength(0);
  });
});

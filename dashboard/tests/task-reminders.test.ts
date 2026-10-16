import { describe, expect, it, vi } from 'vitest';
import { TaskReminderService, type ReminderStore } from '../src/tasks/reminders.js';
import type { VaultTask } from '../apex/src/alltasks-scan.js';

const task = (fields: Partial<VaultTask> = {}): VaultTask => ({ path: 'note.md', line: 1, text: 'Review', checked: false,
  reminder: '2026-10-13 09:00', blockId: 'task-review', ...fields } as VaultTask);

describe('Vault task reminders', () => {
  it('notifies once across views, remembers acknowledgement, and notifies rescheduled reminders', async () => {
    let item = task();
    let acknowledge: () => Promise<void> = async () => {};
    const states: ReminderStore[] = [];
    const show = vi.fn((_task, ack) => { acknowledge = ack; });
    const service = new TaskReminderService({ read: async () => [item], show, save: async state => { states.push(state); } });
    await service.tick(new Date(2026, 9, 13, 8));
    expect(show).not.toHaveBeenCalled();
    await service.tick(new Date(2026, 9, 13, 10));
    await service.tick(new Date(2026, 9, 13, 11));
    expect(show).toHaveBeenCalledTimes(1);
    await acknowledge();
    const restarted = new TaskReminderService({ read: async () => [item], show, save: async () => {}, acknowledged: states[0] });
    await restarted.tick(new Date(2026, 9, 14));
    expect(show).toHaveBeenCalledTimes(1);
    item = task({ reminder: '2026-10-14 09:00' });
    await restarted.tick(new Date(2026, 9, 14, 10));
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('keeps an acknowledged reminder acknowledged after moving the same task', async () => {
    let item = task();
    let acknowledge: () => Promise<void> = async () => {};
    let saved: ReminderStore = {};
    const show = vi.fn((_task, ack) => { acknowledge = ack; });
    const first = new TaskReminderService({ read: async () => [item], show, save: async state => { saved = state; } });
    await first.tick(new Date(2026, 9, 14));
    await acknowledge();
    item = task({ path: 'moved.md' });
    const second = new TaskReminderService({ read: async () => [item], show, save: async () => {}, acknowledged: saved });
    await second.tick(new Date(2026, 9, 14));
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('handles nested and local tasks separately and skips completed tasks', async () => {
    const show = vi.fn();
    const service = new TaskReminderService({ read: async () => [task(), task({ blockId: 'child' }), task({ checked: true, blockId: 'done' }),
      task({ blockId: undefined, line: 3 }), task({ blockId: undefined, line: 4 })], show, save: async () => {} });
    await service.tick(new Date(2026, 9, 14));
    expect(show).toHaveBeenCalledTimes(4);
  });

  it('reports invalid reminder dates instead of scheduling on a different day', async () => {
    const service = new TaskReminderService({ read: async () => [task({ reminder: '2026-02-30 25:00' })], show: vi.fn(), save: async () => {} });
    await expect(service.tick()).rejects.toThrow('提醒时间无效');
  });
});

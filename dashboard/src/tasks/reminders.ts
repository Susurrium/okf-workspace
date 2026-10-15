import type { VaultTask } from '../../apex/src/alltasks-scan.js';

export interface ReminderStore { [identity: string]: true; }

export function reminderIdentity(task: VaultTask, unique = false): string {
  return JSON.stringify([unique && task.blockId ? '' : task.path, task.blockId || task.upstream?.id || `${task.line}:${task.text}`, task.reminder]);
}

export class TaskReminderService {
  private readonly shown = new Set<string>();
  private running = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly acknowledged: ReminderStore;

  public constructor(private readonly options: {
    read(): Promise<VaultTask[]>;
    acknowledged?: ReminderStore;
    save(state: ReminderStore): Promise<void>;
    show(task: VaultTask, acknowledge: () => Promise<void>): void;
  }) {
    if (options.acknowledged && (typeof options.acknowledged !== 'object' || Array.isArray(options.acknowledged)
      || Object.values(options.acknowledged).some(value => value !== true))) throw new Error('提醒确认记录格式无效');
    this.acknowledged = { ...options.acknowledged };
  }

  public async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tasks = await this.options.read();
      const identities = new Map<string, number>();
      for (const task of tasks) if (task.blockId) identities.set(task.blockId, (identities.get(task.blockId) ?? 0) + 1);
      for (const task of tasks) {
        if (task.checked || !task.reminder) continue;
        const match = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/u.exec(task.reminder);
        if (!match) throw new Error(`提醒时间无效：${task.path}:${task.line + 1}`);
        const [, year, month, day, hour = '0', minute = '0'] = match;
        const at = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
        if (at.getFullYear() !== Number(year) || at.getMonth() !== Number(month) - 1 || at.getDate() !== Number(day)
          || Number(hour) > 23 || Number(minute) > 59) throw new Error(`提醒时间无效：${task.reminder}`);
        const identity = reminderIdentity(task, Boolean(task.blockId && identities.get(task.blockId) === 1));
        if (at > now || this.shown.has(identity) || this.acknowledged[identity]) continue;
        this.shown.add(identity);
        this.options.show(task, async () => {
          this.acknowledged[identity] = true;
          const snapshot = { ...this.acknowledged };
          const write = this.writes.catch(() => undefined).then(() => this.options.save(snapshot));
          this.writes = write;
          await write;
        });
      }
    } finally { this.running = false; }
  }
}

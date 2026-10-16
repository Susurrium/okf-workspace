import type { ListItem } from '../vendor/tasks/src/Task/ListItem';

export * from '../vendor/tasks/src/Obsidian/File';

type Writer = (task: { path: string; lineNumber: number; originalMarkdown: string }, lines: string[]) => Promise<void>;
let writer: Writer | undefined;

export function setTaskWriter(next: Writer | undefined): void { writer = next; }

export async function replaceTaskWithTasks({ originalTask, newTasks }: {
  originalTask: ListItem;
  newTasks: ListItem | ListItem[];
}): Promise<void> {
  if (!writer) throw new Error('任务写入服务尚未启用');
  await writer(originalTask, (Array.isArray(newTasks) ? newTasks : [newTasks]).map(task => task.toFileLineString()));
}

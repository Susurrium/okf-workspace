import { parse as parseYaml } from 'yaml';

export type TaskSourceKind = 'tasks' | 'checklists' | 'excluded';

export function readTaskSourceKind(path: string, markdown: string): TaskSourceKind {
  const yaml = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown)?.[1];
  if (yaml === undefined && /^\uFEFF?---(?:\r?\n|$)/u.test(markdown)) throw new Error(`任务来源 YAML 缺少结束标记：${path}`);
  const metadata: unknown = yaml === undefined ? {} : parseYaml(yaml) ?? {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error(`任务来源 YAML 必须为对象：${path}`);
  return taskSourceKind(path, metadata as Record<string, unknown>);
}

export function taskSourceKind(path: string, metadata: Record<string, unknown> = {}): TaskSourceKind {
  const parts = path.replace(/\\/gu, '/').split('/');
  if (parts.some(part => part.startsWith('.')) || path === 'AGENTS.md' || path === 'index.md'
    || parts[0] === 'system' && ['contracts', 'reports', 'templates', 'views'].includes(parts[1] ?? '')) return 'excluded';
  const marker = metadata.dashboard;
  if (marker !== undefined && typeof marker !== 'boolean') throw new Error(`工作台标记必须为 YAML 布尔值：${path}`);
  const type = metadata.type;
  if (marker === true) {
    if (type !== undefined && type !== '' && (typeof type !== 'string' || type.trim())) throw new Error(`工作台与 Artifact 身份冲突：${path}`);
    const schema = metadata.workbench_schema;
    if (schema !== undefined && (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1)) throw new Error(`工作台版本必须为正整数：${path}`);
    return 'checklists';
  }
  if (type !== undefined && typeof type !== 'string') throw new Error(`任务来源 type 必须为字符串：${path}`);
  if (['source', 'source text', 'digest'].includes(String(type ?? '').trim().toLowerCase()) || parts.at(-1)?.toLowerCase() === 'index.md') return 'excluded';
  return 'tasks';
}

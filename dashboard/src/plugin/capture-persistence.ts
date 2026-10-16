/** 核对当前提交的三个持久化字段，其他上下文和设置可以独立更新。 */
export function assertCaptureDraftPersisted(
  stored: unknown,
  expected: Record<string, unknown>,
  key: string,
): void {
  const filters = (stored as { dashboardUiState?: { pages?: { inbox?: { filters?: unknown } } } } | null)
    ?.dashboardUiState?.pages?.inbox?.filters;
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('快速记录的磁盘草稿状态缺失，请检查插件设置文件。');
  for (const name of [key, `${key}:relation`, `${key}:prepared`]) {
    if ((filters as Record<string, unknown>)[name] !== expected[name]) {
      throw new Error('快速记录草稿尚未实际保存到磁盘，内容已保留，请检查设置目录后重试。');
    }
  }
}

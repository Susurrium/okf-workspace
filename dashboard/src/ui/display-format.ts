export function resourceHost(resource: string | null | undefined): string {
  if (!resource) return "";
  try {
    const url = new URL(resource);
    return ["http:", "https:"].includes(url.protocol) ? url.hostname : "";
  } catch {
    return "";
  }
}

export function relativeMoment(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "";
  const moment = Date.parse(value);
  if (!Number.isFinite(moment)) return "";
  const elapsed = Math.max(0, now - moment);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return new Date(moment).toLocaleDateString();
}

export function formatLocalTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString("zh-CN", { hour12: false });
}

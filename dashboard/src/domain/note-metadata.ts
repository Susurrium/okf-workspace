import moment from 'moment';

export function temporalText(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  return moment.parseZone(text, moment.ISO_8601, true).isValid() ? text : null;
}

function eventMoment(value: unknown): number | null {
  const text = temporalText(value);
  // 缺少时区的历史值不能证明跨设备核验事件的先后。
  return text && text.length > 10 && /(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(text)
    ? moment.parseZone(text, moment.ISO_8601, true).valueOf() : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function generationVerification(fields: Record<string, unknown>): {
  unverified: boolean; warnings: string[];
} {
  const generated = fields.generated;
  if (generated === undefined || generated === null) return { unverified: false, warnings: [] };
  if (!record(generated)) return { unverified: true, warnings: ['generated 必须包含 by、at'] };
  const at = eventMoment(generated.at);
  if (typeof generated.by !== 'string' || !generated.by.trim() || at === null) {
    return { unverified: true, warnings: ['generated.by 或 generated.at 无效，时间必须包含时区'] };
  }
  const verified = fields.verified;
  if (verified === undefined || verified === null) return { unverified: true, warnings: [] };
  const events = Array.isArray(verified) ? verified : [verified];
  const warnings: string[] = [];
  let confirmed = false;
  for (const [index, event] of events.entries()) {
    const verifiedAt = record(event) ? eventMoment(event.at) : null;
    if (!record(event) || typeof event.by !== 'string' || !event.by.trim() || verifiedAt === null) {
      warnings.push(`verified[${index}].by 或 at 无效，时间必须包含时区`);
      continue;
    }
    if (verifiedAt >= at) confirmed = true;
  }
  return { unverified: !confirmed, warnings };
}

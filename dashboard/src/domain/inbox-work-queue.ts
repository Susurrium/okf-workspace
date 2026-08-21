import type {
  ConversionRecord,
  IngestedVia,
  NoteSummary,
  WebCaptureAction,
} from "../api/types.js";

export const INGESTED_VIA_ORDER = [
  "web-clip",
  "file-import",
  "feed",
  "direct-entry",
] as const satisfies readonly IngestedVia[];

export type DisplayIngestedVia = IngestedVia | "unlabeled";
export type IngestedViaFilter = DisplayIngestedVia | "all";

export const INGESTED_VIA_LABELS: Readonly<Record<DisplayIngestedVia, string>> = {
  "web-clip": "网页剪藏",
  "file-import": "手动上传",
  feed: "Feed",
  "direct-entry": "直接记录",
  unlabeled: "未标注",
};

export const WEB_CAPTURE_ACTIONS = [
  { label: "立即学习", action: "learn-now" },
  { label: "稍后学习", action: "learn-later" },
  { label: "生成 Wiki", action: "wiki-now" },
  { label: "仅作参考", action: "source-only" },
] as const satisfies readonly { label: string; action: WebCaptureAction }[];

export interface InboxProjectionData {
  captures: NoteSummary[];
  processed_captures: NoteSummary[];
  pending_imports: NoteSummary[];
}

interface NoteWorkItem {
  key: string;
  ingested_via: DisplayIngestedVia;
  note: NoteSummary;
}

export interface DecisionWorkItem extends NoteWorkItem {
  stage: "decision";
}

export interface ConversionWorkItem {
  key: string;
  stage: "conversion";
  ingested_via: "file-import";
  conversion: ConversionRecord;
}

export type InboxWorkItem = DecisionWorkItem | ConversionWorkItem;

export interface InboxWorkQueue {
  decision: DecisionWorkItem[];
  conversion: ConversionWorkItem[];
  all: InboxWorkItem[];
  channel_counts: Record<DisplayIngestedVia, number>;
}

export interface MaterialContext {
  course?: string;
  project?: string;
}

const PENDING_CONVERSIONS = new Set<ConversionRecord["status"]>([
  "queued",
  "converting",
  "waiting-for-mineru",
  "ready",
  "failed",
]);

export function isIngestedVia(value: unknown): value is IngestedVia {
  return typeof value === "string" && (INGESTED_VIA_ORDER as readonly string[]).includes(value);
}

export function displayIngestedVia(value: unknown): DisplayIngestedVia {
  return isIngestedVia(value) ? value : "unlabeled";
}

export function buildInboxWorkQueue(
  projection: InboxProjectionData,
  conversions: readonly ConversionRecord[],
): InboxWorkQueue {
  const decision = uniqueNotes([...projection.captures, ...projection.pending_imports]).map(
    (note): DecisionWorkItem => ({
      key: `decision:${note.path}`,
      stage: "decision",
      ingested_via: displayIngestedVia(note.ingested_via),
      note,
    }),
  );
  const conversion = conversions
    .filter((record) => PENDING_CONVERSIONS.has(record.status))
    .map((record): ConversionWorkItem => ({
      key: `conversion:${record.conversion_id}`,
      stage: "conversion",
      ingested_via: "file-import",
      conversion: record,
    }));
  const all: InboxWorkItem[] = [...decision, ...conversion];
  const channelCounts: Record<DisplayIngestedVia, number> = {
    "web-clip": 0,
    "file-import": 0,
    feed: 0,
    "direct-entry": 0,
    unlabeled: 0,
  };
  for (const item of all) channelCounts[item.ingested_via] += 1;
  return {
    decision,
    conversion,
    all,
    channel_counts: channelCounts,
  };
}

export function filterInboxItems<T extends InboxWorkItem>(
  items: readonly T[],
  filter: IngestedViaFilter,
): T[] {
  return filter === "all" ? [...items] : items.filter((item) => item.ingested_via === filter);
}

export function materialContextFromNote(
  note: Pick<NoteSummary, "course" | "project">,
): MaterialContext {
  const course = relationSlug(note.course, "learning/courses", "course.md");
  const project = relationSlug(note.project, "projects", "project.md");
  return {
    ...(course ? { course } : {}),
    ...(project ? { project } : {}),
  };
}

function uniqueNotes(notes: readonly NoteSummary[]): NoteSummary[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    if (seen.has(note.path)) return false;
    seen.add(note.path);
    return true;
  });
}

function relationSlug(
  reference: string | null | undefined,
  root: string,
  leaf: string,
): string | undefined {
  const normalized = reference?.trim().replace(/^\/+|\/+$/gu, "");
  if (!normalized) return undefined;
  if (!normalized.includes("/")) return normalized;
  const prefix = `${root}/`;
  const suffix = `/${leaf}`;
  return normalized.startsWith(prefix) && normalized.endsWith(suffix)
    ? normalized.slice(prefix.length, -suffix.length) || undefined
    : undefined;
}

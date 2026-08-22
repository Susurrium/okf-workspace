import type {
  ConversionRecord,
  NoteSummary,
  SemanticOperationRecord,
  TaskItem,
} from "../api/types.js";
import {
  buildInboxWorkQueue,
  type InboxProjectionData,
} from "./inbox-work-queue.js";
import { isSemanticOperationActive } from "./semantic-operation-state.js";

export type TodayAttentionKind =
  | "inbox-decisions"
  | "pending-study"
  | "pending-wiki"
  | "background-running"
  | "background-failed"
  | "today-tasks";

export interface TodayAttentionCounts {
  inbox_decisions: number;
  pending_study: number;
  pending_wiki: number;
  background_running: number;
  background_failed: number;
  today_tasks: number;
}

export interface TodayAttentionItem {
  kind: TodayAttentionKind;
  count: number;
}

export interface TodayAttentionInput {
  inbox: InboxProjectionData;
  pendingStudyCount?: number;
  pendingWikiCount?: number;
  tasks: readonly TaskItem[];
  operations?: readonly SemanticOperationRecord[];
  conversions?: readonly ConversionRecord[];
}

const ACTIVE_CONVERSION_STATUSES = new Set<ConversionRecord["status"]>([
  "queued",
  "converting",
  "waiting-for-mineru",
]);

/** Counts actionable Today work without assigning storage ownership to the UI. */
export function countTodayAttention(input: TodayAttentionInput): TodayAttentionCounts {
  const operations = input.operations ?? [];
  const conversions = input.conversions ?? [];
  const inbox = buildInboxWorkQueue(input.inbox, []);
  return {
    inbox_decisions: inbox.decision.length,
    pending_study: input.pendingStudyCount ?? 0,
    pending_wiki: input.pendingWikiCount ?? 0,
    background_running:
      operations.filter((item) => isSemanticOperationActive(item.status)).length +
      conversions.filter((item) => ACTIVE_CONVERSION_STATUSES.has(item.status)).length,
    background_failed:
      operations.filter((item) => ["failed", "orphaned"].includes(item.status)).length +
      conversions.filter((item) => item.status === "failed").length,
    today_tasks: input.tasks.length,
  };
}

/** Returns only visible, non-empty attention entries in stable display order. */
export function selectTodayAttention(input: TodayAttentionInput): TodayAttentionItem[] {
  const counts = countTodayAttention(input);
  const ordered: readonly [TodayAttentionKind, number][] = [
    ["inbox-decisions", counts.inbox_decisions],
    ["pending-study", counts.pending_study],
    ["pending-wiki", counts.pending_wiki],
    ["background-running", counts.background_running],
    ["background-failed", counts.background_failed],
    ["today-tasks", counts.today_tasks],
  ];
  return ordered
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({ kind, count }));
}

export type DashboardContinueKind = "study-guide" | "project" | "course";

export interface DashboardContinueItem {
  kind: DashboardContinueKind;
  note: NoteSummary;
}

export interface DashboardContinueOptions {
  /** Newest-opened path first. Paths may include one leading slash. */
  recentOpenedPaths?: readonly string[];
  /** The selector never returns more than three items. */
  limit?: number;
}

export type DashboardLearningRowAction =
  | "study-guide"
  | "lesson"
  | "pending-source";

export type DashboardLearningContext = "course" | "project" | "independent";
export type DashboardLearningScope = "all" | DashboardLearningContext;

export interface DashboardLearningScopeCounts {
  all: number;
  course: number;
  project: number;
  independent: number;
}

/**
 * A Study Guide or deferred Source can belong to a Course, a Project, both, or
 * neither. Path fallback keeps older Course-local guides useful without making
 * folder placement the primary contract.
 */
export function dashboardLearningContexts(
  note: Pick<NoteSummary, "course" | "path" | "project">,
): DashboardLearningContext[] {
  const contexts: DashboardLearningContext[] = [];
  if (courseRelationPath(note)) contexts.push("course");
  if (explicitRelationPath(note.project)) contexts.push("project");
  return contexts.length ? contexts : ["independent"];
}

/**
 * Filters the Learning queue by its semantic relation rather than its storage folder.
 *
 * A concrete Course/Project path may be supplied for the second-level scope. Course
 * notes keep a legacy folder fallback, but an explicit `course` relation always wins
 * over that fallback. Project membership is explicit-only. One dual-linked note can
 * therefore appear in both relation scopes while remaining a single row in `all`.
 */
export function filterDashboardLearningScope(
  notes: readonly NoteSummary[],
  scope: DashboardLearningScope,
  relationPath?: string,
): NoteSummary[] {
  const unique = uniqueNoteSummaries(notes);
  if (scope === "all") return unique;
  if (scope === "independent") {
    return unique.filter((note) => dashboardLearningContexts(note).includes("independent"));
  }

  const normalizedRelation = explicitRelationPath(relationPath);
  if (!normalizedRelation) {
    return unique.filter((note) => dashboardLearningContexts(note).includes(scope));
  }
  return unique.filter((note) => {
    const noteRelation = scope === "course"
      ? courseRelationPath(note)
      : explicitRelationPath(note.project);
    return noteRelation === normalizedRelation;
  });
}

/** Counts each note once in `all`; a dual-linked note also contributes to both relation scopes. */
export function dashboardLearningScopeCounts(
  notes: readonly NoteSummary[],
): DashboardLearningScopeCounts {
  return {
    all: filterDashboardLearningScope(notes, "all").length,
    course: filterDashboardLearningScope(notes, "course").length,
    project: filterDashboardLearningScope(notes, "project").length,
    independent: filterDashboardLearningScope(notes, "independent").length,
  };
}

/** Counts a top-level scope or one concrete Course/Project relation. */
export function countDashboardLearningScope(
  notes: readonly NoteSummary[],
  scope: DashboardLearningScope,
  relationPath?: string,
): number {
  return filterDashboardLearningScope(notes, scope, relationPath).length;
}

export function filterDashboardLearningNotes(
  notes: readonly NoteSummary[],
  context: DashboardLearningScope,
): NoteSummary[] {
  return filterDashboardLearningScope(notes, context);
}

/** Keeps Learning row ownership explicit so a deferred Source cannot become a dead end. */
export function dashboardLearningRowAction(
  note: Pick<NoteSummary, "note_type" | "purpose">,
): DashboardLearningRowAction | undefined {
  if (note.note_type === "Study Guide") return "study-guide";
  if (note.note_type === "Lesson") return "lesson";
  if (note.note_type === "Source" && note.purpose === "study") return "pending-source";
  return undefined;
}

/** Completion is a human action, but only after material actually exists and generation is idle. */
export function canCompleteDashboardStudy(
  note: Pick<NoteSummary, "note_type" | "material_ready" | "studied_at">,
  operation?: Pick<SemanticOperationRecord, "status">,
): boolean {
  if (note.note_type !== "Study Guide" || (!note.material_ready && !note.studied_at)) return false;
  return !operation || !isSemanticOperationActive(operation.status);
}

/**
 * Selects a compact Today continuation list. Recently opened notes win, followed by
 * last modification time and a path tie-breaker so the result is deterministic.
 */
export function selectDashboardContinueItems(
  notes: readonly NoteSummary[],
  options: DashboardContinueOptions = {},
): DashboardContinueItem[] {
  const recentRank = new Map<string, number>();
  for (const [index, path] of (options.recentOpenedPaths ?? []).entries()) {
    const normalized = normalizePath(path);
    if (!recentRank.has(normalized)) recentRank.set(normalized, index);
  }
  const candidates = uniqueNotes(notes.flatMap((note): DashboardContinueItem[] => {
    const kind = continueKind(note);
    return kind ? [{ kind, note }] : [];
  }));
  candidates.sort((left, right) => {
    const leftRecent = recentRankForNote(left.note, recentRank);
    const rightRecent = recentRankForNote(right.note, recentRank);
    if (leftRecent !== undefined || rightRecent !== undefined) {
      if (leftRecent === undefined) return 1;
      if (rightRecent === undefined) return -1;
      if (leftRecent !== rightRecent) return leftRecent - rightRecent;
    }
    const momentDifference = noteMoment(right.note) - noteMoment(left.note);
    if (momentDifference) return momentDifference;
    const kindDifference = continueKindOrder(left.kind) - continueKindOrder(right.kind);
    if (kindDifference) return kindDifference;
    return compareText(normalizePath(left.note.path), normalizePath(right.note.path));
  });
  const requested = Number.isFinite(options.limit) ? Math.floor(options.limit ?? 3) : 3;
  return candidates.slice(0, Math.max(0, Math.min(3, requested)));
}

export type DashboardPage = "inbox" | "learning" | "knowledge";
export type DashboardPageSectionKind =
  | "decision"
  | "pending"
  | "ready"
  | "completed"
  | "wiki";

export type DashboardPageOwnership =
  | { page: "inbox"; section: "decision" }
  | { page: "learning"; section: "pending" | "ready" | "completed" }
  | { page: "knowledge"; section: "pending" | "wiki" };

export type DashboardOwnedSection = DashboardPageOwnership & { notes: NoteSummary[] };

/** Assigns each semantic note to at most one workflow page. */
export function classifyDashboardPage(note: NoteSummary): DashboardPageOwnership | undefined {
  if (
    (note.note_type === "Capture" && note.capture_status !== "processed") ||
    (note.note_type === "Source" && note.purpose === "undecided")
  ) {
    return { page: "inbox", section: "decision" };
  }
  if (note.note_type === "Source" && note.purpose === "study") {
    return { page: "learning", section: "pending" };
  }
  if (note.note_type === "Source" && note.purpose === "wiki") {
    return { page: "knowledge", section: "pending" };
  }
  if (note.note_type === "Study Guide") {
    if (note.studied_at) return { page: "learning", section: "completed" };
    return {
      page: "learning",
      section: note.material_ready ? "ready" : "pending",
    };
  }
  if (["Wiki", "Wiki Map"].includes(note.note_type)) {
    return { page: "knowledge", section: "wiki" };
  }
  return undefined;
}

/** Groups owned notes and omits every empty page section. */
export function buildDashboardOwnedSections(
  notes: readonly NoteSummary[],
): DashboardOwnedSection[] {
  const order: readonly DashboardPageOwnership[] = [
    { page: "inbox", section: "decision" },
    { page: "learning", section: "pending" },
    { page: "learning", section: "ready" },
    { page: "learning", section: "completed" },
    { page: "knowledge", section: "pending" },
    { page: "knowledge", section: "wiki" },
  ];
  const buckets = new Map<string, NoteSummary[]>();
  for (const note of notes) {
    const owner = classifyDashboardPage(note);
    if (!owner) continue;
    const key = ownershipKey(owner);
    const bucket = buckets.get(key) ?? [];
    if (!bucket.some((item) => normalizePath(item.path) === normalizePath(note.path))) {
      bucket.push(note);
      buckets.set(key, bucket);
    }
  }
  return order.flatMap((owner): DashboardOwnedSection[] => {
    const owned = buckets.get(ownershipKey(owner));
    if (!owned?.length) return [];
    return [{
      ...owner,
      notes: [...owned].sort(compareNotesByRecency),
    }];
  });
}

export function compareNotesByRecency(left: NoteSummary, right: NoteSummary): number {
  const momentDifference = noteMoment(right) - noteMoment(left);
  return momentDifference || compareText(normalizePath(left.path), normalizePath(right.path));
}

function continueKind(note: NoteSummary): DashboardContinueKind | undefined {
  if (
    note.note_type === "Study Guide" &&
    note.material_ready === true &&
    !note.studied_at &&
    note.status !== "deprecated"
  ) {
    return "study-guide";
  }
  if (note.note_type === "Project" && note.project_status === "active") return "project";
  if (note.note_type === "Course" && note.course_status === "active") return "course";
  return undefined;
}

function uniqueNotes(items: readonly DashboardContinueItem[]): DashboardContinueItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const path = normalizePath(item.note.path);
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

function uniqueNoteSummaries(notes: readonly NoteSummary[]): NoteSummary[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = note.note_type === "Source"
      ? [note.path, note.purpose, note.course, note.project]
        .map((value) => normalizeRelationPath(value ?? ""))
        .join("|")
      : normalizeRelationPath(note.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function courseRelationPath(
  note: Pick<NoteSummary, "course" | "path">,
): string | undefined {
  const explicit = explicitRelationPath(note.course);
  if (explicit) return explicit;
  const match = /^learning\/courses\/([^/]+)\//u.exec(normalizeRelationPath(note.path));
  return match ? `learning/courses/${match[1]}/course.md` : undefined;
}

function explicitRelationPath(value: string | null | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return normalizeRelationPath(value.trim());
}

function normalizeRelationPath(value: string): string {
  return value
    .replace(/\\/gu, "/")
    .replace(/^\/+|\/+$/gu, "")
    .toLocaleLowerCase();
}

function continueKindOrder(kind: DashboardContinueKind): number {
  return kind === "study-guide" ? 0 : kind === "project" ? 1 : 2;
}

function noteMoment(note: NoteSummary): number {
  const value = Date.parse(note.modified_at ?? note.created_at ?? "");
  return Number.isFinite(value) ? value : 0;
}

function recentRankForNote(note: NoteSummary, ranks: ReadonlyMap<string, number>): number | undefined {
  const path = normalizePath(note.path);
  const exact = ranks.get(path);
  if (exact !== undefined) return exact;
  const contextualRoot = note.note_type === "Project" && path.endsWith("/project.md")
    ? path.slice(0, -"/project.md".length)
    : note.note_type === "Course" && path.endsWith("/course.md")
      ? path.slice(0, -"/course.md".length)
      : undefined;
  if (!contextualRoot) return undefined;
  let best: number | undefined;
  for (const [recentPath, rank] of ranks) {
    if (!recentPath.startsWith(`${contextualRoot}/`)) continue;
    best = best === undefined ? rank : Math.min(best, rank);
  }
  return best;
}

function normalizePath(value: string): string {
  return value.replace(/^\/+|\/+$/gu, "");
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function ownershipKey(owner: DashboardPageOwnership): string {
  return `${owner.page}:${owner.section}`;
}

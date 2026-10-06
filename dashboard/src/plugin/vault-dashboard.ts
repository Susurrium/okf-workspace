import { parseYaml, TFile, type App } from "obsidian";

import type {
  CourseSummary,
  LearningProjection,
  LocalTodayView,
  NoteSummary,
  ProjectSummary,
  SourceUse,
  TaskItem,
} from "../api/types.js";
import {
  compareNotesByRecency,
  dashboardLearningScopeEntryCounts,
  filterDashboardLearningScope,
} from "../domain/dashboard-experience.js";
import { isIngestedVia } from "../domain/inbox-work-queue.js";
import { scanFileTasks } from "../../apex/src/alltasks-scan.js";

const USER_ROOTS = new Set(["inbox", "learning", "projects", "knowledge", "life", "sources"]);
const TASK_ROOTS = new Set(["inbox", "learning", "projects", "knowledge", "life", "self"]);

interface ScannedNote {
  file: TFile;
  markdown: string;
  body: string;
  summary: NoteSummary;
}

interface CachedScan {
  fingerprint: string;
  note: ScannedNote | undefined;
}

interface CachedRead {
  fingerprint: string;
  markdown: string;
}

interface DashboardCache {
  scans: Map<string, CachedScan>;
  reads: Map<string, CachedRead>;
}

const DASHBOARD_CACHE = new WeakMap<App, DashboardCache>();

export interface InboxProjection {
  captures: NoteSummary[];
  processed_captures: NoteSummary[];
  pending_imports: NoteSummary[];
}

export interface ProjectsProjection {
  projects: ProjectSummary[];
}

export interface KnowledgeProjection {
  notes: NoteSummary[];
  pending_wiki: NoteSummary[];
}

export interface LifeProjection {
  notes: NoteSummary[];
}

function localDate(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function sameVaultPath(left: string | null | undefined, right: string): boolean {
  if (!left) return false;
  const normalize = (value: string): string =>
    value.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function isPendingCapture(note: NoteSummary): boolean {
  return note.note_type === "Capture" &&
    note.path.startsWith("inbox/captures/") &&
    note.capture_status !== "processed";
}

function sourcePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const resource = (item as Record<string, unknown>).resource;
    return typeof resource === "string" && resource.startsWith("/")
      ? [resource.slice(1)]
      : [];
  });
}

function sourceUses(value: unknown): SourceUse[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SourceUse[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const purpose = textValue(record.purpose);
    if (!purpose) return [];
    return [{
      purpose,
      course: textValue(record.course),
      project: textValue(record.project),
    }];
  });
}

function materialReady(body: string): boolean {
  const content = /<!-- ai:auto:start name="study-material" -->([\s\S]*?)<!-- ai:auto:end name="study-material" -->/u
    .exec(body)?.[1]?.trim() ?? "";
  return Boolean(content) && !content.includes("等待 Codex") && !content.includes("等待生成");
}

function aiUnverified(frontmatter: Record<string, unknown>): boolean {
  const generated = frontmatter.generated;
  if (!generated || typeof generated !== "object" || Array.isArray(generated)) return false;
  const generatedAt = Date.parse(String((generated as Record<string, unknown>).at ?? ""));
  const verified = Array.isArray(frontmatter.verified)
    ? frontmatter.verified
    : frontmatter.verified ? [frontmatter.verified] : [];
  return !verified.some((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const record = event as Record<string, unknown>;
    const at = Date.parse(String(record.at ?? ""));
    return !Number.isFinite(generatedAt) || !Number.isFinite(at) || at >= generatedAt;
  });
}

function splitMarkdown(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(markdown);
  if (!match) return { frontmatter: {}, body: markdown };
  try {
    const parsed = parseYaml(match[1] ?? "");
    return {
      frontmatter:
        parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
      body: markdown.slice(match[0].length),
    };
  } catch (error) {
    throw new Error(`YAML 无法解析：${error instanceof Error ? error.message : "格式错误"}`);
  }
}

export function markdownExcerpt(markdown: string, limit = 220): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/[#>*_`~-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function section(body: string, title: string): string {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${title}\\s*$`, "u").test(line));
  if (start < 0) return "";
  const level = /^#+/u.exec(lines[start] ?? "")?.[0].length ?? 2;
  const selected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#+)\s+/u.exec(line);
    if (heading && heading[1] && heading[1].length <= level) break;
    selected.push(line);
  }
  return markdownExcerpt(selected.join("\n"), 500);
}

function collectTasks(notes: readonly ScannedNote[]): TaskItem[] {
  return notes.flatMap((note) => {
    if (!TASK_ROOTS.has(note.file.path.split("/")[0] ?? "")) return [];
    return scanFileTasks(note.file, note.markdown)
      .filter((task) => task.formal && !task.checked)
      .map((task) => ({ path: task.path, line: task.line + 1, text: task.text }));
  });
}

function inheritSourceMetadata(
  note: NoteSummary,
  sourceByPath: ReadonlyMap<string, NoteSummary>,
): NoteSummary {
  const related = (note.source_paths ?? [])
    .map((path) => sourceByPath.get(path))
    .filter((source): source is NoteSummary => source !== undefined);
  const channels = [...new Set(related.flatMap((source) =>
    source.ingested_via ? [source.ingested_via] : [],
  ))];
  const primary = related[0];
  return {
    ...note,
    ...(channels.length === 1 && channels[0] ? { ingested_via: channels[0] } : {}),
    ...(primary?.resource ? { resource: primary.resource } : {}),
    ...(primary?.kind ? { kind: primary.kind } : {}),
  };
}

function sourceUseProjections(source: NoteSummary, purpose: string): NoteSummary[] {
  const uses = source.uses?.length
    ? source.uses
    : source.purpose
      ? [{ purpose: source.purpose, course: source.course, project: source.project }]
      : [];
  return uses.flatMap((use): NoteSummary[] => use.purpose === purpose
    ? [{
      ...source,
      purpose: use.purpose,
      course: use.course ?? null,
      project: use.project ?? null,
    }]
    : []);
}

function useAlreadyMaterialized(
  source: NoteSummary,
  use: NoteSummary,
  generated: readonly NoteSummary[],
): boolean {
  return generated.some((note) =>
    (note.source_paths ?? []).some((path) => sameVaultPath(path, source.path)) &&
    sameOptionalVaultPath(note.course, use.course) &&
    sameOptionalVaultPath(note.project, use.project),
  );
}

function sameOptionalVaultPath(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return sameVaultPath(left, right);
}

function sourceUsesProject(source: NoteSummary, projectPath: string): boolean {
  if (source.uses?.length) {
    return source.uses.some((use) => sameVaultPath(use.project, projectPath));
  }
  return sameVaultPath(source.project, projectPath);
}

function sourceUsesCourse(source: NoteSummary, coursePath: string): boolean {
  if (source.uses?.length) {
    return source.uses.some((use) => sameVaultPath(use.course, coursePath));
  }
  return sameVaultPath(source.course, coursePath);
}

export class VaultDashboardReader {
  private readonly readWarnings = new Map<string, string>();

  public constructor(private readonly app: App) {}

  public getReadWarnings(): readonly { path: string; message: string }[] {
    return [...this.readWarnings].map(([path, message]) => ({ path, message }));
  }

  private cache(): DashboardCache {
    const existing = DASHBOARD_CACHE.get(this.app);
    if (existing) return existing;
    const created = { scans: new Map<string, CachedScan>(), reads: new Map<string, CachedRead>() };
    DASHBOARD_CACHE.set(this.app, created);
    return created;
  }

  public async today(): Promise<LocalTodayView> {
    const date = localDate();
    const notes = await this.scan();
    const summaries = notes.map((note) => note.summary);
    const pendingStudy = this.pendingLearningFrom(summaries);
    const pendingWiki = this.pendingWikiFrom(summaries);
    const daily = `life/daily/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
    const dailySummary = summaries.find((note) => note.path === daily);
    return {
      date,
      daily: { path: daily, exists: this.app.vault.getAbstractFileByPath(daily) instanceof TFile },
      daily_excerpt: dailySummary?.excerpt ?? "",
      tasks: collectTasks(notes),
      active_projects: await this.projectsFrom(summaries, true, notes),
      active_courses: await this.coursesFrom(summaries),
      recent_study: summaries
        .filter(
          (note) =>
            note.note_type === "Study Guide" &&
            !note.studied_at &&
            note.material_ready === true &&
            note.status !== "deprecated",
        )
        .sort(compareNotesByRecency)
        .slice(0, 8),
      open_inbox_count: summaries.filter(isPendingCapture).length,
      pending_study_count: pendingStudy.length,
      pending_wiki_count: pendingWiki.length,
      stale_knowledge: summaries.filter(
        (note) => ["Wiki", "Wiki Map"].includes(note.note_type) && note.stale,
      ),
    };
  }

  public async inbox(): Promise<InboxProjection> {
    const summaries = (await this.scan()).map((note) => note.summary);
    const notes = summaries
      .filter((note) => note.note_type === "Capture" && note.path.startsWith("inbox/captures/"))
      .sort((left, right) =>
        (right.modified_at ?? "").localeCompare(left.modified_at ?? ""),
      );
    const sources = summaries.filter((note) => note.note_type === "Source");
    return {
      captures: notes.filter(isPendingCapture),
      processed_captures: notes.filter((note) => note.capture_status === "processed"),
      pending_imports: sources.flatMap((note) => sourceUseProjections(note, "undecided")),
    };
  }

  public async learning(): Promise<LearningProjection> {
    const scanned = await this.scan();
    const summaries = scanned.map((note) => note.summary);
    const studyGuides = summaries.filter((note) => note.note_type === "Study Guide");
    const pendingGuides = this.pendingLearningFrom(summaries);
    const readyGuides = studyGuides
      .filter((note) => !note.studied_at && note.material_ready)
      .sort(compareNotesByRecency);
    const completedGuides = studyGuides
      .filter((note) => Boolean(note.studied_at))
      .sort(compareNotesByRecency);
    const [courses, projects] = await Promise.all([
      this.coursesFrom(summaries, false),
      this.projectsFrom(summaries, false, scanned),
    ]);
    return {
      pending_guides: pendingGuides,
      ready_guides: readyGuides,
      completed_guides: completedGuides,
      scope_entry_counts: dashboardLearningScopeEntryCounts([
        ...pendingGuides,
        ...readyGuides,
        ...completedGuides,
      ]),
      courses,
      projects,
    };
  }

  public async projects(): Promise<ProjectsProjection> {
    const scanned = await this.scan();
    const summaries = scanned.map((note) => note.summary);
    return { projects: await this.projectsFrom(summaries, false, scanned) };
  }

  public async knowledge(): Promise<KnowledgeProjection> {
    const allowed = new Set(["Wiki", "Wiki Map"]);
    const summaries = (await this.scan()).map((note) => note.summary);
    return {
      notes: summaries.filter((note) => allowed.has(note.note_type)),
      pending_wiki: this.pendingWikiFrom(summaries),
    };
  }

  public async life(): Promise<LifeProjection> {
    return {
      notes: (await this.scan()).map((note) => note.summary)
        .filter((note) => note.path.startsWith("life/"))
        .sort(compareNotesByRecency),
    };
  }

  private pendingLearningFrom(summaries: readonly NoteSummary[]): NoteSummary[] {
    const sources = summaries.filter((note) => note.note_type === "Source");
    const sourceByPath = new Map(sources.map((note) => [note.path, note]));
    const studyGuides = summaries.filter((note) => note.note_type === "Study Guide");
    return [
      ...studyGuides
        .filter((note) => !note.studied_at && !note.material_ready)
        .map((note) => inheritSourceMetadata(note, sourceByPath)),
      ...sources.flatMap((source) => sourceUseProjections(source, "study")
        .filter((use) => !useAlreadyMaterialized(source, use, studyGuides))),
    ].sort(compareNotesByRecency);
  }

  private pendingWikiFrom(summaries: readonly NoteSummary[]): NoteSummary[] {
    const wikis = summaries.filter((note) => note.note_type === "Wiki");
    return summaries
      .filter((note) => note.note_type === "Source")
      .flatMap((source) => sourceUseProjections(source, "wiki")
        .filter((use) => !useAlreadyMaterialized(source, use, wikis)))
      .sort(compareNotesByRecency);
  }

  private async scan(): Promise<ScannedNote[]> {
    const current = localDate();
    const cache = this.cache();
    const files = this.app.vault.getMarkdownFiles().filter((file) => {
      if (file.path.startsWith("inbox/uploads/") || file.path.startsWith("system/imports/")) return false;
      const root = file.path.split("/")[0] ?? "";
      return USER_ROOTS.has(root) && !["index.md", "log.md"].includes(file.name);
    });
    const currentPaths = new Set(files.map((file) => file.path));
    for (const path of cache.scans.keys()) {
      if (!currentPaths.has(path)) cache.scans.delete(path);
    }
    for (const path of this.readWarnings.keys()) {
      if (!this.app.vault.getAbstractFileByPath(path)) this.readWarnings.delete(path);
    }
    const results = await mapWithConcurrency(files, 8, async (file): Promise<ScannedNote | undefined> => {
      try {
        const fingerprint = `${this.fingerprint(file)}:${current}`;
        const cached = cache.scans.get(file.path);
        if (cached?.fingerprint === fingerprint) return cached.note;
        const markdown = await this.app.vault.cachedRead(file);
        this.readWarnings.delete(file.path);
        cache.reads.set(file.path, { fingerprint: this.fingerprint(file), markdown });
        const parsed = splitMarkdown(markdown);
        const frontmatter = parsed.frontmatter;
        const body = parsed.body;
        const noteType = textValue(frontmatter.type);
        if (!noteType) {
          cache.scans.set(file.path, { fingerprint, note: undefined });
          return undefined;
        }
        const staleAfter = textValue(frontmatter.stale_after);
        const stale = staleAfter ? !/^\d{4}-\d{2}-\d{2}$/u.test(staleAfter) || staleAfter <= current : false;
        const stat = (file as TFile & { stat?: { mtime?: number } }).stat;
        const createdAt = textValue(frontmatter.created_at);
        const fallbackTime = createdAt ? Date.parse(createdAt) : 0;
        const summary: NoteSummary = {
          path: file.path,
          title: textValue(frontmatter.title) ?? file.basename,
          note_type: noteType,
          status: textValue(frontmatter.status) ?? "stable",
          studied_at: textValue(frontmatter.studied_at),
          material_ready: materialReady(body),
          ai_unverified: aiUnverified(frontmatter),
          project_status: textValue(frontmatter.project_status),
          course_status: textValue(frontmatter.course_status),
          capture_status: textValue(frontmatter.capture_status),
          purpose: textValue(frontmatter.purpose),
          ...(isIngestedVia(frontmatter.ingested_via)
            ? { ingested_via: frontmatter.ingested_via }
            : {}),
          resource: textValue(frontmatter.resource),
          kind: textValue(frontmatter.kind),
          course: textValue(frontmatter.course),
          project: textValue(frontmatter.project),
          uses: sourceUses(frontmatter.uses),
          created_at: createdAt,
          modified_at: new Date(stat?.mtime ?? (Number.isFinite(fallbackTime) ? fallbackTime : 0)).toISOString(),
          stale_after: staleAfter,
          stale,
          topics: textList(frontmatter.topics ?? frontmatter.tags),
          source_paths: sourcePaths(frontmatter.sources),
          excerpt: markdownExcerpt(body),
        };
        const note = { file, markdown, body, summary };
        cache.scans.set(file.path, { fingerprint, note });
        return note;
      } catch (error) {
        cache.scans.delete(file.path);
        cache.reads.delete(file.path);
        this.readWarnings.set(file.path, error instanceof Error ? error.message : "文件读取失败");
        return undefined;
      }
    });
    return results.filter((value): value is ScannedNote => value !== undefined);
  }

  private async coursesFrom(
    notes: readonly NoteSummary[],
    activeOnly = true,
  ): Promise<CourseSummary[]> {
    const courses = notes.filter(
      (note) => note.note_type === "Course" &&
        (!activeOnly || !note.course_status || note.course_status === "active"),
    );
    const values = await mapWithConcurrency(courses, 8, async (course): Promise<CourseSummary> => {
      const lessons = filterDashboardLearningScope(
        notes.filter((note) => note.note_type === "Lesson"),
        "course",
        course.path,
      ).sort(compareNotesByRecency);
      const guides = filterDashboardLearningScope(
        notes.filter((note) => note.note_type === "Study Guide"),
        "course",
        course.path,
      );
      const body = splitMarkdown(await this.readPath(course.path)).body;
      return {
        ...course,
        current_progress: section(body, "当前进度"),
        guide_count: guides.length,
        lesson_count: lessons.length,
        related_learning: guides,
        lessons,
        ...(lessons[0] ? { latest_lesson: lessons[0] } : {}),
        related_sources: notes.filter(
          (note) => note.note_type === "Source" && sourceUsesCourse(note, course.path),
        ),
        pending_captures: notes.filter(
          (note) => isPendingCapture(note) && sameVaultPath(note.course, course.path),
        ),
      };
    });
    const order: Record<string, number> = { active: 0, paused: 1, completed: 2 };
    return values.sort(
      (left, right) =>
        (order[left.course_status ?? "active"] ?? 9) - (order[right.course_status ?? "active"] ?? 9) ||
        compareNotesByRecency(left, right),
    );
  }

  private async projectsFrom(
    notes: readonly NoteSummary[],
    activeOnly = true,
    scanned: readonly ScannedNote[] = [],
  ): Promise<ProjectSummary[]> {
    const files = this.app.vault.getFiles();
    const formalTasks = collectTasks(scanned);
    const projects = notes.filter(
      (note) => note.note_type === "Project" && (!activeOnly || note.project_status === "active"),
    );
    const values = await mapWithConcurrency(projects, 8, async (project): Promise<ProjectSummary> => {
      const root = project.path.split("/").slice(0, -1).join("/");
      const body = splitMarkdown(await this.readPath(project.path)).body;
      const logPath = `${root}/log.md`;
      const logFile = files.find((file) => file.path === logPath);
      const activityTime = Math.max(
        Date.parse(project.modified_at ?? "") || 0,
        logFile?.stat?.mtime ?? 0,
      );
      return {
        ...project,
        modified_at: new Date(activityTime).toISOString(),
        current_state: section(body, "当前状态"),
        next_action: section(body, "下一步"),
        recent_log: markdownExcerpt(latestProjectLogEntry(await this.readPath(logPath)), 500),
        log_path: logPath,
        decisions: files.filter(
          (file) => file.path.startsWith(`${root}/decisions/`) && file.name !== "index.md",
        ).map((file) => file.path).sort(),
        outputs: files.filter(
          (file) => file.path.startsWith(`${root}/outputs/`) && file.name !== "index.md",
        ).map((file) => file.path).sort(),
        related_learning: notes.filter(
          (note) => note.note_type === "Study Guide" && sameVaultPath(note.project, project.path),
        ),
        related_materials: notes.filter(
          (note) => note.note_type === "Source" && sourceUsesProject(note, project.path),
        ),
        pending_captures: notes.filter(
          (note) => isPendingCapture(note) && sameVaultPath(note.project, project.path),
        ),
        open_tasks: formalTasks.filter((task) => task.path.startsWith(`${root}/`)),
      };
    });
    const order: Record<string, number> = { active: 0, paused: 1, completed: 2 };
    return values.sort(
      (left, right) =>
        (order[left.project_status ?? ""] ?? 9) - (order[right.project_status ?? ""] ?? 9) ||
        compareNotesByRecency(left, right),
    );
  }

  private async readPath(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return "";
    const fingerprint = this.fingerprint(file);
    const cached = this.cache().reads.get(path);
    if (cached?.fingerprint === fingerprint) return cached.markdown;
    try {
      const markdown = await this.app.vault.cachedRead(file);
      this.readWarnings.delete(path);
      this.cache().reads.set(path, { fingerprint, markdown });
      return markdown;
    } catch (error) {
      this.readWarnings.set(path, error instanceof Error ? error.message : "文件读取失败");
      return "";
    }
  }

  private fingerprint(file: TFile): string {
    const stat = (file as TFile & { stat?: { mtime?: number; size?: number } }).stat;
    return `${file.path}:${stat?.mtime ?? 0}:${stat?.size ?? 0}`;
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await transform(values[index]!);
    }
  }));
  return results;
}

export function latestProjectLogEntry(markdown: string): string {
  const headings = [...markdown.matchAll(/^## (\d{4}-\d{2}-\d{2})[ \t]*\r?$/gmu)];
  const latest = headings.reduce<RegExpMatchArray | undefined>((found, entry) =>
    !found || entry[1]! >= found[1]! ? entry : found, undefined);
  if (!latest) return markdown;
  const next = headings.find((heading) => heading.index! > latest.index!);
  const section = markdown.slice(latest.index! + latest[0].length, next?.index).trim();
  const entries = [...section.matchAll(/^- /gmu)];
  return section.slice(entries.at(-1)?.index ?? 0).trim();
}

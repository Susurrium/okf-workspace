export interface CaptureRelation {
  course?: string;
  project?: string;
}

export interface CaptureContextOption {
  path: string;
  title: string;
}

export interface CaptureContextOptions {
  courses: readonly CaptureContextOption[];
  projects: readonly CaptureContextOption[];
}

export const CAPTURE_ENTRY_ACTION_LABELS = [
  "直接保存到 Inbox",
  "关联 Course 后保存",
  "关联 Project 后保存",
] as const;

export function filterCaptureContextOptions(
  options: readonly CaptureContextOption[],
  query: string,
): CaptureContextOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...options];
  return options.filter((option) =>
    `${option.title} ${option.path}`.toLocaleLowerCase().includes(normalized)
  );
}

const COURSE_PATH = /^learning\/courses\/[^/]+\/course\.md$/u;
const PROJECT_PATH = /^projects\/[^/]+\/project\.md$/u;

/** Store relations as canonical Vault paths with one leading slash. */
export function normalizeCaptureRelation(relation: CaptureRelation = {}): CaptureRelation {
  const normalized: CaptureRelation = {};
  if (relation.course?.trim()) {
    normalized.course = normalizeRelationPath(relation.course, "course");
  }
  if (relation.project?.trim()) {
    normalized.project = normalizeRelationPath(relation.project, "project");
  }
  return normalized;
}

export function relationVaultPath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
}

/**
 * Continue a Capture route without asking twice when its context is already known.
 * The selector is only entered for an unlinked Capture.
 */
export function routeCaptureUsingLinkedContext(
  linked: string | undefined,
  select: (onSelect: (slug: string) => void) => void,
  organize: (slug: string) => void,
): void {
  if (linked) {
    organize(linked);
    return;
  }
  select(organize);
}

function normalizeRelationPath(value: string, kind: "course" | "project"): string {
  const path = relationVaultPath(value.trim());
  const pattern = kind === "course" ? COURSE_PATH : PROJECT_PATH;
  if (!pattern.test(path)) {
    const expected = kind === "course"
      ? "learning/courses/<course>/course.md"
      : "projects/<project>/project.md";
    throw new Error(`${kind === "course" ? "Course" : "Project"} 关联必须指向 ${expected}`);
  }
  return `/${path}`;
}

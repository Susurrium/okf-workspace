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

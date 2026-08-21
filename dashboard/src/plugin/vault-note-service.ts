import { TFile, type App } from "obsidian";

import {
  normalizeCaptureRelation,
  relationVaultPath,
  type CaptureContextOptions,
  type CaptureRelation,
} from "../domain/capture-context.js";

function slugify(value: string, fallback = "note"): string {
  const normalized = value.normalize("NFKC").trim()
    .replace(/[^\p{Letter}\p{Number}_\u3400-\u9fff]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-_]+|[-_]+$/gu, "");
  return normalized || fallback;
}

function localDate(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localTimestamp(value = new Date()): string {
  const offset = -value.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19);
  return `${local}${sign}${hours}:${minutes}`;
}

function document(
  type: string,
  title: string,
  body: string,
  fields: Record<string, string>,
  now = localTimestamp(),
): string {
  const values: Record<string, string> = {
    type,
    title,
    created_at: now,
    ...fields,
  };
  const yaml = Object.entries(values)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${body.trimEnd()}\n`;
}

/** Fast, Vault-native writes for user-authored notes; no local API is required. */
export class VaultNoteService {
  public constructor(private readonly app: App) {}

  public async createCapture(
    title: string,
    content: string,
    relation: CaptureRelation = {},
  ): Promise<{ path: string }> {
    const normalizedRelation = normalizeCaptureRelation(relation);
    this.assertCaptureRelationTargets(normalizedRelation);
    const now = new Date();
    const stamp = `${localDate(now)}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const base = `inbox/captures/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${stamp}-${slugify(title)}`;
    const path = this.availablePath(base);
    const body = await this.renderBody(
      "capture",
      { title, content: content.trim() },
      `# ${title}\n\n${content.trim()}`,
    );
    const fields: Record<string, string> = {
      capture_status: "open",
      ingested_via: "direct-entry",
    };
    if (normalizedRelation.course) fields.course = normalizedRelation.course;
    if (normalizedRelation.project) fields.project = normalizedRelation.project;
    await this.create(path, document("Capture", title, body, fields));
    return { path };
  }

  /** Lightweight local options for Quick Capture; it never calls the backend. */
  public async captureContexts(): Promise<CaptureContextOptions> {
    const courses: { path: string; title: string }[] = [];
    const projects: { path: string; title: string }[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (/^learning\/courses\/[^/]+\/course\.md$/u.test(file.path)) {
        courses.push({ path: file.path, title: await this.contextTitle(file) });
      } else if (/^projects\/[^/]+\/project\.md$/u.test(file.path)) {
        projects.push({ path: file.path, title: await this.contextTitle(file) });
      }
    }
    const byTitle = (left: { title: string }, right: { title: string }): number =>
      left.title.localeCompare(right.title, "zh-CN");
    courses.sort(byTitle);
    projects.sort(byTitle);
    return { courses, projects };
  }

  public async createDaily(): Promise<{ path: string }> {
    const date = localDate();
    const path = `life/daily/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
    if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) return { path };
    const body = await this.renderBody(
      "daily",
      { date, content: "" },
      `# ${date}\n\n## 今天\n\n## 随手记录\n\n## 任务\n\n<!-- ai:auto:start name="linked-activity" -->\n<!-- ai:auto:end name="linked-activity" -->\n\n<!-- ai:auto:start name="organized-daily" -->\n<!-- ai:auto:end name="organized-daily" -->`,
    );
    await this.create(path, document("Daily", date, body, { date }));
    return { path };
  }

  public async appendDailyCapture(content: string): Promise<{ path: string }> {
    const entry = content.trim();
    if (!entry) throw new Error("随手记录不能为空");
    const { path } = await this.createDaily();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`今日日记不存在：${path}`);
    const current = await this.app.vault.read(file);
    const heading = "## 随手记录";
    const start = current.indexOf(heading);
    if (start < 0) throw new Error("今日日记缺少“随手记录”区域");
    const contentStart = start + heading.length;
    const next = current.indexOf("\n## ", contentStart);
    const insertion = next >= 0 ? next : current.length;
    const now = new Date();
    const stamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const prefix = current.slice(0, insertion).trimEnd();
    const suffix = current.slice(insertion).replace(/^\n+/u, "");
    await this.app.vault.modify(file, `${prefix}\n\n- **${stamp}** ${entry}\n\n${suffix}`);
    return { path };
  }

  /** A deterministic local YAML update; completing a Study Guide never needs the API. */
  public async setStudyCompleted(path: string, completed: boolean): Promise<{ path: string }> {
    const normalized = path.replace(/^\/+|\/+$/gu, "");
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || !normalized.toLocaleLowerCase().endsWith(".md")) {
      throw new Error(`学习材料不存在：${normalized}`);
    }
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (completed) frontmatter.studied_at = localTimestamp();
      else delete frontmatter.studied_at;
    });
    return { path: normalized };
  }

  /** Project lifecycle is a local frontmatter edit, not an AI or API task. */
  public async setProjectStatus(
    path: string,
    status: "active" | "paused" | "completed",
  ): Promise<{ path: string }> {
    const normalized = path.replace(/^\/+|\/+$/gu, "");
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || !/^projects\/[^/]+\/project\.md$/u.test(normalized)) {
      throw new Error(`Project 不存在：${normalized}`);
    }
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.project_status = status;
    });
    return { path: normalized };
  }

  public async createReflection(title: string, content: string): Promise<{ path: string }> {
    const base = `life/reflections/${localDate()}-${slugify(title)}`;
    const path = this.availablePath(base);
    const body = await this.renderBody(
      "reflection",
      { title, content: content.trim() },
      `# ${title}\n\n${content.trim()}`,
    );
    await this.create(path, document("Reflection", title, body, {}));
    return { path };
  }

  public async createCourse(title: string, requestedSlug?: string): Promise<{ path: string }> {
    const slug = slugify(requestedSlug || title);
    const root = `learning/courses/${slug}`;
    if (this.app.vault.getAbstractFileByPath(root)) throw new Error(`课程目录已存在：${root}`);
    const path = `${root}/course.md`;
    const body = await this.renderBody(
      "course",
      { title },
      `# ${title}\n\n## 学习目标\n\n## 当前进度\n\n## Lessons\n\n## Study Guides`,
    );
    await this.create(path, document("Course", title, body, { course_status: "active" }));
    return { path };
  }

  public async createLesson(
    course: string,
    title: string,
    content: string,
  ): Promise<{ path: string }> {
    const slug = slugify(course);
    const coursePath = `learning/courses/${slug}/course.md`;
    if (!(this.app.vault.getAbstractFileByPath(coursePath) instanceof TFile)) {
      throw new Error(`课程不存在：${course}`);
    }
    const date = localDate();
    const path = this.availablePath(`learning/courses/${slug}/lessons/${date}-${slugify(title)}`);
    const body = await this.renderBody(
      "lesson",
      { title, human_notes: content.trim(), ai_notes: "" },
      `# ${title}\n\n## 我的课堂原始记录\n\n<!-- human:notes:start -->\n${content.trim()}\n<!-- human:notes:end -->\n\n## AI 整理\n\n<!-- ai:auto:start name="organized-lesson" -->\n<!-- ai:auto:end name="organized-lesson" -->\n\n## 我的问题\n\n## 课后任务`,
    );
    await this.create(
      path,
      document("Lesson", title, body, {
        course: `/${coursePath}`,
        lesson_at: date,
      }),
    );
    return { path };
  }

  public async createProject(title: string, requestedSlug?: string): Promise<{ path: string }> {
    const slug = slugify(requestedSlug || title);
    const root = `projects/${slug}`;
    if (this.app.vault.getAbstractFileByPath(root)) throw new Error(`项目目录已存在：${root}`);
    const logBody = await this.renderBody(
      "project-log",
      { title },
      `# ${title} · 项目日志\n\n该文件按时间记录实际进展、讨论、决定与阻塞；project.md 只保留当前状态。`,
    );
    await this.create(`${root}/log.md`, logBody);
    const path = `${root}/project.md`;
    const body = await this.renderBody(
      "project",
      { title },
      `# ${title}\n\n## 目标与完成标准\n\n## 约束与范围\n\n<!-- ai:auto:start name="project-current-state" -->\n## 当前状态\n\n## 下一步\n<!-- ai:auto:end name="project-current-state" -->\n\n## 任务\n\n## 相关资料与输出`,
    );
    await this.create(
      path,
      document("Project", title, body, { project_status: "active" }),
    );
    return { path };
  }

  public async appendProjectLog(project: string, content: string): Promise<{ path: string }> {
    const path = `projects/${slugify(project)}/log.md`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`项目日志不存在：${path}`);
    const heading = `## ${localDate()}`;
    const entry = content.trim();
    const current = await this.app.vault.read(file);
    const updated = current.includes(heading)
      ? current.replace(heading, `${heading}\n\n- ${entry}`)
      : this.prependProjectLogEntry(current, heading, entry);
    await this.app.vault.modify(file, updated);
    return { path };
  }

  public async createDecision(
    project: string,
    title: string,
    context: string,
    decision: string,
  ): Promise<{ path: string }> {
    const slug = slugify(project);
    const projectPath = `projects/${slug}/project.md`;
    if (!(this.app.vault.getAbstractFileByPath(projectPath) instanceof TFile)) {
      throw new Error(`项目不存在：${project}`);
    }
    const date = localDate();
    const path = this.availablePath(`projects/${slug}/decisions/${date}-${slugify(title)}`);
    const body = await this.renderBody(
      "decision",
      { title, context: context.trim(), decision: decision.trim() },
      `# ${title}\n\n## 背景\n\n${context.trim()}\n\n## 决定\n\n${decision.trim()}\n\n## 考虑过的方案\n\n## 后果与复查条件`,
    );
    await this.create(
      path,
      document("Decision", title, body, {
        project: `/${projectPath}`,
        decided_at: date,
      }),
    );
    return { path };
  }

  private availablePath(base: string): string {
    let path = `${base}.md`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = `${base}-${suffix}.md`;
      suffix += 1;
    }
    return path;
  }

  private assertCaptureRelationTargets(relation: CaptureRelation): void {
    for (const [kind, target] of [
      ["Course", relation.course],
      ["Project", relation.project],
    ] as const) {
      if (!target) continue;
      const path = relationVaultPath(target);
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
        throw new Error(`${kind} 关联目标不存在：${path}`);
      }
    }
  }

  private async contextTitle(file: TFile): Promise<string> {
    const metadataCache = (
      this.app as App & {
        metadataCache?: {
          getFileCache(target: TFile): { frontmatter?: Record<string, unknown> } | null;
        };
      }
    ).metadataCache;
    const cachedTitle = metadataCache?.getFileCache(file)?.frontmatter?.title;
    if (typeof cachedTitle === "string" && cachedTitle.trim()) return cachedTitle.trim();
    const markdown = await this.app.vault.cachedRead(file);
    const heading = /^#\s+(.+)$/mu.exec(markdown)?.[1]?.trim();
    return heading || file.parent?.name || file.basename;
  }

  private prependProjectLogEntry(current: string, heading: string, entry: string): string {
    const [first = "# 项目日志", ...rest] = current.split("\n");
    const title = first.startsWith("# ") ? first : "# 项目日志";
    const existing = (first.startsWith("# ") ? rest.join("\n") : current).trimStart();
    const [intro = "", ...historyParts] = existing.split("\n");
    if (intro.startsWith("该文件按时间记录")) {
      const history = historyParts.join("\n").trimStart();
      return `${title}\n\n${intro}\n\n${heading}\n\n- ${entry}${history ? `\n\n${history}` : ""}`;
    }
    return `${title}\n\n${heading}\n\n- ${entry}${existing ? `\n\n${existing}` : ""}`;
  }

  private async renderBody(
    name: string,
    values: Record<string, string>,
    fallback: string,
  ): Promise<string> {
    const path = `system/templates/canonical/${name}.md`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return fallback.trimEnd();
    let template = await this.app.vault.cachedRead(file);
    for (const [key, value] of Object.entries(values)) {
      template = template.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gu"), () => value);
    }
    const unresolved = template.match(/\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/u);
    if (unresolved) throw new Error(`模板 ${path} 缺少变量：${unresolved[0]}`);
    return template.trimEnd();
  }

  private async create(path: string, content: string): Promise<void> {
    const parent = path.split("/").slice(0, -1).join("/");
    await this.ensureFolder(parent);
    await this.app.vault.create(path, content);
  }

  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }
}

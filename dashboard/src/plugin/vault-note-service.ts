import { TFile, type App } from "obsidian";
import { projectCategory } from "../domain/project-organization.js";
import { prepareTaskLine } from '../../tasks-generated/core.js';
import { readTaskSourceKind } from '../../apex/src/task-source.js';

import {
  normalizeCaptureRelation,
  relationVaultPath,
  type CaptureContextOptions,
  type CaptureRelation,
} from "../domain/capture-context.js";

export type ReviewPeriod = "weekly" | "monthly" | "yearly";

interface ReviewDescriptor {
  key: string;
  title: string;
  range: string;
}

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

function utcDate(value: Date): Date {
  return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
}

function utcDateText(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function reviewDescriptor(period: ReviewPeriod, value: Date): ReviewDescriptor {
  const year = value.getFullYear();
  const month = value.getMonth();
  if (period === "weekly") {
    const current = utcDate(value);
    const weekday = current.getUTCDay() || 7;
    const start = new Date(current);
    start.setUTCDate(current.getUTCDate() - weekday + 1);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    const thursday = new Date(current);
    thursday.setUTCDate(current.getUTCDate() + 4 - weekday);
    const isoYear = thursday.getUTCFullYear();
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
    const key = `${isoYear}-W${String(week).padStart(2, "0")}`;
    return {
      key,
      title: `${key} 每周复盘`,
      range: `${utcDateText(start)} — ${utcDateText(end)}`,
    };
  }
  if (period === "monthly") {
    const key = `${year}-${String(month + 1).padStart(2, "0")}`;
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 0));
    return {
      key,
      title: `${key} 每月复盘`,
      range: `${utcDateText(start)} — ${utcDateText(end)}`,
    };
  }
  const key = String(year);
  return {
    key,
    title: `${key} 每年复盘`,
    range: `${key}-01-01 — ${key}-12-31`,
  };
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
  private readonly pendingProjects = new Map<string, Map<string, string>>();
  private readonly projectCreates = new Map<string, Promise<{ path: string }>>();
  private readonly projectRequests = new Map<string, string>();
  private readonly dailyCreates = new Map<string, Promise<{ path: string }>>();
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
    const base = `inbox/captures/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${stamp}-${slugify(title).slice(0, 72)}`;
    const path = this.availablePath(base);
    const normalizedContent = content.trim();
    const [firstLine = "", ...remainingLines] = normalizedContent.split(/\r?\n/u);
    const bodyContent = firstLine.trim() === title.trim()
      ? remainingLines.join("\n").trim()
      : normalizedContent;
    const body = await this.renderBody(
      "capture",
      { title, content: bodyContent },
      [`# ${title}`, bodyContent].filter(Boolean).join("\n\n"),
    );
    const fields: Record<string, string> = {
      ingested_via: "direct-entry",
    };
    if (normalizedRelation.course) fields.course = normalizedRelation.course;
    if (normalizedRelation.project) fields.project = normalizedRelation.project;
    await this.create(path, document("Capture", title, body, fields));
    return { path };
  }

  /**
   * Convert one workbench card exactly once. The durable source marker lets a
   * retry after restart find a Capture written before the card was removed.
   */
  public async createCaptureFromWorkbench(
    workspacePath: string,
    cardId: string,
    title: string,
    content: string,
  ): Promise<{ path: string; created: boolean }> {
    const source = `${workspacePath.replace(/\.md$/u, "")}#${cardId}`;
    const marker = `<!-- okf:apex-capture source=${JSON.stringify(source)} -->`;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith("inbox/captures/")) continue;
      const existing = await this.app.vault.cachedRead(file);
      if (existing.includes(marker)) return { path: file.path, created: false };
    }
    const body = [content.trim(), marker].filter(Boolean).join("\n\n");
    const result = await this.createCapture(title, body);
    return { ...result, created: true };
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

  public async createDaily(date = localDate()): Promise<{ path: string }> {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`日记日期无效：${date}`);
    const pending = this.dailyCreates.get(date);
    if (pending) return pending;
    const request = this.publishDaily(date);
    this.dailyCreates.set(date, request);
    try { return await request; }
    finally { this.dailyCreates.delete(date); }
  }

  private async publishDaily(date: string): Promise<{ path: string }> {
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
    await this.app.vault.process(file, (current) => {
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
      return `${prefix}\n\n- **${stamp}** ${entry}\n\n${suffix}`;
    });
    return { path };
  }

  public async appendDailyTaskBlock(block: string): Promise<{ path: string }> {
    if (!block.trim()) throw new Error("任务内容不能为空");
    const { path } = await this.createDaily();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`日记尚未到达：${path}`);
    await this.app.vault.process(file, current => {
      if (readTaskSourceKind(file.path, current) !== 'tasks') throw new Error('日记目标不能保存 Tasks 任务');
      const lines = current.split(/\r?\n/u);
      const heading = lines.findIndex(line => /^## 任务\s*$/u.test(line));
      if (heading < 0) throw new Error(`日记缺少“任务”区域：${path}`);
      const next = lines.findIndex((line, index) => index > heading && /^##\s+/u.test(line));
      lines.splice(next < 0 ? lines.length : next, 0, block.trim(), "");
      return lines.join("\n");
    });
    return { path };
  }

  public async appendTaskToNote(file: TFile, block: string): Promise<void> {
    if (!block.trim()) throw new Error("任务或清单内容不能为空");
    await this.app.vault.process(file, current => {
      if (readTaskSourceKind(file.path, current) !== 'tasks') throw new Error('目标笔记不能保存 Tasks 任务');
      return `${current.trimEnd()}\n\n${block.trim()}\n`;
    });
  }

  public async createTaskContainer(path: string, block: string): Promise<void> {
    if (!path.endsWith('.md') || path.replace(/\\/gu, '/').split('/').some(part => ['.', '..'].includes(part) || part.includes(':'))) throw new Error('任务目标笔记路径无效');
    await this.create(path, `${block.trim()}\n`);
  }

  public async appendDailyTask(
    date: string,
    taskLine: string,
    position: "start" | "end" = "start",
  ): Promise<{ file: TFile; line: number; writtenLine: string; kind: "daily-top" | "daily-end" | "daily-created" }> {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`任务日期无效：${date}`);
    const oneLine = taskLine.trim();
    if (!/^- \[[ xX]\]\s+/u.test(oneLine) || oneLine.includes("\n")) {
      throw new Error("任务必须是单行 Markdown 清单");
    }
    const formal = prepareTaskLine(oneLine);
    const writtenLine = /\s\^[a-zA-Z0-9-]+\s*$/u.test(formal)
      ? formal
      : `${formal} ^task-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const path = `life/daily/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
    const existed = this.app.vault.getAbstractFileByPath(path) instanceof TFile;
    await this.createDaily(date);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`日记不存在：${path}`);

    let insertedLine = -1;
    await this.app.vault.process(file, (current) => {
      if (readTaskSourceKind(file.path, current) !== 'tasks') throw new Error('日记目标不能保存 Tasks 任务');
      const lines = current.split(/\r?\n/u);
      const existing = lines.indexOf(writtenLine);
      if (existing >= 0) {
        insertedLine = existing;
        return current;
      }
      const heading = lines.findIndex((line) => /^##\s+任务\s*$/u.test(line));
      if (heading < 0) throw new Error(`日记缺少“任务”区域：${path}`);
      const sectionEnd = lines.findIndex((line, index) => index > heading && /^##\s+/u.test(line));
      let at = sectionEnd >= 0 ? sectionEnd : lines.length;
      if (position === "start") {
        at = heading + 1;
        while (at < lines.length && lines[at]?.trim() === "") at += 1;
      } else {
        while (at > heading + 1 && lines[at - 1]?.trim() === "") at -= 1;
      }
      lines.splice(at, 0, writtenLine);
      insertedLine = at;
      return lines.join("\n");
    });
    if (insertedLine < 0) throw new Error(`任务未写入：${path}`);
    return {
      file,
      line: insertedLine,
      writtenLine,
      kind: existed ? (position === "end" ? "daily-end" : "daily-top") : "daily-created",
    };
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
      throw new Error(`项目不存在：${normalized}`);
    }
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.project_status = status;
    });
    return { path: normalized };
  }

  public async setProjectCategory(path: string, category: string | null, expected?: string | null): Promise<{ path: string }> {
    const normalized = path.replace(/^\/+|\/+$/gu, "");
    const next = projectCategory(category);
    if (!/^projects\/[^/]+\/project\.md$/u.test(normalized) || normalized.split("/").some(part => part === "." || part === ".." || part.includes(":"))) throw new Error("请选择规范路径下的项目主页");
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile) || file.path !== normalized) throw new Error("请选择规范路径下的项目主页");
    await this.app.fileManager.processFrontMatter(file, fields => {
      if (fields.type !== "Project") throw new Error("目标笔记不是 Project");
      const current = projectCategory(fields.project_category);
      if (next !== null && fields.project_category === next || next === null && !("project_category" in fields)) return;
      if (expected !== undefined && current !== projectCategory(expected)) throw new Error("项目类别已经变化，请重新读取后操作");
      if (next === null) delete fields.project_category;
      else fields.project_category = next;
    });
    return { path: normalized };
  }

  public async renameProjectCategory(paths: readonly string[], from: string, to: string | null): Promise<{ path: string; error?: string }[]> {
    const previous = projectCategory(from);
    const next = projectCategory(to);
    if (!previous) throw new Error("请选择要重命名的类别");
    const results: { path: string; error?: string }[] = [];
    for (const path of new Set(paths)) {
      try { await this.setProjectCategory(path, next, previous); results.push({ path }); }
      catch (error) { results.push({ path, error: error instanceof Error ? error.message : String(error) }); }
    }
    return results;
  }

  public async createReflection(title: string, content: string): Promise<{ path: string }> {
    const base = `life/reflections/${slugify(title)}`;
    const path = this.availablePath(base);
    const body = await this.renderBody(
      "reflection",
      { title, content: content.trim() },
      `# ${title}\n\n${content.trim()}`,
    );
    await this.create(path, document("Reflection", title, body, {}));
    return { path };
  }

  /** Create or reopen a periodic Review entirely inside the Vault. */
  public async createReview(
    period: ReviewPeriod,
    value = new Date(),
  ): Promise<{ path: string; created: boolean }> {
    const review = reviewDescriptor(period, value);
    const path = `life/reviews/${period}/${review.key}.md`;
    if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) return { path, created: false };
    const body = await this.renderBody(
      "review",
      { title: review.title, period_range: review.range },
      `# ${review.title}\n\n> 复盘范围：${review.range}\n\n## 本期回看\n\n## 做得好的\n\n## 阻力与偏差\n\n## 学到与改变\n\n## 下一周期\n\n## 补充记录\n\n<!-- ai:auto:start name="organized-review" -->\n<!-- ai:auto:end name="organized-review" -->`,
    );
    await this.create(path, document("Review", review.title, body, {}));
    return { path, created: true };
  }

  public async createCourse(title: string, requestedSlug?: string): Promise<{ path: string }> {
    const slug = slugify(requestedSlug || title);
    const root = `learning/courses/${slug}`;
    if (this.app.vault.getAbstractFileByPath(root)) throw new Error(`课程目录已存在：${root}`);
    const path = `${root}/course.md`;
    const body = await this.renderBody(
      "course",
      { title },
      `# ${title}\n\n## 学习目标\n\n## 当前进度\n\n## 课堂笔记\n\n## 学习笔记`,
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

  public async createProject(title: string, requestedSlug?: string, category?: string | null): Promise<{ path: string }> {
    const normalizedCategory = projectCategory(category);
    const slug = slugify(requestedSlug || title);
    const identity = JSON.stringify([title, normalizedCategory]);
    if (this.projectRequests.has(slug) && this.projectRequests.get(slug) !== identity) throw new Error("项目创建尚未完成，请使用原名称与类别重试");
    this.projectRequests.set(slug, identity);
    const inFlight = this.projectCreates.get(slug);
    if (inFlight) return inFlight;
    const request = this.publishProject(title, slug, normalizedCategory);
    this.projectCreates.set(slug, request);
    try {
      return await request;
    } finally {
      this.projectCreates.delete(slug);
      if (!this.pendingProjects.has(`projects/${slug}`)) this.projectRequests.delete(slug);
    }
  }

  private async publishProject(title: string, slug: string, category: string | null): Promise<{ path: string }> {
    const root = `projects/${slug}`;
    const pending = this.pendingProjects.get(root);
    if (this.app.vault.getAbstractFileByPath(root) && !pending) throw new Error(`项目目录已存在：${root}`);
    const logBody = await this.renderBody(
      "project-log",
      { title },
      `# ${title} · 项目日志\n\n该文件按时间记录实际进展、讨论、决定与阻塞；project.md 只保留当前状态。`,
    );
    const path = `${root}/project.md`;
    const body = await this.renderBody(
      "project",
      { title },
      `# ${title}\n\n## 目标与完成标准\n\n## 约束与范围\n\n<!-- ai:auto:start name="project-current-state" -->\n## 当前状态\n\n## 下一步\n<!-- ai:auto:end name="project-current-state" -->\n\n## 任务\n\n## 相关资料与输出`,
    );
    // Render every template before publishing any part of the project. Retain
    // this operation's payload for retry, but never overwrite user edits.
    const files = pending ?? new Map([
      [`${root}/log.md`, logBody],
      [path, document("Project", title, body, { project_status: "active", ...(category ? { project_category: category } : {}) })],
    ]);
    this.pendingProjects.set(root, files);
    for (const [target, content] of files) {
      const existing = this.app.vault.getAbstractFileByPath(target);
      if (existing) {
        if (!(existing instanceof TFile) || await this.app.vault.read(existing) !== content) {
          throw new Error(`创建尚未完成，但文件已经更改，已保留：${target}`);
        }
        continue;
      }
      await this.create(target, content);
    }
    this.pendingProjects.delete(root);
    return { path };
  }

  public async appendProjectLog(project: string, content: string): Promise<{ path: string }> {
    const path = `projects/${slugify(project)}/log.md`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`项目日志不存在：${path}`);
    const heading = `## ${localDate()}`;
    const entry = content.trim();
    if (!entry) throw new Error("项目日志内容不能为空");
    const now = new Date();
    const stamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const line = `**${stamp}** ${entry.replace(/\r?\n/gu, "\n  ")}`;
    await this.app.vault.process(file, (current) => appendProjectLogEntry(current, heading, line));
    return { path };
  }

  public async createDecision(
    project: string,
    title: string,
    context = "",
    decision = "",
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
    if ((await this.app.vault.adapter.stat(path))?.type === "file") {
      throw new Error(`文件在磁盘中已存在，但 Obsidian 尚未识别或文件刚被其他操作创建：${path}`);
    }
    await this.app.vault.create(path, content);
  }

  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        if ((await this.app.vault.adapter.stat(current))?.type === "folder") {
          throw new Error(`目录在磁盘中已存在，但 Obsidian 尚未识别；请重新加载后重试：${current}`);
        }
        try { await this.app.vault.createFolder(current); }
        catch (error) {
          if (!this.app.vault.getAbstractFileByPath(current)) throw error;
        }
      }
    }
  }
}

/** Append new dates and entries in order without rewriting historical sections. */
export function appendProjectLogEntry(current: string, heading: string, entry: string): string {
  const matches = [...current.matchAll(/^## (\d{4}-\d{2}-\d{2})[ \t]*\r?$/gmu)];
  const prefix = current.slice(0, matches[0]?.index ?? current.length).trimEnd();
  const sections = matches.map((match, index) => ({
    date: match[1]!,
    text: current.slice(match.index, matches[index + 1]?.index ?? current.length).trimEnd(),
  }));
  const date = heading.slice(3);
  const section = sections.at(-1)?.date === date ? sections.at(-1) : undefined;
  if (section) section.text += `\n\n- ${entry}`;
  else sections.push({ date, text: `${heading}\n\n- ${entry}` });
  return [prefix, ...sections.map((item) => item.text)].filter(Boolean).join("\n\n") + "\n";
}

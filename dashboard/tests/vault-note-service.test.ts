import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";

import { VaultDashboardReader } from "../src/plugin/vault-dashboard.js";
import { VaultNoteService } from "../src/plugin/vault-note-service.js";

describe("VaultNoteService", () => {
  it("creates user-authored notes directly in the Vault and projects them immediately", async () => {
    const markdown = new Map<string, string>();
    const files = new Map<string, TFile>();
    const folders = new Set<string>();
    const frontmatterByPath = new Map<string, Record<string, unknown>>();
    const vault = {
      getAbstractFileByPath: (path: string) => files.get(path) ?? (folders.has(path) ? { path } : null),
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, content: string) => {
        const file = new (TFile as unknown as new (value: string) => TFile)(path);
        files.set(path, file);
        markdown.set(path, content);
        return file;
      },
      read: async (file: TFile) => markdown.get(file.path) ?? "",
      cachedRead: async (file: TFile) => markdown.get(file.path) ?? "",
      modify: async (file: TFile, content: string) => {
        markdown.set(file.path, content);
      },
      getMarkdownFiles: () => [...files.values()].filter((file) => file.name.endsWith(".md")),
      getFiles: () => [...files.values()],
    };
    const fileManager = {
      processFrontMatter: async (
        file: TFile,
        update: (frontmatter: Record<string, unknown>) => void,
      ) => {
        const frontmatter = frontmatterByPath.get(file.path) ?? {};
        update(frontmatter);
        frontmatterByPath.set(file.path, frontmatter);
      },
    };
    const app = { vault, fileManager } as unknown as App;
    const notes = new VaultNoteService(app);
    const projectTemplatePath = "system/templates/canonical/project.md";
    files.set(
      projectTemplatePath,
      new (TFile as unknown as new (value: string) => TFile)(projectTemplatePath),
    );
    markdown.set(projectTemplatePath, "# {{title}}\n\nSHARED ARTIFACT CONTRACT\n");
    const capture = await notes.createCapture("一个待处理想法", "稍后整理这条内容。");
    const daily = await notes.createDaily();
    await notes.appendDailyCapture("这条内容属于今天，而不是 Inbox。");
    const weeklyReview = await notes.createReview("weekly", new Date(2026, 7, 17, 12));
    const monthlyReview = await notes.createReview("monthly", new Date(2026, 7, 17, 12));
    const yearlyReview = await notes.createReview("yearly", new Date(2026, 7, 17, 12));
    const boundaryReview = await notes.createReview("weekly", new Date(2021, 0, 1, 12));
    const project = await notes.createProject("测试项目", "test-project");
    const course = await notes.createCourse("测试课程", "test-course");
    const linkedCapture = await notes.createCapture(
      "项目课程想法",
      "这条记录先留在 Inbox，但在对应上下文中也能找到。",
      { project: project.path, course: course.path },
    );
    const guidePath = "learning/guides/local-first.md";
    files.set(guidePath, new (TFile as unknown as new (value: string) => TFile)(guidePath));
    frontmatterByPath.set(guidePath, { type: "Study Guide", custom: "保留" });
    await notes.setStudyCompleted(guidePath, true);
    expect(frontmatterByPath.get(guidePath)).toEqual(expect.objectContaining({
      type: "Study Guide",
      custom: "保留",
      studied_at: expect.any(String),
    }));
    await notes.setStudyCompleted(guidePath, false);
    expect(frontmatterByPath.get(guidePath)).not.toHaveProperty("studied_at");
    frontmatterByPath.set(project.path, { type: "Project", custom: "保留" });
    await notes.setProjectStatus(project.path, "paused");
    expect(frontmatterByPath.get(project.path)).toEqual({
      type: "Project",
      custom: "保留",
      project_status: "paused",
    });

    expect(capture.path).toMatch(/^inbox\/captures\/\d{4}\/\d{2}\//u);
    expect(markdown.get(capture.path)).toContain('capture_status: "open"');
    expect(markdown.get(capture.path)).toContain('ingested_via: "direct-entry"');
    expect(project.path).toBe("projects/test-project/project.md");
    expect(markdown.get(project.path)).toContain('project_status: "active"');
    expect(markdown.get(project.path)).toContain("SHARED ARTIFACT CONTRACT");
    expect(markdown.get("projects/test-project/log.md")).toContain("测试项目 · 项目日志");
    expect(markdown.get(daily.path)).toContain("这条内容属于今天，而不是 Inbox。");
    expect(weeklyReview.path).toBe("life/reviews/weekly/2026-W34.md");
    expect(monthlyReview.path).toBe("life/reviews/monthly/2026-08.md");
    expect(yearlyReview.path).toBe("life/reviews/yearly/2026.md");
    expect(boundaryReview.path).toBe("life/reviews/weekly/2020-W53.md");
    expect(markdown.get(weeklyReview.path)).toContain('type: "Review"');
    expect(markdown.get(weeklyReview.path)).toContain("复盘范围：2026-08-17 — 2026-08-23");
    expect(markdown.get(boundaryReview.path)).toContain("复盘范围：2020-12-28 — 2021-01-03");
    expect(await notes.createReview("weekly", new Date(2026, 7, 19, 12))).toEqual(weeklyReview);
    expect(markdown.get(linkedCapture.path)).toContain(
      'course: "/learning/courses/test-course/course.md"',
    );
    expect(markdown.get(linkedCapture.path)).toContain(
      'project: "/projects/test-project/project.md"',
    );
    expect(await notes.captureContexts()).toEqual({
      courses: [{ path: course.path, title: "测试课程" }],
      projects: [{ path: project.path, title: "测试项目" }],
    });
    await expect(
      notes.createCapture("错误关联", "不能保存到不存在的项目。", {
        project: "projects/missing/project.md",
      }),
    ).rejects.toThrow("Project 关联目标不存在");
    expect(markdown.has("projects/test-project/index.md")).toBe(false);
    expect(folders.has("projects/test-project/decisions")).toBe(false);
    expect(folders.has("projects/test-project/outputs")).toBe(false);
    const today = await new VaultDashboardReader(app).today();
    expect(today.open_inbox_count).toBe(2);
    expect(today.active_projects).toEqual([
      expect.objectContaining({ title: "测试项目", project_status: "active" }),
    ]);
    const inbox = await new VaultDashboardReader(app).inbox();
    expect(inbox.captures[0]?.ingested_via).toBe("direct-entry");
  });
});

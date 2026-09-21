import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";

import { VaultDashboardReader } from "../src/plugin/vault-dashboard.js";

describe("VaultDashboardReader", () => {
  it("projects courses, projects, tasks, and captures directly from Markdown", async () => {
    const markdown = new Map<string, string>([
      [
        "learning/courses/cs61a/course.md",
        note("Course", "CS61A", "course_status: active", "## 当前进度\n完成递归，下一步学习树。"),
      ],
      [
        "learning/courses/cs61a/lessons/01.md",
        note("Lesson", "递归", "", "- [ ] #task 复习递归\n\n课堂内容"),
      ],
      [
        "projects/okf/project.md",
        note(
          "Project",
          "个人知识工作区",
          "project_status: active",
          "## 当前状态\nDashboard local-first。\n\n## 下一步\n完成生产部署。\n\n## 任务\n- [ ] #task 发布工作台 [scheduled:: 2026-09-29] ^task-release",
        ),
      ],
      ["projects/okf/log.md", "# 项目日志\n\n2026-08-17：完成直接读取 Vault。"],
      [
        "inbox/captures/idea.md",
        note(
          "Capture",
          "一个想法",
          "capture_status: open\ningested_via: web-clip\nresource: https://example.com/article\nkind: web",
          "稍后整理这个想法。",
        ),
      ],
      [
        "inbox/captures/course-idea.md",
        note(
          "Capture",
          "课程灵感",
          "course: /learning/courses/cs61a/course.md\ningested_via: direct-entry",
          "之后整理进课程。",
        ),
      ],
      [
        "inbox/captures/project-idea.md",
        note(
          "Capture",
          "项目灵感",
          "project: /projects/okf/project.md\ningested_via: direct-entry",
          "之后整理进项目。",
        ),
      ],
      [
        "sources/records/project-source.md",
        note(
          "Source",
          "项目资料",
          "purpose: source\nproject: /projects/okf/project.md\ningested_via: file-import",
          "已经归入项目的资料。",
        ),
      ],
      [
        "sources/records/course-source.md",
        note(
          "Source",
          "课程资料",
          "purpose: reference\ncourse: /learning/courses/cs61a/course.md\ningested_via: file-import",
          "已经归入课程的参考资料。",
        ),
      ],
      [
        "projects/okf/decisions/keep-dashboard-local.md",
        note(
          "Decision",
          "Dashboard 保持本地读取",
          "project: /projects/okf/project.md",
          "这个决定不能被重复计入关联资料。",
        ),
      ],
      [
        "learning/guides/recursion.md",
        note(
          "Study Guide",
          "递归学习材料",
          "course: /learning/courses/cs61a/course.md\nproject: /projects/okf/project.md",
          '<!-- ai:auto:start name="study-material" -->\n辅助学习内容。\n<!-- ai:auto:end name="study-material" -->',
        ),
      ],
      [
        "sources/records/documents/pending.md",
        note(
          "Source",
          "待归类论文",
          "purpose: undecided\ningested_via: file-import\nkind: pdf",
          "完整正文已保存。",
        ),
      ],
      [
        "sources/records/web/to-study.md",
        note(
          "Source",
          "稍后学习网页",
          "purpose: study\ningested_via: web-clip\nkind: web",
          "等待生成学习材料。",
        ),
      ],
      [
        "sources/records/feed/to-wiki.md",
        note(
          "Source",
          "等待 Wiki",
          "purpose: wiki\ningested_via: feed\nkind: ai-daily",
          "等待生成 Wiki。",
        ),
      ],
    ]);
    const files = [...markdown.keys()]
      .map((path) => new (TFile as unknown as new (path: string) => TFile)(path));
    const vault = {
      getMarkdownFiles: () => files.filter((file) => file.name.endsWith(".md")),
      getFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: TFile) => markdown.get(file.path) ?? "",
    };
    const reader = new VaultDashboardReader({ vault } as unknown as App);

    const today = await reader.today();
    expect(today.open_inbox_count).toBe(3);
    expect(today.pending_study_count).toBe(1);
    expect(today.pending_wiki_count).toBe(1);
    expect(today.recent_study[0]?.title).toBe("递归学习材料");
    expect(today.tasks).toEqual([
      expect.objectContaining({ path: "learning/courses/cs61a/lessons/01.md", text: "复习递归" }),
      expect.objectContaining({ path: "projects/okf/project.md", text: "发布工作台" }),
    ]);
    expect(today.active_courses[0]).toEqual(
      expect.objectContaining({
        current_progress: "完成递归，下一步学习树。",
        guide_count: 1,
        lesson_count: 1,
        related_sources: [
          expect.objectContaining({ path: "sources/records/course-source.md", note_type: "Source" }),
        ],
        pending_captures: [expect.objectContaining({ path: "inbox/captures/course-idea.md" })],
      }),
    );
    expect(today.active_projects[0]).toEqual(
      expect.objectContaining({
        current_state: "Dashboard local first。",
        next_action: "完成生产部署。",
        pending_captures: [expect.objectContaining({ path: "inbox/captures/project-idea.md" })],
        decisions: ["projects/okf/decisions/keep-dashboard-local.md"],
        related_learning: [
          expect.objectContaining({ path: "learning/guides/recursion.md" }),
        ],
        related_materials: [
          expect.objectContaining({ path: "sources/records/project-source.md" }),
        ],
        open_tasks: [
          expect.objectContaining({ path: "projects/okf/project.md", text: "发布工作台" }),
        ],
      }),
    );

    const projects = await reader.projects();
    expect(projects.projects[0]?.recent_log).toContain("完成直接读取 Vault");

    const learning = await reader.learning();
    expect(learning.courses[0]).toEqual(expect.objectContaining({
      title: "CS61A",
      guide_count: 1,
      related_sources: [
        expect.objectContaining({ path: "sources/records/course-source.md", note_type: "Source" }),
      ],
    }));
    expect(learning.projects[0]).toEqual(expect.objectContaining({
      title: "个人知识工作区",
      related_learning: [
        expect.objectContaining({
          path: "learning/guides/recursion.md",
          course: "/learning/courses/cs61a/course.md",
          project: "/projects/okf/project.md",
        }),
      ],
    }));
    expect(learning.ready_guides[0]).toEqual(expect.objectContaining({
      course: "/learning/courses/cs61a/course.md",
      project: "/projects/okf/project.md",
    }));
    expect(learning.pending_guides).toEqual([
      expect.objectContaining({ title: "稍后学习网页", ingested_via: "web-clip" }),
    ]);
    expect(learning.scope_entry_counts).toEqual({
      all: 2,
      course: 1,
      project: 1,
      independent: 1,
    });

    const inbox = await reader.inbox();
    expect(inbox.captures[0]).toEqual(expect.objectContaining({
      ingested_via: "web-clip",
      resource: "https://example.com/article",
      kind: "web",
    }));
    expect(inbox.pending_imports).toEqual([
      expect.objectContaining({
        title: "待归类论文",
        purpose: "undecided",
        ingested_via: "file-import",
      }),
    ]);
    expect(inbox).not.toHaveProperty("pending_generation");
    expect((await reader.knowledge()).pending_wiki).toEqual([
      expect.objectContaining({ title: "等待 Wiki", ingested_via: "feed" }),
    ]);
  });

  it("projects every Source use into its own Learning or Knowledge context", async () => {
    const markdown = new Map<string, string>([[
      "sources/records/web/shared.md",
      note(
        "Source",
        "共享来源",
        [
          "uses:",
          "  - purpose: study",
          "    course: /learning/courses/course-a/course.md",
          "  - purpose: study",
          "    project: /projects/project-b/project.md",
          "  - purpose: wiki",
          "    project: /projects/project-b/project.md",
          "  - purpose: reference",
        ].join("\n"),
        "一个来源服务多个明确用途。",
      ),
    ]]);
    const files = [...markdown.keys()]
      .map((path) => new (TFile as unknown as new (path: string) => TFile)(path));
    const vault = {
      getMarkdownFiles: () => files,
      getFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: TFile) => markdown.get(file.path) ?? "",
    };
    const reader = new VaultDashboardReader({ vault } as unknown as App);

    expect((await reader.learning()).pending_guides).toEqual([
      expect.objectContaining({
        purpose: "study",
        course: "/learning/courses/course-a/course.md",
        project: null,
      }),
      expect.objectContaining({
        purpose: "study",
        course: null,
        project: "/projects/project-b/project.md",
      }),
    ]);
    expect((await reader.learning()).scope_entry_counts).toEqual({
      all: 2,
      course: 1,
      project: 1,
      independent: 0,
    });
    expect((await reader.knowledge()).pending_wiki).toEqual([
      expect.objectContaining({
        purpose: "wiki",
        project: "/projects/project-b/project.md",
      }),
    ]);
    expect((await reader.inbox()).pending_imports).toEqual([]);
    expect(await reader.today()).toEqual(expect.objectContaining({
      pending_study_count: 2,
      pending_wiki_count: 1,
    }));
  });

  it("keeps Course and Project statistics type-safe and applies explicit Course links first", async () => {
    const markdown = new Map<string, string>([
      ["learning/courses/a/course.md", note("Course", "Course A", "course_status: active", "")],
      ["learning/courses/b/course.md", note("Course", "Course B", "course_status: active", "")],
      [
        "learning/courses/a/guides/moved.md",
        note(
          "Study Guide",
          "Moved Guide",
          "course: /learning/courses/b/course.md\nproject: /projects/p/project.md",
          "",
        ),
      ],
      [
        "learning/courses/a/lessons/moved.md",
        note("Lesson", "Moved Lesson", "course: /learning/courses/b/course.md", ""),
      ],
      ["projects/p/project.md", note("Project", "Project P", "project_status: active", "")],
      [
        "sources/records/shared.md",
        note(
          "Source",
          "Shared Source",
          [
            "uses:",
            "  - purpose: reference",
            "    course: /learning/courses/a/course.md",
            "  - purpose: study",
            "    course: /learning/courses/a/course.md",
            "  - purpose: reference",
            "    project: /projects/p/project.md",
          ].join("\n"),
          "",
        ),
      ],
      [
        "projects/p/decisions/not-learning.md",
        note("Decision", "Not Learning", "project: /projects/p/project.md", ""),
      ],
    ]);
    const files = [...markdown.keys()]
      .map((path) => new (TFile as unknown as new (path: string) => TFile)(path));
    const vault = {
      getMarkdownFiles: () => files,
      getFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: TFile) => markdown.get(file.path) ?? "",
    };

    const learning = await new VaultDashboardReader({ vault } as unknown as App).learning();
    const courseA = learning.courses.find((course) => course.title === "Course A");
    const courseB = learning.courses.find((course) => course.title === "Course B");
    const project = learning.projects[0];

    expect(courseA).toEqual(expect.objectContaining({
      guide_count: 0,
      lesson_count: 0,
      related_sources: [
        expect.objectContaining({ path: "sources/records/shared.md", note_type: "Source" }),
      ],
    }));
    expect(courseB).toEqual(expect.objectContaining({
      guide_count: 1,
      lesson_count: 1,
      latest_lesson: expect.objectContaining({ path: "learning/courses/a/lessons/moved.md" }),
      related_sources: [],
    }));
    expect(project?.related_learning).toEqual([
      expect.objectContaining({ path: "learning/courses/a/guides/moved.md", note_type: "Study Guide" }),
    ]);
    expect(project?.related_materials).toEqual([
      expect.objectContaining({ path: "sources/records/shared.md", note_type: "Source" }),
    ]);
  });

  it("keeps Today recent study ready-only and deterministically newest-first", async () => {
    const readyBody =
      '<!-- ai:auto:start name="study-material" -->\n学习材料已完成。\n<!-- ai:auto:end name="study-material" -->';
    const markdown = new Map<string, string>([
      ["learning/guides/ready-old.md", note("Study Guide", "较早材料", "", readyBody)],
      ["learning/guides/ready-new.md", note("Study Guide", "最新材料", "", readyBody)],
      [
        "learning/guides/pending-newest.md",
        note("Study Guide", "等待生成", "", "等待生成辅助学习材料。"),
      ],
      [
        "learning/guides/deprecated.md",
        note("Study Guide", "已停用材料", "status: deprecated", readyBody),
      ],
    ]);
    const modified: Record<string, number> = {
      "learning/guides/ready-old.md": Date.parse("2026-08-18T00:00:00Z"),
      "learning/guides/ready-new.md": Date.parse("2026-08-20T00:00:00Z"),
      "learning/guides/pending-newest.md": Date.parse("2026-08-21T00:00:00Z"),
      "learning/guides/deprecated.md": Date.parse("2026-08-22T00:00:00Z"),
    };
    const files = [...markdown.keys()].map((path) => Object.assign(
      new (TFile as unknown as new (path: string) => TFile)(path),
      { stat: { mtime: modified[path], size: markdown.get(path)?.length ?? 0 } },
    ));
    const vault = {
      getMarkdownFiles: () => files,
      getFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: TFile) => markdown.get(file.path) ?? "",
    };
    const reader = new VaultDashboardReader({ vault } as unknown as App);

    expect((await reader.today()).recent_study.map((item) => item.title)).toEqual([
      "最新材料",
      "较早材料",
    ]);
  });

  it("orders recent lessons by their real modification time", async () => {
    const markdown = new Map<string, string>([
      [
        "learning/courses/test/course.md",
        note("Course", "测试课程", "course_status: active", "## 当前进度\n正在学习。"),
      ],
      ["learning/courses/test/lessons/01.md", note("Lesson", "第一课", "", "旧课堂记录")],
      ["learning/courses/test/lessons/02.md", note("Lesson", "第二课", "", "新课堂记录")],
    ]);
    const files = [...markdown.keys()].map((path) => Object.assign(
      new (TFile as unknown as new (path: string) => TFile)(path),
      {
        stat: {
          mtime: path.endsWith("02.md")
            ? Date.parse("2026-08-20T00:00:00Z")
            : Date.parse("2026-08-18T00:00:00Z"),
          size: markdown.get(path)?.length ?? 0,
        },
      },
    ));
    const vault = {
      getMarkdownFiles: () => files,
      getFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: TFile) => markdown.get(file.path) ?? "",
    };

    const learning = await new VaultDashboardReader({ vault } as unknown as App).learning();

    expect(learning.courses[0]?.latest_lesson?.title).toBe("第二课");
  });

  it("keeps inactive Course and Project contexts in Learning while Today remains active-only", async () => {
    const markdown = new Map<string, string>([
      ["learning/courses/active/course.md", note("Course", "Active", "course_status: active", "")],
      ["learning/courses/paused/course.md", note("Course", "Paused", "course_status: paused", "")],
      ["learning/courses/done/course.md", note("Course", "Done", "course_status: completed", "")],
      ["projects/active/project.md", note("Project", "Active Project", "project_status: active", "")],
      ["projects/paused/project.md", note("Project", "Paused Project", "project_status: paused", "")],
      ["projects/done/project.md", note("Project", "Done Project", "project_status: completed", "")],
    ]);
    const files = [...markdown.keys()].map((path) =>
      new (TFile as unknown as new (path: string) => TFile)(path));
    const vault = {
      getMarkdownFiles: () => files,
      getFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      cachedRead: async (file: TFile) => markdown.get(file.path) ?? "",
    };
    const reader = new VaultDashboardReader({ vault } as unknown as App);

    const learning = await reader.learning();
    expect(learning.courses.map((item) => item.title)).toEqual([
      "Active",
      "Paused",
      "Done",
    ]);
    expect(learning.projects.map((item) => item.title)).toEqual([
      "Active Project",
      "Paused Project",
      "Done Project",
    ]);
    const today = await reader.today();
    expect(today.active_courses.map((item) => item.title)).toEqual(["Active"]);
    expect(today.active_projects.map((item) => item.title)).toEqual(["Active Project"]);
  });
});

function note(type: string, title: string, extra: string, body: string): string {
  return `---\ntype: ${type}\ntitle: ${title}\ncreated_at: 2026-08-17T00:00:00+08:00\n${extra}\n---\n\n# ${title}\n\n${body}\n`;
}

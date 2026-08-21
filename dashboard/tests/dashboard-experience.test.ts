import { describe, expect, it } from "vitest";

import type {
  ConversionRecord,
  NoteSummary,
  SemanticOperationRecord,
  TaskItem,
} from "../src/api/types.js";
import {
  buildDashboardOwnedSections,
  canCompleteDashboardStudy,
  classifyDashboardPage,
  countDashboardLearningScope,
  countTodayAttention,
  dashboardLearningContexts,
  dashboardLearningRowAction,
  dashboardLearningScopeCounts,
  filterDashboardLearningNotes,
  filterDashboardLearningScope,
  selectDashboardContinueItems,
  selectTodayAttention,
} from "../src/domain/dashboard-experience.js";
import type { InboxProjectionData } from "../src/domain/inbox-work-queue.js";

describe("Dashboard experience selectors", () => {
  it("counts Today attention from decisions, generation, background work, and tasks", () => {
    const inbox: InboxProjectionData = {
      captures: [note("inbox/captures/idea.md", "Capture", { capture_status: "open" })],
      processed_captures: [],
      pending_imports: [note("sources/records/paper.md", "Source", { purpose: "undecided" })],
    };
    const operations = [
      operation("queued", "op-queued"),
      operation("running", "op-running"),
      operation("orphaned", "op-orphaned"),
      operation("failed", "op-failed"),
      operation("completed", "op-completed"),
    ];
    const conversions = [
      conversion("converting", "conv-running"),
      conversion("failed", "conv-failed"),
      conversion("imported", "conv-completed"),
    ];
    const tasks: TaskItem[] = [
      { path: "life/daily/one.md", line: 3, text: "任务一" },
      { path: "projects/one/project.md", line: 8, text: "任务二" },
    ];

    expect(countTodayAttention({
      inbox,
      pendingStudyCount: 2,
      pendingWikiCount: 1,
      tasks,
      operations,
      conversions,
    })).toEqual({
      inbox_decisions: 2,
      pending_study: 2,
      pending_wiki: 1,
      background_running: 3,
      background_failed: 3,
      today_tasks: 2,
    });
    expect(selectTodayAttention({
      inbox,
      pendingStudyCount: 2,
      pendingWikiCount: 1,
      tasks,
      operations,
      conversions,
    }).map((item) => item.kind))
      .toEqual([
        "inbox-decisions",
        "pending-study",
        "pending-wiki",
        "background-running",
        "background-failed",
        "today-tasks",
      ]);
  });

  it("omits zero-count attention entries", () => {
    const inbox: InboxProjectionData = {
      captures: [],
      processed_captures: [],
      pending_imports: [],
    };

    expect(selectTodayAttention({ inbox, tasks: [] })).toEqual([]);
  });

  it("selects at most three actionable continuation items with recent paths first", () => {
    const notes = [
      note("learning/guides/old.md", "Study Guide", {
        material_ready: true,
        modified_at: "2026-08-18T00:00:00Z",
      }),
      note("learning/guides/new.md", "Study Guide", {
        material_ready: true,
        modified_at: "2026-08-21T00:00:00Z",
      }),
      note("projects/active/project.md", "Project", {
        project_status: "active",
        modified_at: "2026-08-20T00:00:00Z",
      }),
      note("learning/courses/active/course.md", "Course", {
        course_status: "active",
        modified_at: "2026-08-19T00:00:00Z",
      }),
      note("learning/guides/pending.md", "Study Guide", {
        material_ready: false,
        modified_at: "2026-08-22T00:00:00Z",
      }),
      note("learning/guides/completed.md", "Study Guide", {
        material_ready: true,
        studied_at: "2026-08-21T01:00:00Z",
      }),
      note("projects/paused/project.md", "Project", { project_status: "paused" }),
      note("learning/courses/closed/course.md", "Course", { course_status: "completed" }),
    ];

    const selected = selectDashboardContinueItems(notes, {
      recentOpenedPaths: ["/learning/guides/old.md"],
      limit: 20,
    });

    expect(selected).toHaveLength(3);
    expect(selected.map((item) => [item.kind, item.note.path])).toEqual([
      ["study-guide", "learning/guides/old.md"],
      ["study-guide", "learning/guides/new.md"],
      ["project", "projects/active/project.md"],
    ]);
  });

  it("uses deterministic kind and path tie-breakers for continuation items", () => {
    const timestamp = "2026-08-21T00:00:00Z";
    const notes = [
      note("learning/courses/z/course.md", "Course", {
        course_status: "active",
        modified_at: timestamp,
      }),
      note("projects/z/project.md", "Project", {
        project_status: "active",
        modified_at: timestamp,
      }),
      note("learning/guides/z.md", "Study Guide", {
        material_ready: true,
        modified_at: timestamp,
      }),
      note("learning/guides/a.md", "Study Guide", {
        material_ready: true,
        modified_at: timestamp,
      }),
    ];

    expect(selectDashboardContinueItems(notes).map((item) => item.note.path)).toEqual([
      "learning/guides/a.md",
      "learning/guides/z.md",
      "projects/z/project.md",
    ]);
  });

  it("promotes a Project or Course when one of its child notes was opened", () => {
    const notes = [
      note("learning/guides/newest.md", "Study Guide", {
        material_ready: true,
        modified_at: "2026-08-21T00:00:00Z",
      }),
      note("projects/active/project.md", "Project", {
        project_status: "active",
        modified_at: "2026-08-18T00:00:00Z",
      }),
      note("learning/courses/active/course.md", "Course", {
        course_status: "active",
        modified_at: "2026-08-17T00:00:00Z",
      }),
    ];

    expect(selectDashboardContinueItems(notes, {
      recentOpenedPaths: [
        "projects/active/log.md",
        "learning/courses/active/lessons/01.md",
      ],
    }).map((item) => item.note.path)).toEqual([
      "projects/active/project.md",
      "learning/courses/active/course.md",
      "learning/guides/newest.md",
    ]);
  });

  it("assigns notes to one workflow page and omits empty sections", () => {
    const notes = [
      note("inbox/captures/open.md", "Capture", { capture_status: "open" }),
      note("inbox/captures/processed.md", "Capture", { capture_status: "processed" }),
      note("sources/records/undecided.md", "Source", { purpose: "undecided" }),
      note("sources/records/study.md", "Source", { purpose: "study" }),
      note("sources/records/wiki.md", "Source", { purpose: "wiki" }),
      note("learning/guides/pending.md", "Study Guide", { material_ready: false }),
      note("learning/guides/ready.md", "Study Guide", { material_ready: true }),
      note("learning/guides/done.md", "Study Guide", {
        material_ready: true,
        studied_at: "2026-08-20T00:00:00Z",
      }),
      note("knowledge/wiki/topic.md", "Wiki"),
      note("knowledge/maps/area.md", "Wiki Map"),
      note("projects/one/project.md", "Project", { project_status: "active" }),
    ];

    expect(classifyDashboardPage(notes[0]!)).toEqual({ page: "inbox", section: "decision" });
    expect(classifyDashboardPage(notes[1]!)).toBeUndefined();
    expect(classifyDashboardPage(notes[4]!)).toEqual({ page: "knowledge", section: "pending" });
    expect(classifyDashboardPage(notes[10]!)).toBeUndefined();

    const sections = buildDashboardOwnedSections(notes);
    expect(sections.map((section) => [section.page, section.section, section.notes.length]))
      .toEqual([
        ["inbox", "decision", 2],
        ["learning", "pending", 2],
        ["learning", "ready", 1],
        ["learning", "completed", 1],
        ["knowledge", "pending", 1],
        ["knowledge", "wiki", 2],
      ]);
    expect(buildDashboardOwnedSections([notes[8]!, notes[9]!]).map((section) => section.section))
      .toEqual(["wiki"]);
  });

  it("keeps deferred study Sources actionable and blocks premature completion", () => {
    const source = note("sources/records/deferred.md", "Source", { purpose: "study" });
    const pendingGuide = note("learning/guides/pending.md", "Study Guide", {
      material_ready: false,
    });
    const readyGuide = note("learning/guides/ready.md", "Study Guide", {
      material_ready: true,
    });

    expect(dashboardLearningRowAction(source)).toBe("pending-source");
    expect(dashboardLearningRowAction(pendingGuide)).toBe("study-guide");
    expect(canCompleteDashboardStudy(pendingGuide)).toBe(false);
    expect(canCompleteDashboardStudy(readyGuide)).toBe(true);
    expect(canCompleteDashboardStudy(readyGuide, { status: "running" })).toBe(false);
    expect(canCompleteDashboardStudy(readyGuide, { status: "orphaned" })).toBe(true);
  });

  it("classifies Learning contexts from explicit links with a Course path fallback", () => {
    const course = note("learning/guides/course.md", "Study Guide", {
      course: "/learning/courses/cs61a/course.md",
    });
    const legacyCourse = note("learning/courses/cs61a/guides/legacy.md", "Study Guide");
    const project = note("learning/guides/project.md", "Study Guide", {
      project: "/projects/workspace/project.md",
    });
    const both = note("learning/guides/both.md", "Study Guide", {
      course: "/learning/courses/cs61a/course.md",
      project: "/projects/workspace/project.md",
    });
    const independent = note("learning/guides/independent.md", "Study Guide");
    const notes = [course, legacyCourse, project, both, independent];

    expect(dashboardLearningContexts(course)).toEqual(["course"]);
    expect(dashboardLearningContexts(legacyCourse)).toEqual(["course"]);
    expect(dashboardLearningContexts(both)).toEqual(["course", "project"]);
    expect(dashboardLearningContexts(independent)).toEqual(["independent"]);
    expect(filterDashboardLearningNotes(notes, "course")).toEqual([course, legacyCourse, both]);
    expect(filterDashboardLearningNotes(notes, "project")).toEqual([project, both]);
    expect(filterDashboardLearningNotes(notes, "independent")).toEqual([independent]);
    expect(filterDashboardLearningNotes(notes, "all")).toEqual(notes);
  });

  it("filters a concrete Course with explicit relations taking priority over folder fallback", () => {
    const explicit = note("learning/guides/explicit.md", "Study Guide", {
      course: "/learning/courses/cs61a/course.md",
    });
    const legacy = note("learning/courses/cs61a/guides/legacy.md", "Study Guide");
    const explicitWins = note(
      "learning/courses/cs61a/guides/moved-to-math.md",
      "Study Guide",
      { course: "/learning/courses/math/course.md" },
    );
    const other = note("learning/courses/math/guides/other.md", "Study Guide");
    const notes = [explicit, legacy, explicitWins, other];

    expect(filterDashboardLearningScope(
      notes,
      "course",
      "/LEARNING\\courses\\CS61A\\course.md/",
    )).toEqual([explicit, legacy]);
    expect(filterDashboardLearningScope(
      notes,
      "course",
      "learning/courses/math/course.md",
    )).toEqual([explicitWins, other]);
  });

  it("filters concrete Projects only through explicit relations", () => {
    const explicit = note("learning/guides/explicit.md", "Study Guide", {
      project: "/projects/workspace/project.md",
    });
    const folderOnly = note("projects/workspace/learning/folder-only.md", "Study Guide");
    const other = note("learning/guides/other.md", "Study Guide", {
      project: "/projects/other/project.md",
    });

    expect(filterDashboardLearningScope(
      [explicit, folderOnly, other],
      "project",
      "projects/workspace/project.md",
    )).toEqual([explicit]);
    expect(dashboardLearningContexts(folderOnly)).toEqual(["independent"]);
  });

  it("counts all notes once while allowing a dual-linked note in both relation scopes", () => {
    const course = note("learning/guides/course.md", "Study Guide", {
      course: "/learning/courses/cs61a/course.md",
    });
    const project = note("learning/guides/project.md", "Study Guide", {
      project: "/projects/workspace/project.md",
    });
    const both = note("learning/guides/both.md", "Study Guide", {
      course: "/learning/courses/cs61a/course.md",
      project: "/projects/workspace/project.md",
    });
    const independent = note("learning/guides/independent.md", "Study Guide");
    const notes = [course, project, both, independent, both];

    expect(dashboardLearningScopeCounts(notes)).toEqual({
      all: 4,
      course: 2,
      project: 2,
      independent: 1,
    });
    expect(countDashboardLearningScope(
      notes,
      "course",
      "learning/courses/cs61a/course.md",
    )).toBe(2);
    expect(countDashboardLearningScope(
      notes,
      "project",
      "/projects/workspace/project.md",
    )).toBe(2);
    expect(filterDashboardLearningScope(notes, "all")).toEqual([
      course,
      project,
      both,
      independent,
    ]);
  });

  it("keeps distinct uses of one Source available in their own Learning scopes", () => {
    const courseUse = note("sources/records/shared.md", "Source", {
      purpose: "study",
      course: "/learning/courses/course-a/course.md",
    });
    const projectUse = note("sources/records/shared.md", "Source", {
      purpose: "study",
      project: "/projects/project-b/project.md",
    });

    expect(filterDashboardLearningScope([courseUse, projectUse], "all"))
      .toEqual([courseUse, projectUse]);
    expect(filterDashboardLearningScope([courseUse, projectUse], "course"))
      .toEqual([courseUse]);
    expect(filterDashboardLearningScope([courseUse, projectUse], "project"))
      .toEqual([projectUse]);
  });
});

function note(
  path: string,
  noteType: string,
  fields: Partial<NoteSummary> = {},
): NoteSummary {
  return {
    path,
    title: path.split("/").at(-1) ?? path,
    note_type: noteType,
    status: "stable",
    stale: false,
    excerpt: "",
    ...fields,
  };
}

function operation(
  status: SemanticOperationRecord["status"],
  operationId: string,
): SemanticOperationRecord {
  return {
    operation_id: operationId,
    kind: "generate-study-guide",
    status,
    target: `learning/guides/${operationId}.md`,
    sources: [],
    actual_reads: [],
    updated_at: "2026-08-21T00:00:00Z",
  };
}

function conversion(
  status: ConversionRecord["status"],
  conversionId: string,
): ConversionRecord {
  return {
    conversion_id: conversionId,
    status,
    source_filename: `${conversionId}.pdf`,
    intent: "learn",
    quality: "high",
    parser: "mineru",
    outputs: {},
  };
}

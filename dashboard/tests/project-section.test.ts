import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";

import type { ProjectSummary } from "../src/api/types.js";
import {
  filterProjects,
  normalizeProjectSectionConfig,
  projectFormalTasks,
  projectLifecycleStatus,
} from "../src/features/projects/project-section.js";
import { scanFileTasks } from "../apex/src/alltasks-scan.js";

function project(title: string, status: string | null): ProjectSummary {
  return {
    path: `projects/${title}/project.md`,
    title,
    note_type: "Project",
    status: "",
    project_status: status,
    stale: false,
    excerpt: "",
    current_state: "",
    next_action: "",
    recent_log: "",
    log_path: `projects/${title}/log.md`,
    decisions: [],
    outputs: [],
    related_learning: [],
    related_materials: [],
    pending_captures: [],
    open_tasks: [],
  };
}

describe("OKF Project section", () => {
  it("defaults to active and ignores unsupported persisted filter values", () => {
    expect(normalizeProjectSectionConfig(undefined)).toEqual({ statuses: ["active"] });
    expect(normalizeProjectSectionConfig({ statuses: ["paused", "future", "paused"] })).toEqual({
      statuses: ["paused"],
    });
    expect(normalizeProjectSectionConfig({ statuses: [] })).toEqual({ statuses: ["active"] });
  });

  it("uses active as the compatibility status and filters each section independently", () => {
    const projects = [project("one", null), project("two", "paused"), project("three", "completed")];

    expect(projectLifecycleStatus(projects[0]!)).toBe("active");
    expect(filterProjects(projects, { statuses: ["active"] }).map(({ title }) => title)).toEqual(["one"]);
    expect(filterProjects(projects, { statuses: ["paused", "completed"] }).map(({ title }) => title)).toEqual([
      "two",
      "three",
    ]);
  });

  it("projects only open formal tasks from the project's own directory", () => {
    const projectSummary = project("one", "active");
    const taskFile = Object.assign(
      new (TFile as unknown as new (path: string) => TFile)("projects/one/project.md"),
      { stat: { mtime: 1, ctime: 1, size: 0 } },
    );
    const otherFile = Object.assign(
      new (TFile as unknown as new (path: string) => TFile)("projects/two/project.md"),
      { stat: { mtime: 1, ctime: 1, size: 0 } },
    );
    const tasks = [
      ...scanFileTasks(taskFile, "- [ ] #task Keep ^task-keep\n- [ ] ordinary"),
      ...scanFileTasks(otherFile, "- [ ] #task Other ^task-other"),
    ];

    expect(projectFormalTasks(projectSummary, tasks).map((task) => task.text)).toEqual(["Keep"]);
  });
});

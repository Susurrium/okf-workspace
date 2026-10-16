import { TFile, WorkspaceLeaf, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { scanFileTasks, type VaultTask } from "../apex/src/alltasks-scan.js";
import type { ProjectSummary } from "../src/api/types.js";
import { normalizeDashboardUiState } from "../src/plugin/dashboard-ui-state.js";
import { OkfDashboardView } from "../src/plugin/dashboard-view.js";
import { TestElement } from "./obsidian-runtime.js";

function project(name: string, status: ProjectSummary["project_status"]): ProjectSummary {
  return {
    path: `projects/${name}/project.md`, title: name, note_type: "Project", status: "",
    project_status: status, stale: false, excerpt: "", current_state: "", next_action: "",
    recent_log: "", log_path: `projects/${name}/log.md`, decisions: [], outputs: [],
    related_learning: [], related_materials: [], pending_captures: [], open_tasks: [],
  };
}

function surface(projects: ProjectSummary[], tasks: VaultTask[] = []) {
  const files = [...new Map(tasks.map(task => [task.path, task.file])).values()];
  const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)({
    vault: { getAbstractFileByPath: (path: string) => files.find(file => file.path === path) },
    metadataCache: { getFileCache: () => ({}) },
  } as unknown as App);
  const view = new OkfDashboardView(leaf, {
    getDashboardUiState: () => normalizeDashboardUiState(undefined),
    updateDashboardPageUiState: vi.fn(),
  } as never);
  const runtime = view as unknown as {
    vaultReader: { projects: () => Promise<{ projects: ProjectSummary[] }> };
    projectsTab: "active" | "paused" | "completed";
    collectFormalTasks: () => Promise<VaultTask[]>;
    attachActionPanel: () => void;
    renderProjects: (container: HTMLElement) => Promise<void>;
  };
  runtime.vaultReader = { projects: async () => ({ projects }) };
  runtime.collectFormalTasks = async () => tasks;
  runtime.attachActionPanel = () => undefined;
  return runtime;
}

describe("shared Project surface", () => {
  it.each([
    ["active", ["legacy", "active"]],
    ["paused", ["paused"]],
    ["completed", ["completed"]],
  ] as const)("shows only %s projects, retaining the missing-status compatibility", async (tab, titles) => {
    const runtime = surface([
      project("legacy", null), project("active", "active"),
      project("paused", "paused"), project("completed", "completed"),
    ]);
    runtime.projectsTab = tab;
    const container = new TestElement();

    await runtime.renderProjects(container as unknown as HTMLElement);

    expect(container.descendants("okf-project-row").map((row) =>
      row.descendants("okf-dashboard__row-title")[0]?.textContent,
    )).toEqual(titles);
  });

  it("renders only open formal tasks from the project's own directory", async () => {
    const file = (path: string) => Object.assign(
      new (TFile as unknown as new (path: string) => TFile)(path),
      { stat: { mtime: 1, ctime: 1, size: 0 } },
    );
    const tasks = [
      ...scanFileTasks(file("projects/demo/project.md"), [
        "- [ ] #task Keep ^task-keep", "- [x] #task Done ^task-done", "- [ ] ordinary",
      ].join("\n")),
      ...scanFileTasks(file("projects/demo/log.md"), "- [ ] #task Log task ^task-log"),
      ...scanFileTasks(file("projects/demo-other/project.md"), "- [ ] #task Other ^task-other"),
    ];
    const runtime = surface([project("demo", "active")], tasks);
    const container = new TestElement();

    await runtime.renderProjects(container as unknown as HTMLElement);

    expect(container.descendants("okf-formal-task-row__title").map((row) => row.textContent))
      .toEqual(["Keep", "Log task"]);
  });
});

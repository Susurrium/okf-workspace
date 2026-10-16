import { TFile, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../src/api/types.js";
import { orderedProjects, projectCategory, projectGroups, readProjectOrganization, projectOrganizationFilters } from "../src/domain/project-organization.js";
import { VaultNoteService } from "../src/plugin/vault-note-service.js";
import { ArtifactEditPolicy } from "../src/application/artifact-edit-policy.js";
import { renderProjectCatalog } from "../src/features/projects/project-catalog.js";
import { TestElement } from "./obsidian-runtime.js";

const project = (name: string, category: string | null, status = "active"): ProjectSummary => ({
  path: `projects/${name}/project.md`, title: name, note_type: "Project", project_category: category,
  project_status: status, status: "stable", stale: false, excerpt: "", current_state: "", next_action: "",
  recent_log: "", log_path: `projects/${name}/log.md`, decisions: [], outputs: [],
  related_learning: [], related_materials: [], pending_captures: [], open_tasks: [],
});

describe("Project category authority and organization", () => {
  it("groups each project once and treats absent categories independently of lifecycle", () => {
    const values = [project("a", null), project("b", "科研"), project("c", "科研", "completed")];
    const prefs = readProjectOrganization({ projectGroup: "category" });
    expect(projectGroups(values, prefs).map(group => [group.label, group.projects.length])).toEqual([["科研", 2], ["未分类", 1]]);
    const grouped = projectGroups(values, { ...prefs, group: "status" });
    expect(grouped.map(group => group.projects.length)).toEqual([2, 0, 1]);
    expect(values.map(value => value.project_category)).toEqual([null, "科研", "科研"]);
  });

  it("round-trips view preferences while preserving unknown pinned identities", () => {
    const prefs = readProjectOrganization({ projectPinned: JSON.stringify(["projects/c/project.md"]), projectOrder: JSON.stringify(["projects/b/project.md", "projects/a/project.md"]), projectSort: "manual" });
    const values = [project("a", null), project("b", null), project("c", null)];
    expect(orderedProjects(values, prefs).map(project => project.title)).toEqual(["c", "b", "a"]);
    expect(readProjectOrganization(projectOrganizationFilters(prefs))).toEqual(prefs);
    expect(() => readProjectOrganization({ projectPinned: '["../other.md"]' })).toThrow();
    expect(projectCategory("  科研 ")).toBe("科研");
    expect(() => projectCategory(["科研"])).toThrow();
    expect(readProjectOrganization({ projectPinned: '["projects/UpperCase/project.md"]' }).pinned).toEqual(["projects/UpperCase/project.md"]);
  });

  it("performs guarded local edits and reports independent batch failures without overwriting changes", async () => {
    const metadata = new Map(["a", "b", "c"].map(name => [`projects/${name}/project.md`, { type: "Project", project_category: "科研", project_status: "paused", future: { keep: true } } as Record<string, unknown>]));
    const files = [...metadata.keys()].map(path => new (TFile as unknown as new (path: string) => TFile)(path));
    const service = new VaultNoteService({ vault: { getAbstractFileByPath: (path: string) => files.find(file => file.path === path) },
      fileManager: { processFrontMatter: async (file: TFile, edit: (fields: Record<string, unknown>) => void) => {
        if (file.path.includes("/b/")) throw new Error("模拟只读文件");
        edit(metadata.get(file.path)!);
      } } } as unknown as App);
    metadata.get(files[2]!.path)!.project_category = "用户新类别";
    const results = await service.renameProjectCategory(files.map(file => file.path), "科研", "工具");
    expect(results.map(result => Boolean(result.error))).toEqual([false, true, true]);
    expect(metadata.get(files[0]!.path)).toEqual({ type: "Project", project_category: "工具", project_status: "paused", future: { keep: true } });
    expect(metadata.get(files[2]!.path)!.project_category).toBe("用户新类别");
    await service.setProjectCategory(files[0]!.path, null, "工具");
    expect(metadata.get(files[0]!.path)).not.toHaveProperty("project_category");
    await expect(service.setProjectCategory("projects/../other.md", "科研")).rejects.toThrow();
    await expect(service.setProjectCategory("projects/../project.md", "科研")).rejects.toThrow();
  });

  it("routes category table writes through the existing managed boundary", async () => {
    const setProjectCategory = vi.fn();
    const policy = new ArtifactEditPolicy({ setProjectCategory, setProjectStatus: vi.fn() });
    await policy.mutate({ kind: "frontmatter", artifactType: "Project", path: "projects/a/project.md", property: "project_category", value: " 科研 " });
    expect(setProjectCategory).toHaveBeenCalledWith("projects/a/project.md", "科研");
    await expect(policy.mutate({ kind: "frontmatter", artifactType: "Project", path: "projects/a/project.md", property: "project_category", value: [] })).rejects.toThrow();
  });

  it("keeps category filters, counts and pinning in view state without editing projects", () => {
    const root = new TestElement();
    const values = [project("a", "科研"), project("b", null), project("c", "科研", "completed")];
    const remember = vi.fn();
    const moveCategory = vi.fn(), moveStatus = vi.fn();
    renderProjectCatalog(root as unknown as HTMLElement, { projects: values, tab: "all", query: "", organization: readProjectOrganization(),
      remember, renderItems: (parent, items, render) => items.forEach(item => render(parent, item)),
      renderProject: (parent, item) => parent.createDiv({ text: item.title }), editCategory: vi.fn(), moveCategory, moveStatus });
    const filter = root.descendants().find(element => element.attributes.get("aria-label") === "项目类别")!;
    filter.value = JSON.stringify("科研");
    filter.listeners.get("change")![0]!({} as Event);
    expect(root.descendants("okf-project-card").map(card => card.dataset.project)).toEqual(["projects/a/project.md", "projects/c/project.md"]);
    const pin = root.descendants().find(element => element.attributes.get("aria-label") === "a：置顶")!;
    pin.listeners.get("click")![0]!({} as Event);
    expect(remember.mock.lastCall?.[2].pinned).toEqual(["projects/a/project.md"]);
    expect(moveCategory).not.toHaveBeenCalled();
    expect(moveStatus).not.toHaveBeenCalled();
    expect(values.map(value => value.project_category)).toEqual(["科研", null, "科研"]);
  });

  it("distinguishes reordering from category and lifecycle drops", async () => {
    const root = new TestElement();
    const values = [project("a", "科研"), project("b", "科研"), project("c", "工具")];
    const remember = vi.fn(), moveCategory = vi.fn(), moveStatus = vi.fn();
    renderProjectCatalog(root as unknown as HTMLElement, { projects: values, tab: "all", query: "",
      organization: readProjectOrganization({ projectGroup: "category", projectView: "kanban" }),
      remember, renderItems: (parent, items, render) => items.forEach(item => render(parent, item)),
      renderProject: (parent, item) => parent.createDiv({ text: item.title }), editCategory: vi.fn(), moveCategory, moveStatus });
    const payload = new Map<string, string>();
    const event = { dataTransfer: { setData: (key: string, value: string) => payload.set(key, value), getData: (key: string) => payload.get(key) ?? "" },
      preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as DragEvent;
    const handle = root.descendants().find(element => element.attributes.get("aria-label") === "b：拖到其他分组")!;
    handle.dispatch("dragstart", event);
    root.descendants("okf-project-card").find(card => card.dataset.project === values[0]!.path)!.dispatch("drop", event);
    expect(remember.mock.lastCall?.[2].order.slice(0, 2)).toEqual([values[1]!.path, values[0]!.path]);
    expect(moveCategory).not.toHaveBeenCalled();
    root.descendants("okf-project-group").find(column => column.attributes.get("aria-label") === "工具")!.dispatch("drop", event);
    await vi.waitFor(() => expect(moveCategory).toHaveBeenCalledWith(values[1], "工具"));
    expect(moveStatus).not.toHaveBeenCalled();
  });
});

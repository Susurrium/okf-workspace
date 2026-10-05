import { describe, expect, it, vi } from "vitest";
import { migrateWorkspaces, nextWorkspacePath } from "../apex/src/workspace-registry.js";
import { normalizeApexSettings } from "../src/plugin/apex-settings.js";
import { recoverWorkspaceRegistry } from "../src/plugin/workspace-recovery.js";

function vault(files: Record<string, string>) {
  return {
    read: vi.fn(async (path: string) => files[path]!),
    list: vi.fn(async (folder: string) => {
      const prefix = folder ? `${folder}/` : "";
      const children = Object.keys(files).filter((path) => path.startsWith(prefix));
      return {
        files: children.filter((path) => !path.slice(prefix.length).includes("/")),
        folders: [...new Set(children.filter((path) => path.slice(prefix.length).includes("/"))
          .map((path) => prefix + path.slice(prefix.length).split("/")[0]))],
      };
    }),
  };
}
const board = "---\ndashboard: true\nworkbench_schema: 1\n---\n## 随手记\n";

describe("workspace names", () => {
  it("preserves localized names and resolves collisions in the existing folder", () => {
    expect(nextWorkspacePath(["boards/dashboard"], "工作台 2", () => false)).toBe("boards/工作台-2");
    expect(nextWorkspacePath(["boards/dashboard"], "工作台 2",
      (path) => path === "boards/工作台-2")).toBe("boards/工作台-2-2");
    expect(nextWorkspacePath(["dashboard"], "学习", () => false)).toBe("学习");
  });
  it("keeps paths safe and retains the numbered fallback for emoji-only names", () => {
    expect(nextWorkspacePath(["dashboard"], "../a:b/c*?", () => false)).toBe("abc");
    expect(nextWorkspacePath(["dashboard"], "CON", () => false)).toBe("workspace-CON");
    expect(nextWorkspacePath(["dashboard"], "📚", () => false)).toBe("dashboard-2");
  });
  it("uses the surviving registry entry when only the active setting is missing", () => {
    expect(migrateWorkspaces({ workspaceFiles: ["/2.md"], workspaceNames: ["工作台"] }))
      .toEqual({ active: "2", files: ["2"], names: ["工作台"] });
  });
});

describe("workspace registry recovery", () => {
  it("recovers a board from disk without relying on the startup metadata cache", async () => {
    const adapter = vault({ "2.md": board, "notes/test.md": "ordinary note" });
    const result = await recoverWorkspaceRegistry({ language: "zh", futureFlag: true }, adapter);
    const settings = normalizeApexSettings(result.settings);
    expect(result.recovered).toBe(true);
    expect(settings.dashboardFile).toBe("2");
    expect(settings.workspaceFiles).toEqual(["2"]);
    expect(result.settings.futureFlag).toBe(true);
  });
  it("registers all existing boards deterministically and prefers the default if present", async () => {
    const result = await recoverWorkspaceRegistry(undefined, vault({
      "boards/学习.md": board, "dashboard.md": board, "2.md": board,
    }));
    expect(result.settings.workspaceFiles).toEqual(["2", "boards/学习", "dashboard"]);
    expect(result.settings.dashboardFile).toBe("dashboard");
  });
  it.each([
    { dashboardFile: "boards/missing" },
    { workspaceFiles: ["2"], workspaceNames: ["工作台"] },
  ])("does not override explicit paths even when their files have not synced", async (raw) => {
    const adapter = vault({ "dashboard.md": board });
    expect(await recoverWorkspaceRegistry(raw, adapter)).toEqual({ settings: raw, recovered: false });
    expect(adapter.list).not.toHaveBeenCalled();
  });
  it("excludes backups, navigation, invalid identities and artifacts", async () => {
    const adapter = vault({
      ".dashboard-backup/2.old.md": board,
      ".trash/2.md": board,
      ".obsidian/board.md": board,
      "index.md": board,
      "string.md": '---\ndashboard: "true"\n---\n',
      "artifact.md": "---\ndashboard: true\ntype: Project\n---\n",
      "invalid.md": "---\ndashboard: true\nworkbench_schema: 0\n---\n",
      "broken.md": "---\ndashboard: [\n---\n",
      "duplicate.md": "---\ndashboard: true\ndashboard: false\n---\n",
      "boards/legacy.md": "---\ndashboard: true\ntype: ''\n---\n",
      "boards/future.md": "---\ndashboard: true\nworkbench_schema: 7\n---\n",
    });
    const result = await recoverWorkspaceRegistry(undefined, adapter);
    expect(result.settings.workspaceFiles).toEqual(["boards/future", "boards/legacy"]);
    expect(adapter.read.mock.calls.some(([path]) => path.startsWith("."))).toBe(false);
  });
  it("allows a default board only after successfully scanning an empty registry", async () => {
    const result = await recoverWorkspaceRegistry(undefined, vault({ "note.md": "normal" }));
    expect(result.recovered).toBe(false);
    expect(normalizeApexSettings(result.settings).dashboardFile).toBe("dashboard");
  });
  it("does not turn storage failures into permission to create a duplicate board", async () => {
    const adapter = vault({ "2.md": board });
    adapter.read.mockRejectedValueOnce(new Error("unavailable"));
    await expect(recoverWorkspaceRegistry(undefined, adapter)).rejects.toThrow("unavailable");
  });
});

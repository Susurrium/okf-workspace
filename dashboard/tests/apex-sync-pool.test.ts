import { TFile, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { acquireSyncEngine, SyncEngine } from "../apex/src/sync.js";
import { DEFAULT_SETTINGS } from "../apex/src/types.js";
import { parse, serialize } from "../apex/src/parser.js";

describe("Apex board sync pool", () => {
  it("reports a real write failure, preserves configuration and permits an explicit retry", async () => {
    const file = new (TFile as unknown as new (path: string) => TFile)("board.md");
    const original = { mode: "embedded", future: { retained: true } };
    let disk = serialize({ banner: { quote: "", author: "", image: "" }, quickActions: [],
      columns: [{ id: "one", name: "项目", sectionType: "workspace-projects", color: "#10b981", cards: [], extensionConfig: original }] });
    const before = disk;
    let denied = true;
    const app = { fileManager: { processFrontMatter: async (_file: TFile, update: (metadata: Record<string, unknown>) => void) => {
      if (denied) throw new Error("无写入权限");
      const data = parse(disk);
      update(data.sourceFrontmatter!);
      const columns = data.sourceFrontmatter!.columns as Array<{ id: string; config: Record<string, unknown> }>;
      for (const column of data.columns) column.extensionConfig = columns.find(item => item.id === column.id)?.config;
      disk = serialize(data);
    } }, vault: { getFileByPath: () => file, read: async () => disk, on: () => ({}), offref: () => undefined,
      modify: async (_file: TFile, content: string) => { if (denied) throw new Error("无写入权限"); disk = content; },
      adapter: { exists: async () => true, write: async () => undefined, list: async () => ({ files: [], folders: [] }) },
    } } as unknown as App;
    const engine = new SyncEngine(app, { ...DEFAULT_SETTINGS, dashboardFile: "board" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await engine.init();
      await expect(engine.updateExtensionConfig("one", { ...original, mode: "summary" })).rejects.toThrow("无写入权限");
      expect(disk).toBe(before);
      expect(engine.getData()?.columns[0]?.extensionConfig).toEqual(original);
      denied = false;
      await engine.updateExtensionConfig("one", { ...original, mode: "summary" });
      expect(parse(disk).columns[0]?.extensionConfig).toEqual({ ...original, mode: "summary" });
    } finally { engine.destroy(); errors.mockRestore(); }
  });
  it("shares one engine per board path while isolating different workbenches", async () => {
    const app = {} as App;
    const settings = {
      ...DEFAULT_SETTINGS,
      workspaceFiles: ["boards/one", "boards/two"],
      dashboardFile: "boards/one",
    };
    const oneA = acquireSyncEngine(app, settings, "boards/one");
    const oneB = acquireSyncEngine(app, settings, "boards/one.md");
    const two = acquireSyncEngine(app, settings, "boards/two");

    expect(oneA.engine).toBe(oneB.engine);
    expect(two.engine).not.toBe(oneA.engine);

    await oneA.release();
    await oneB.release();
    await two.release();
  });

  it("refuses a conflicting configuration change made while the host acquires its file lock", async () => {
    const file = new (TFile as unknown as new (path: string) => TFile)("board.md");
    let disk = serialize({ banner: { quote: "", author: "", image: "" }, quickActions: [],
      columns: [{ id: "one", name: "项目", sectionType: "workspace-projects", color: "blue", cards: [], extensionConfig: { pageSize: 5 } }] });
    const app = { fileManager: { processFrontMatter: async (_file: TFile, update: (metadata: Record<string, unknown>) => void) => {
      const external = parse(disk);
      external.columns[0]!.extensionConfig = { pageSize: 30, future: { retained: true } };
      disk = serialize(external);
      update(parse(disk).sourceFrontmatter!);
      throw new Error("发生冲突后不应继续写入");
    } }, vault: { getFileByPath: () => file, read: async () => disk, on: () => ({}), offref: () => undefined,
      adapter: { exists: async () => true, write: async () => undefined, list: async () => ({ files: [], folders: [] }) },
    } } as unknown as App;
    const engine = new SyncEngine(app, { ...DEFAULT_SETTINGS, dashboardFile: "board" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await engine.init();
      await expect(engine.updateExtensionConfig("one", { pageSize: 10 })).rejects.toThrow("pageSize 存在保存冲突");
      expect(parse(disk).columns[0]!.extensionConfig).toEqual({ pageSize: 30, future: { retained: true } });
    } finally { engine.destroy(); errors.mockRestore(); }
  });

  it("preserves fields added after a settings window opens and rejects stale edits to the same field", async () => {
    const file = new (TFile as unknown as new (path: string) => TFile)("board.md");
    const baseline = { pageSize: 5 };
    let disk = serialize({ banner: { quote: "", author: "", image: "" }, quickActions: [],
      columns: [{ id: "one", name: "项目", sectionType: "workspace-projects", color: "blue", cards: [],
        extensionConfig: { ...baseline, future: { retained: true }, sort: "title" } }] });
    const write = vi.fn(async (_file: TFile, update: (metadata: Record<string, unknown>) => void) => {
      const data = parse(disk);
      update(data.sourceFrontmatter!);
      const definitions = data.sourceFrontmatter!.columns as Array<{ id: string; config: Record<string, unknown> }>;
      for (const column of data.columns) column.extensionConfig = definitions.find(item => item.id === column.id)?.config;
      disk = serialize(data);
    });
    const app = { fileManager: { processFrontMatter: write }, vault: {
      getFileByPath: () => file, read: async () => disk, on: () => ({}), offref: () => undefined,
      adapter: { exists: async () => true, write: async () => undefined, list: async () => ({ files: [], folders: [] }) },
    } } as unknown as App;
    const engine = new SyncEngine(app, { ...DEFAULT_SETTINGS, dashboardFile: "board" });
    try {
      await engine.init();
      await engine.updateExtensionConfig("one", { pageSize: 10 }, baseline);
      expect(parse(disk).columns[0]!.extensionConfig).toEqual({ pageSize: 10, future: { retained: true }, sort: "title" });
      await expect(engine.updateExtensionConfig("one", { pageSize: 20 }, baseline)).rejects.toThrow("pageSize 存在保存冲突");
      expect(write).toHaveBeenCalledTimes(1);
      expect(engine.getData()?.columns[0]?.extensionConfig).toEqual({ pageSize: 10, future: { retained: true }, sort: "title" });
    } finally { engine.destroy(); }
  });
});

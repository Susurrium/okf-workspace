import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { VaultNoteService, appendProjectLogEntry } from "../src/plugin/vault-note-service.js";
import { latestProjectLogEntry, VaultDashboardReader } from "../src/plugin/vault-dashboard.js";

function fixture() {
  const data = new Map<string, string>();
  const files = new Map<string, TFile>();
  const folders = new Set<string>();
  let failCreate = "";
  let failRead = "";
  let creates = 0;
  let running = 0;
  let maxRunning = 0;
  const add = (path: string, content: string) => {
    const file = new (TFile as unknown as new (path: string) => TFile)(path);
    files.set(path, file); data.set(path, content); return file;
  };
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path) ?? (folders.has(path) ? { path } : null),
    adapter: { stat: async (path: string) => files.has(path)
      ? { type: "file" } : folders.has(path) ? { type: "folder" } : null },
    getMarkdownFiles: () => [...files.values()], getFiles: () => [...files.values()],
    createFolder: async (path: string) => { folders.add(path); },
    create: async (path: string, content: string) => {
      creates++;
      if (path === failCreate) throw new Error("disk full");
      if (data.has(path)) throw new Error("already exists");
      return add(path, content);
    },
    read: async (file: TFile) => {
      if (file.path === failRead) throw new Error("read denied");
      return data.get(file.path) ?? "";
    },
    cachedRead: async (file: TFile) => {
      running++; maxRunning = Math.max(running, maxRunning);
      try { await new Promise((resolve) => setTimeout(resolve, 1)); return await vault.read(file); }
      finally { running--; }
    },
    process: async (file: TFile, change: (text: string) => string) => {
      // Obsidian's process serializes this atomic read/transform/write per file.
      const next = change(data.get(file.path) ?? ""); data.set(file.path, next); return next;
    },
  };
  const app = { vault } as unknown as App;
  return { app, data, files, add, service: new VaultNoteService(app),
    failCreate: (path: string) => { failCreate = path; }, failRead: (path: string) => { failRead = path; },
    creates: () => creates, maxRunning: () => maxRunning };
}

describe("local write and scan safety", () => {
  it("preserves both simultaneous first daily captures and project log writes", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.service.appendDailyCapture("first"), f.service.appendDailyCapture("second")]);
    expect(a.path).toBe(b.path);
    expect(f.data.get(a.path)).toContain("first"); expect(f.data.get(a.path)).toContain("second");
    expect(f.creates()).toBe(1);
    await f.service.createProject("Demo", "demo");
    await Promise.all([f.service.appendProjectLog("demo", "step one"), f.service.appendProjectLog("demo", "step two")]);
    const log = f.data.get("projects/demo/log.md")!;
    expect(log.indexOf("step one")).toBeLessThan(log.indexOf("step two"));
  });

  it("preflights templates without partial files and retries only its own unchanged partial project", async () => {
    const f = fixture();
    f.add("system/templates/canonical/project.md", "# {{title}}\n");
    f.failRead("system/templates/canonical/project.md");
    await expect(f.service.createProject("Demo", "demo")).rejects.toThrow("read denied");
    expect(f.creates()).toBe(0);
    f.failRead(""); f.failCreate("projects/demo/project.md");
    await expect(f.service.createProject("Demo", "demo")).rejects.toThrow("disk full");
    const originalLog = f.data.get("projects/demo/log.md");
    f.failCreate("");
    await expect(f.service.createProject("Demo", "demo")).resolves.toEqual({ path: "projects/demo/project.md" });
    expect(f.data.get("projects/demo/log.md")).toBe(originalLog);
  });

  it("never overwrites an edited partial project on retry", async () => {
    const f = fixture(); f.failCreate("projects/demo/project.md");
    await expect(f.service.createProject("Demo", "demo")).rejects.toThrow();
    f.data.set("projects/demo/log.md", "my valuable manual edits"); f.failCreate("");
    await expect(f.service.createProject("Demo", "demo")).rejects.toThrow("文件已经更改");
    expect(f.data.get("projects/demo/log.md")).toBe("my valuable manual edits");
    expect(f.data.has("projects/demo/project.md")).toBe(false);
  });

  it("appends after legacy reverse-ordered logs and finds the newest appended entry", () => {
    const old = "# Log\n\n## 2026-09-08\n\n- morning\n\n## 2026-09-07\n\n- yesterday\n";
    const next = appendProjectLogEntry(old, "## 2026-09-08", "afternoon\n  detail");
    expect(next.startsWith(old.trimEnd())).toBe(true);
    expect(latestProjectLogEntry(next)).toBe("- afternoon\n  detail");
    expect(latestProjectLogEntry(appendProjectLogEntry(next, "## 2026-09-09", "tomorrow"))).toBe("- tomorrow");
  });

  it("isolates unreadable files, bounds concurrency, and recovers without restarting", async () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) f.add(`inbox/captures/${i}.md`, `---\ntype: Capture\ntitle: Note ${i}\n---\ntext`);
    f.failRead("inbox/captures/5.md");
    const reader = new VaultDashboardReader(f.app);
    expect((await reader.inbox()).captures).toHaveLength(29);
    expect(reader.getReadWarnings()).toEqual([{ path: "inbox/captures/5.md", message: "read denied" }]);
    expect(f.maxRunning()).toBeLessThanOrEqual(8);
    f.failRead("");
    expect((await reader.inbox()).captures).toHaveLength(30);
    expect(reader.getReadWarnings()).toEqual([]);
  });
});

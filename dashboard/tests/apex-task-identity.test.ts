import { TFile, type App } from "obsidian";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  collectVaultTasks,
  matchesCalendarFilter,
  scanFileTasks,
  toggleTaskInFile,
  updateTaskDateFields,
  updateTaskDatesInFile,
} from "../apex/src/alltasks-scan.js";

function file(path: string): TFile {
  return Object.assign(new (TFile as unknown as new (path: string) => TFile)(path), {
    stat: { mtime: 1, ctime: 1, size: 0 },
  });
}

describe("unified Markdown task identity", () => {
  it("matches the shared cross-language task fixture", () => {
    const cases = JSON.parse(readFileSync(
      new URL("../../tests/fixtures/tasks/task-cases.json", import.meta.url),
      "utf8",
    )) as Array<{ path: string; markdown: string; formal_open: string[]; checkbox_count: number }>;

    for (const fixture of cases) {
      const tasks = scanFileTasks(file(fixture.path), fixture.markdown);
      expect(tasks).toHaveLength(fixture.checkbox_count);
      expect(tasks.filter((task) => task.formal && !task.checked).map((task) => task.text)).toEqual(fixture.formal_open);
    }
  });

  it("separates reminder, due, and scheduled while excluding YAML, fences, and Source text from formal tasks", () => {
    const project = scanFileTasks(file("projects/demo/project.md"), `---
type: Project
sample: "- [ ] #task yaml example"
---
\`\`\`markdown
- [ ] #task fenced example [scheduled:: 2026-10-01]
\`\`\`
- [ ] #task Ship it ⏰ 2026-09-28 08:00 [due:: 2026-09-30] [scheduled:: 2026-09-29 09:00] ^task-ship
`);
    const source = scanFileTasks(file("sources/example.md"), `---
type: Source
---
- [ ] #task quoted source task [scheduled:: 2026-09-29]
- [ ] ordinary source checklist [scheduled:: 2026-09-29]
`);

    expect(project).toHaveLength(1);
    expect(project[0]).toEqual(expect.objectContaining({
      text: "Ship it",
      formal: true,
      blockId: "task-ship",
      reminder: "2026-09-28 08:00",
      scheduled: "2026-09-29",
      scheduledTime: "09:00",
      due: "2026-09-30",
    }));
    expect(source).toHaveLength(2);
    expect(source.every((task) => !task.formal)).toBe(true);
    expect(matchesCalendarFilter(project[0]!, "formal", "2026-09-29")).toBe(true);
    expect(matchesCalendarFilter(source[0]!, "formal", "2026-09-29")).toBe(false);
    expect(matchesCalendarFilter(source[1]!, "all", "2026-09-29")).toBe(true);
  });

  it("parses a formal task on the final CRLF line", () => {
    const tasks = scanFileTasks(
      file("projects/crlf/project.md"),
      "---\r\ntype: Project\r\n---\r\n- [ ] #task Windows line ^task-crlf\r\n",
    );

    expect(tasks).toEqual([
      expect.objectContaining({ text: "Windows line", formal: true, blockId: "task-crlf" }),
    ]);
    expect(tasks[0]?.originalLine.endsWith("\r")).toBe(true);
  });

  it("uses a unique block ID after line movement and preserves concurrent text edits", async () => {
    const source = "- [ ] #task Original [scheduled:: 2026-09-29] ^task-stable";
    const task = scanFileTasks(file("projects/demo/project.md"), source)[0]!;
    let markdown = `intro\n- [ ] #task Edited elsewhere [scheduled:: 2026-09-29] ^task-stable\n`;
    const app = {
      vault: {
        process: async (_file: TFile, transform: (value: string) => string) => {
          markdown = transform(markdown);
          return markdown;
        },
      },
    } as unknown as App;

    await expect(toggleTaskInFile(app, task, true)).resolves.toBe(true);
    expect(markdown).toContain("- [x] #task Edited elsewhere");
    expect(markdown).not.toContain("Original");
  });

  it("edits reminder, due, and scheduled independently without changing text or identity", () => {
    const line = "- [ ] #task Ship it ⏰ 2026-09-28 08:00 [due:: 2026-09-30] [scheduled:: 2026-09-29] ^task-ship";
    const updated = updateTaskDateFields(line, {
      reminder: "2026-10-01 09:15",
      due: "2026-10-04",
      scheduled: "2026-10-02",
    });
    expect(updated).toBe("- [ ] #task Ship it ⏰ 2026-10-01 09:15 [due:: 2026-10-04] [scheduled:: 2026-10-02] ^task-ship");
    const parsed = scanFileTasks(file("projects/demo/project.md"), updated)[0]!;
    expect(parsed).toEqual(expect.objectContaining({
      reminder: "2026-10-01 09:15",
      due: "2026-10-04",
      scheduled: "2026-10-02",
      blockId: "task-ship",
      text: "Ship it",
    }));
  });

  it("relocates a date edit by block ID and preserves concurrent task text", async () => {
    const task = scanFileTasks(file("projects/demo/project.md"), "- [ ] #task Original [due:: 2026-09-30] ^task-dates")[0]!;
    let markdown = "intro\n- [ ] #task Edited elsewhere [due:: 2026-09-30] ^task-dates\n";
    const app = { vault: { process: async (_file: TFile, transform: (value: string) => string) => {
      markdown = transform(markdown);
      return markdown;
    } } } as unknown as App;

    await expect(updateTaskDatesInFile(app, task, {
      reminder: "2026-09-28 08:00",
      due: "2026-10-01",
      scheduled: "2026-09-29",
    })).resolves.toBe(true);
    expect(markdown).toContain('#task Edited elsewhere');
    expect(markdown).toContain('📅 2026-10-01');
    expect(scanFileTasks(task.file, markdown)[0]).toMatchObject({ reminder: '2026-09-28 08:00', due: '2026-10-01', scheduled: '2026-09-29', blockId: 'task-dates' });
  });

  it("invalidates task scans when external writes change size before the cached read catches up", async () => {
    const target = file("projects/cache-race/project.md");
    const original = "- [ ] #task Original ^task-original\n";
    const changed = `${original}- [ ] #task Added externally ^task-added\n`;
    target.stat.size = original.length;
    let current = original;
    const app = {
      vault: {
        getMarkdownFiles: () => [target],
        cachedRead: async () => original,
        read: async () => current,
      },
      metadataCache: {
        getFileCache: () => ({ listItems: [{ task: " " }] }),
      },
    } as unknown as App;

    await expect(collectVaultTasks(app)).resolves.toHaveLength(1);
    current = changed;
    target.stat.size = changed.length;
    await expect(collectVaultTasks(app)).resolves.toEqual([
      expect.objectContaining({ blockId: "task-original" }),
      expect.objectContaining({ blockId: "task-added" }),
    ]);
  });
});

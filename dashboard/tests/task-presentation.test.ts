import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import { scanFileTasks } from "../apex/src/alltasks-scan.js";
import { executeTaskQuery } from "../tasks-generated/core.js";
import { taskMatchesView, taskDateLabels, sortTasks, taskIdentity } from "../src/tasks/task-presentation.js";

const file = Object.assign(new (TFile as unknown as new (path: string) => TFile)("projects/demo/project.md"), { stat: { mtime: 1, ctime: 1, size: 1 } });
const now = new Date(2026, 9, 13, 12, 0);

describe("task view meanings", () => {
  it("keeps an overdue view constrained when a broader dependency query is applied", () => {
    const tasks = scanFileTasks(file, "- [ ] #task Late 📅 2026-10-12 ^late\n- [ ] #task Later ⏳ 2026-10-20 ^later\n- [ ] #task No date ^none");
    const permitted = tasks.filter(task => taskMatchesView(task, "overdue", now));
    const result = executeTaskQuery("not done\nis not blocked\ngroup by path", tasks.map(task => task.upstream!), "dashboard", {}, permitted.map(taskIdentity));
    expect(result.groups.flatMap(group => group.tasks).map(task => task.blockLink.trim())).toEqual(["^late"]);
  });
  it("includes independent future reminder and start dates", () => {
    const tasks = scanFileTasks(file, "- [ ] #task Reminder ⏰ 2026-10-14 10:00\n- [ ] #task Start 🛫 2026-10-15\n- [ ] #task No date");
    expect(tasks.filter(task => taskMatchesView(task, "upcoming", now))).toHaveLength(2);
    expect(tasks.filter(task => taskMatchesView(task, "unscheduled", now)).map(task => task.text)).toEqual(["No date"]);
  });
  it("distinguishes same-day deadline time from a date-only deadline", () => {
    const tasks = scanFileTasks(file, "- [ ] #task Before [due:: 2026-10-13 10:00]\n- [ ] #task After [due:: 2026-10-13 14:00]\n- [ ] #task Date 📅 2026-10-13");
    expect(tasks.filter(task => taskMatchesView(task, "overdue", now)).map(task => task.text)).toEqual(["Before"]);
    expect(taskDateLabels(tasks[1]!)).toContain("截止 2026-10-13 14:00");
  });
  it("keeps cancellation, completion and local checklists separately queryable", () => {
    const tasks = scanFileTasks(file, "- [-] #task Cancelled ❌ 2026-10-13\n- [x] #task Done ✅ 2026-10-12\n- [ ] Step");
    expect(tasks.filter(task => taskMatchesView(task, "all", now))).toHaveLength(0);
    expect(tasks.filter(task => taskMatchesView(task, "cancelled", now))).toHaveLength(1);
    expect(tasks.filter(task => taskMatchesView(task, "done", now))).toHaveLength(1);
    expect(tasks.filter(task => taskMatchesView(task, "checklists", now))).toHaveLength(0);
    expect(taskDateLabels(tasks[1]!)).toEqual(["完成 2026-10-12"]);
  });
  it("sorts completed occurrences by completion date while retaining equal titles", () => {
    const tasks = scanFileTasks(file, "- [x] #task Review ✅ 2026-10-11 ^first\n- [x] #task Review ✅ 2026-10-13 ^second");
    expect(sortTasks(tasks, "", "done").map(task => task.blockId)).toEqual(["second", "first"]);
  });
});

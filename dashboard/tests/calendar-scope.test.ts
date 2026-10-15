import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import { scanFileTasks, indexTasksByDay, buildTaskLine } from "../apex/src/alltasks-scan.js";
import { filterCalendarScope, calendarTimeEvents } from "../apex/src/calendar-scope.js";
import { taskDayTime } from "../apex/src/calendar-grid.js";

const file = Object.assign(new (TFile as unknown as new (path: string) => TFile)("projects/demo/project.md"), { stat: { mtime: 1, ctime: 1, size: 1 } });
describe("calendar projections", () => {
  it("keeps scope, status and date facts as independent constraints", () => {
    const tasks = scanFileTasks(file, "- [ ] #task Planned ⏳ 2026-10-13 📅 2026-10-15\n- [x] #task Done ✅ 2026-10-13\n- [ ] #task Other ⏳ 2026-10-13 [project:: /projects/other/project.md]");
    const map = filterCalendarScope(indexTasksByDay(tasks), { calendarTaskState: "open", calendarDateFact: "scheduled", project: "projects/demo/project.md" });
    expect([...map.keys()]).toEqual(["2026-10-13"]);
    expect(map.get("2026-10-13")?.map(task => task.text)).toEqual(["Planned"]);
    const history = filterCalendarScope(indexTasksByDay(tasks), { calendarTaskState: "done", calendarDateFact: "all" });
    expect(history.get("2026-10-13")?.map(task => task.text)).toEqual(["Done"]);
  });
  it("renders separate time facts for the same identity without duplicating day-list tasks", () => {
    const task = scanFileTasks(file, "- [ ] #task Action [scheduled:: 2026-10-13 09:00] [due:: 2026-10-13 17:00] ⏰ 2026-10-13 08:00 ^same")[0]!;
    const days = indexTasksByDay([task]);
    expect(days.get("2026-10-13")).toHaveLength(1);
    const events = calendarTimeEvents(days).get("2026-10-13")!;
    expect(events).toHaveLength(3);
    expect(new Set(events.map(task => task.blockId))).toEqual(new Set(["same"]));
    expect(events.map(task => taskDayTime(task, "2026-10-13"))).toEqual(["08:00", "09:00", "17:00"]);
    expect(calendarTimeEvents(days, "due").get("2026-10-13")).toHaveLength(1);
  });
  it("preserves the legacy explicit deadline default and supports the workbench plan default", () => {
    expect(buildTaskLine("Action", "2026-10-13", {})).toContain("📅 2026-10-13");
    expect(buildTaskLine("Action", "2026-10-13", {}, "scheduled")).toContain("⏳ 2026-10-13");
  });
  it("keeps a cancellation-only record in history with its own date fact", () => {
    const tasks = scanFileTasks(file, "- [-] #task Cancelled ❌ 2026-10-13 ^cancelled");
    const days = filterCalendarScope(indexTasksByDay(tasks), { calendarTaskState: "cancelled", calendarDateFact: "all" });
    expect(days.get("2026-10-13")).toHaveLength(1);
    const events = calendarTimeEvents(days).get("2026-10-13")!;
    expect(events[0]?.calendarEventKind).toBe("cancelled");
    expect(taskDayTime(events[0]!, "2026-10-13")).toBeUndefined();
  });
});

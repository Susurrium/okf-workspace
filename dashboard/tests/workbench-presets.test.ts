import { describe, expect, it } from "vitest";

import { parse } from "../apex/src/parser.js";
import { registerSectionDefinition } from "../apex/src/section-registry.js";
import {
  generateWorkbenchPresetMarkdown,
  WORKBENCH_PRESETS,
  workbenchPresetData,
} from "../src/features/workbench-presets.js";

describe("OKF workbench presets", () => {
  it("provides every declared workflow and defaults to the unified daily board", () => {
    expect(WORKBENCH_PRESETS.map((preset) => preset.id)).toEqual([
      "daily", "learning", "project", "reading", "knowledge", "life", "system",
    ]);
    expect(workbenchPresetData().columns.map((column) => column.sectionType)).toEqual([
      "workspace-today",
      "memo",
      "workspace-updates",
      "calendar",
    ]);
    expect(workbenchPresetData().quickActions).toContainEqual({
      name: "全局搜索",
      icon: "search",
      type: "command",
      target: "global-search:open",
    });
    expect(workbenchPresetData().quickActions.map((action) => action.name)).toEqual([
      "快速记录", "新建任务", "全局搜索", "快捷操作",
    ]);
    expect(parse(generateWorkbenchPresetMarkdown('daily')).quickActions.find(action => action.target === 'okf-workspace-dashboard:quick-capture')?.defaultCapture).toBe(true);
  });

  it("serializes stable section IDs and declarative filters without object snapshots", () => {
    const unregister = [
      "workspace-today", "workspace-inbox", "workspace-projects", "workspace-reading",
      "workspace-life", "workspace-system", "workspace-updates", "workspace-sources",
    ]
      .map((type) => registerSectionDefinition({
        type,
        icon: "box",
        label: type,
        defaultName: type,
        render: () => undefined,
      }));
    try {
      const parsed = parse(generateWorkbenchPresetMarkdown("daily"));
      expect(new Set(parsed.columns.map((column) => column.id)).size).toBe(parsed.columns.length);
      expect(parsed.columns.find((column) => column.id === "daily-today")?.extensionConfig)
        .toEqual({ showDailyUpdates: false, pageSize: 5 });
      expect(parsed.columns.find((column) => column.id === "daily-updates")?.extensionConfig)
        .toEqual({ itemsPerEdition: 3, readingView: "daily-updates", feedStreams: ["hotspot", "news", "treehole"] });
      expect(generateWorkbenchPresetMarkdown("daily")).not.toContain("open_tasks:");
    } finally {
      unregister.forEach((dispose) => dispose());
    }
  });

  it("keeps Apex reading services in the reading preset", () => {
    expect(workbenchPresetData("reading").columns.map((column) => column.sectionType)).toEqual([
      "workspace-reading",
      "weread",
    ]);
  });

  it("keeps business tools complete while binding only the chosen context", () => {
    const project = workbenchPresetData("project");
    expect(project.columns.map(column => column.sectionType)).toEqual(["workspace-projects", "memo"]);
    expect(project.columns[0]?.extensionConfig).toEqual({});
    expect(workbenchPresetData("project", { project: "projects/a/project.md" }).columns[0]?.extensionConfig)
      .toEqual({ project: "projects/a/project.md" });
    for (const preset of WORKBENCH_PRESETS) {
      expect(workbenchPresetData(preset.id as never).columns.every(column => column.extensionConfig?.mode === undefined)).toBe(true);
    }
  });
});

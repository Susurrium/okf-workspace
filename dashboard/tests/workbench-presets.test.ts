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
      "daily", "learning", "project", "reading", "life", "system",
    ]);
    expect(workbenchPresetData().columns.map((column) => column.sectionType)).toEqual([
      "memo",
      "workspace-today",
      "workspace-inbox",
      "workspace-projects",
      "calendar",
      "workspace-reading",
      "workspace-life",
      "workspace-system",
    ]);
    expect(workbenchPresetData().quickActions).toContainEqual({
      name: "全局搜索",
      icon: "search",
      type: "command",
      target: "global-search:open",
    });
    expect(workbenchPresetData().quickActions.map((action) => action.name)).toEqual([
      "全局搜索", "快速创建", "问我的笔记", "导入资料", "系统状态",
    ]);
  });

  it("serializes stable section IDs and declarative filters without object snapshots", () => {
    const unregister = [
      "workspace-today", "workspace-inbox", "workspace-projects", "workspace-reading",
      "workspace-life", "workspace-system",
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
      expect(parsed.columns.find((column) => column.id === "daily-projects")?.extensionConfig)
        .toEqual({ statuses: ["active"] });
      expect(generateWorkbenchPresetMarkdown("daily")).not.toContain("open_tasks:");
    } finally {
      unregister.forEach((dispose) => dispose());
    }
  });

  it("keeps Apex reading services in the reading preset", () => {
    expect(workbenchPresetData("reading").columns.map((column) => column.sectionType)).toEqual([
      "workspace-reading",
      "weread",
      "workspace-knowledge",
      "workspace-inbox",
    ]);
  });

  it("does not claim project or reading context that the preset does not bind", () => {
    const project = workbenchPresetData("project");
    expect(project.columns.find((column) => column.id === "project-today")?.name).toBe("今日行动");
    expect(project.columns.find((column) => column.id === "project-learning")?.name).toBe("学习工作区");
    expect(workbenchPresetData("reading").columns.find((column) => column.id === "reading-knowledge")?.name)
      .toBe("知识工作区");
  });
});

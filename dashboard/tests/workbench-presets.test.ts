import { describe, expect, it } from "vitest";

import { parse } from "../apex/src/parser.js";
import { registerSectionDefinition } from "../apex/src/section-registry.js";
import {
  generateWorkbenchPresetMarkdown,
  WORKBENCH_PRESETS,
  workbenchPresetData,
} from "../src/features/workbench-presets.js";

describe("OKF workbench presets", () => {
  it("provides the four declared workflows and defaults to the unified daily board", () => {
    expect(WORKBENCH_PRESETS.map((preset) => preset.id)).toEqual([
      "daily", "learning", "project", "reading",
    ]);
    expect(workbenchPresetData().columns.map((column) => column.sectionType)).toEqual([
      "memo",
      "workspace-today",
      "workspace-inbox",
      "workspace-projects",
      "calendar",
      "workspace-reading",
    ]);
    expect(workbenchPresetData().quickActions).toContainEqual({
      name: "全局搜索",
      icon: "search",
      type: "command",
      target: "global-search:open",
    });
  });

  it("serializes stable section IDs and declarative filters without object snapshots", () => {
    const unregister = ["workspace-today", "workspace-inbox", "workspace-projects", "workspace-reading"]
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
    ]);
  });
});

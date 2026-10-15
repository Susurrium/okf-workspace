import { describe, expect, it, vi } from "vitest";

import {
  createOkfSurfaceSectionDefinitions,
  OKF_SECTION_TYPES,
  OKF_SURFACE_CAPABILITIES,
} from "../src/features/workbench/okf-surface-sections.js";
import type { DashboardSection } from "../src/plugin/dashboard-view.js";

const SECTIONS: DashboardSection[] = [
  "today",
  "tasks",
  "inbox",
  "reading",
  "sources",
  "learning",
  "projects",
  "knowledge",
  "life",
  "system",
];

describe("registered OKF workbench surface parity", () => {
  it("mounts the complete shared surface for every Apex section type", async () => {
    const cleanups = SECTIONS.map(() => vi.fn());
    const mount = vi.fn(async (_container: HTMLElement, section: DashboardSection) => (
      cleanups[SECTIONS.indexOf(section)]!
    ));
    const definitions = createOkfSurfaceSectionDefinitions({
      mountOkfDashboardSurface: mount,
    });

    expect(definitions.map((definition) => definition.type)).toEqual([
      ...SECTIONS.map((section) => OKF_SECTION_TYPES[section]), "workspace-updates", "alltasks",
    ]);

    for (const [index, definition] of definitions.slice(0, SECTIONS.length).entries()) {
      const container = { addClass: vi.fn() } as unknown as HTMLElement;
      const cleanup = await definition.render({ container } as never);
      expect(mount).toHaveBeenNthCalledWith(index + 1, container, SECTIONS[index]);
      expect(cleanup).toBe(cleanups[index]);
    }
  });

  it("keeps an explicit release-gate inventory for every reachable surface", () => {
    expect(Object.keys(OKF_SURFACE_CAPABILITIES)).toEqual(SECTIONS);
    for (const section of SECTIONS) {
      expect(OKF_SURFACE_CAPABILITIES[section].length).toBeGreaterThanOrEqual(5);
    }
    expect(OKF_SURFACE_CAPABILITIES.learning).toEqual(expect.arrayContaining([
      "学习范围",
      "课程上下文",
      "项目上下文",
      "生成与重试",
      "Claudian",
      "完成与撤销",
      "整理为知识笔记",
    ]));
  });
});

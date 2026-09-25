import { describe, expect, it, vi } from "vitest";

import { revealSectionType } from "../apex/src/section-navigation.js";

describe("Apex OKF section navigation", () => {
  it("expands and focuses the real section without changing its type or name", () => {
    const title = { tabIndex: 0, focus: vi.fn() };
    const row = {
      dataset: { column: "learning-main" },
      hasClass: vi.fn(() => true),
      removeClass: vi.fn(),
      scrollIntoView: vi.fn(),
      querySelector: vi.fn(() => title),
    };
    const column = {
      id: "learning-main",
      name: "我的学习区",
      sectionType: "workspace-learning",
      color: "#6366f1",
      cards: [],
    };
    const collapsedSections = new Set([column.id]);
    const data = { columns: [column] };
    const container = { querySelectorAll: () => [row] } as unknown as HTMLElement;

    expect(revealSectionType(data as never, container, collapsedSections, "workspace-learning")).toBe(true);
    expect(row.removeClass).toHaveBeenCalledWith("dashboard-section-row--collapsed");
    expect(collapsedSections.has(column.id)).toBe(false);
    expect(row.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(title.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(column.name).toBe("我的学习区");
    expect(column.sectionType).toBe("workspace-learning");
    expect(revealSectionType(data as never, container, collapsedSections, "workspace-system")).toBe(false);
  });
});

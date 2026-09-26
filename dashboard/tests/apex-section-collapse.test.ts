import { describe, expect, it } from "vitest";

import {
  PaneSectionCollapseState,
  createSectionCollapseToggle,
} from "../apex/src/section-collapse-state.js";

describe("Apex section collapse state", () => {
  it("preserves consecutive section changes through a full render", () => {
    const state = new PaneSectionCollapseState();
    const path = "boards/daily";
    const toggleA = createSectionCollapseToggle(
      () => state.forWorkspace(path),
      (next) => state.replace(path, next),
      "section-a", "A",
    );
    const toggleB = createSectionCollapseToggle(
      () => state.forWorkspace(path),
      (next) => state.replace(path, next),
      "section-b", "B",
    );

    // Both row handlers are created before either row is collapsed.
    toggleA(true);
    toggleB(true);
    expect([...state.forWorkspace(path)]).toEqual(["section-a", "section-b"]);

    // Adding a section rebuilds all rows from the saved collapse state.
    const restored = new PaneSectionCollapseState();
    restored.restore(state.snapshot(), path, undefined);
    expect(restored.forWorkspace(path).has("section-a")).toBe(true);
    expect(restored.forWorkspace(path).has("section-b")).toBe(true);

    toggleA(false);
    expect([...state.forWorkspace(path)]).toEqual(["section-b"]);
  });

  it("removes a legacy name key without losing another collapsed section", () => {
    const state = new PaneSectionCollapseState();
    state.replace("boards/daily", ["Old title", "section-b"]);
    const toggle = createSectionCollapseToggle(
      () => state.forWorkspace("boards/daily"),
      (next) => state.replace("boards/daily", next),
      "section-a", "Old title",
    );

    toggle(false);
    expect([...state.forWorkspace("boards/daily")]).toEqual(["section-b"]);
  });

  it("isolates both panes and workbench files", () => {
    const firstPane = new PaneSectionCollapseState();
    const secondPane = new PaneSectionCollapseState();
    firstPane.replace("boards/daily", ["daily-a"]);
    firstPane.replace("boards/projects", ["projects-a"]);
    secondPane.replace("boards/daily", ["daily-b"]);

    expect([...firstPane.forWorkspace("boards/daily")]).toEqual(["daily-a"]);
    expect([...firstPane.forWorkspace("boards/projects")]).toEqual(["projects-a"]);
    expect([...secondPane.forWorkspace("boards/daily")]).toEqual(["daily-b"]);
  });

  it("restores legacy pane state and keeps it on workspace rename", () => {
    const state = new PaneSectionCollapseState();
    state.restore(undefined, "boards/daily", ["section-a", 42, "section-b"]);
    expect([...state.forWorkspace("boards/daily")]).toEqual(["section-a", "section-b"]);

    state.rename("boards/daily.md", "boards/today");
    expect(state.snapshot()).toEqual({ "boards/today": ["section-a", "section-b"] });
    state.remove("boards/today");
    expect(state.snapshot()).toEqual({});
  });

  it("prefers the saved per-workbench state over the legacy active list", () => {
    const state = new PaneSectionCollapseState();
    state.restore({ "boards/daily": ["latest"], "boards/projects": ["project"] }, "boards/daily", ["old"]);

    expect(state.snapshot()).toEqual({
      "boards/daily": ["latest"],
      "boards/projects": ["project"],
    });
  });
});

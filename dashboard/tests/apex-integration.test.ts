import { describe, expect, it } from "vitest";

import { normalizeApexSettings } from "../src/plugin/apex-settings.js";

describe("Apex integration settings", () => {
  it("normalizes workspace identity without dropping future settings", () => {
    const settings = normalizeApexSettings({
      dashboardFile: "/boards/focus.md",
      workspaceFiles: ["boards/home", "/boards/focus.md", "boards/home.md"],
      workspaceNames: ["Home", "Focus", "duplicate"],
      futureUpstreamFlag: { enabled: true },
    });

    expect(settings.dashboardFile).toBe("boards/focus");
    expect(settings.workspaceFiles).toEqual(["boards/home", "boards/focus"]);
    expect(settings.workspaceNames).toEqual(["Home", "Focus"]);
    expect((settings as unknown as Record<string, unknown>).futureUpstreamFlag).toEqual({ enabled: true });
  });

  it("keeps Apex native-widget defaults in the Apex namespace", () => {
    const settings = normalizeApexSettings(undefined);

    expect(settings.widgetHabitEnabled).toBe(false);
    expect(settings.widgetExpenseEnabled).toBe(false);
    expect(settings.readingEnabled).toBe(false);
    expect(settings.dashboardFile).toBe("dashboard");
    expect(settings.calendarTaskFilter).toBe("formal");
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_COMMAND_ID,
  DASHBOARD_PLUGIN_ID,
  DASHBOARD_RIBBON_ICON,
  DASHBOARD_RIBBON_STORAGE_KEY,
  DASHBOARD_RIBBON_TITLE,
  registerDashboardRibbon,
} from "../src/plugin/dashboard-ribbon.js";

describe("Dashboard ribbon entry", () => {
  it("keeps the manifest id aligned with Obsidian's persisted ribbon identity", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
    ) as { id?: string };

    expect(manifest.id).toBe(DASHBOARD_PLUGIN_ID);
    expect(DASHBOARD_COMMAND_ID).toBe("open-dashboard");
    expect(DASHBOARD_RIBBON_STORAGE_KEY).toBe(
      "okf-workspace-dashboard:打开 Dashboard",
    );
  });

  it("registers a recognizable left-ribbon action that opens the Dashboard", () => {
    const addClass = vi.fn();
    const setAttribute = vi.fn();
    const ribbon = {
      classList: { add: addClass },
      dataset: {} as DOMStringMap,
      setAttribute,
    } as unknown as HTMLElement;
    const addRibbonIcon = vi.fn<
      (icon: string, title: string, callback: (event: MouseEvent) => unknown) => HTMLElement
    >(() => ribbon);
    const openDashboard = vi.fn();

    const registered = registerDashboardRibbon(
      { addRibbonIcon } as Parameters<typeof registerDashboardRibbon>[0],
      openDashboard,
    );

    expect(registered).toBe(ribbon);
    expect(addRibbonIcon).toHaveBeenCalledWith(
      DASHBOARD_RIBBON_ICON,
      DASHBOARD_RIBBON_TITLE,
      openDashboard,
    );
    expect(addClass).toHaveBeenCalledWith("okf-workspace-dashboard-ribbon");
    expect(ribbon.dataset.okfEntrypoint).toBe("dashboard");
    expect(setAttribute).toHaveBeenCalledWith("aria-label", DASHBOARD_RIBBON_TITLE);

    const callback = addRibbonIcon.mock.calls[0]?.[2];
    callback?.({} as MouseEvent);
    expect(openDashboard).toHaveBeenCalledOnce();
  });
});

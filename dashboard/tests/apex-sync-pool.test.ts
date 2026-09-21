import type { App } from "obsidian";
import { describe, expect, it } from "vitest";

import { acquireSyncEngine } from "../apex/src/sync.js";
import { DEFAULT_SETTINGS } from "../apex/src/types.js";

describe("Apex board sync pool", () => {
  it("shares one engine per board path while isolating different workbenches", async () => {
    const app = {} as App;
    const settings = {
      ...DEFAULT_SETTINGS,
      workspaceFiles: ["boards/one", "boards/two"],
      dashboardFile: "boards/one",
    };
    const oneA = acquireSyncEngine(app, settings, "boards/one");
    const oneB = acquireSyncEngine(app, settings, "boards/one.md");
    const two = acquireSyncEngine(app, settings, "boards/two");

    expect(oneA.engine).toBe(oneB.engine);
    expect(two.engine).not.toBe(oneA.engine);

    await oneA.release();
    await oneB.release();
    await two.release();
  });
});

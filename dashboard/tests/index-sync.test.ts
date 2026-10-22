import { describe, expect, it } from "vitest";

import { IndexSyncCoordinator } from "../src/plugin/index-sync.js";

describe("IndexSyncCoordinator", () => {
  it("merges pending paths and preserves them after a failed synchronization", async () => {
    const observed: Array<readonly string[] | undefined> = [];
    let fail = true;
    const coordinator = new IndexSyncCoordinator(async (paths) => {
      observed.push(paths);
      if (fail) throw new Error("offline");
    });
    await expect(coordinator.request(["old.md", "new.md"])).rejects.toThrow("offline");
    fail = false;
    await coordinator.request(["another.md"]);
    expect(new Set(observed[1])).toEqual(new Set(["old.md", "new.md", "another.md"]));
    await coordinator.request();
    expect(observed[2]).toBeUndefined();
  });
  it("coalesces requests made during one active synchronization", async () => {
    const releases: (() => void)[] = [];
    let calls = 0;
    const coordinator = new IndexSyncCoordinator(async () => {
      calls += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    const first = coordinator.request();
    const second = coordinator.request();
    const third = coordinator.request();
    expect(calls).toBe(1);
    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    releases.shift()?.();
    await Promise.all([first, second, third]);
    expect(calls).toBe(2);
  });
});

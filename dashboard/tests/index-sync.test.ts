import { describe, expect, it } from "vitest";

import { IndexSyncCoordinator } from "../src/plugin/index-sync.js";

describe("IndexSyncCoordinator", () => {
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

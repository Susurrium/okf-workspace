import { describe, expect, it, vi } from "vitest";

import { showChineseCalendar } from "../src/plugin/chinese-calendar.js";

describe("showChineseCalendar", () => {
  it("reveals an existing calendar leaf without running the creation command", async () => {
    const leaf = { id: "calendar" };
    const reveal = vi.fn(async () => undefined);
    const executeCreateCommand = vi.fn(() => true);

    await expect(showChineseCalendar({
      leaves: () => [leaf],
      reveal,
      executeCreateCommand,
      pluginEnabled: true,
    })).resolves.toBe("revealed");
    expect(reveal).toHaveBeenCalledWith(leaf);
    expect(executeCreateCommand).not.toHaveBeenCalled();
  });

  it("creates and reveals the view when no calendar leaf exists", async () => {
    const leaves: { id: string }[] = [];
    const reveal = vi.fn(async () => undefined);

    await expect(showChineseCalendar({
      leaves: () => leaves,
      reveal,
      executeCreateCommand: () => {
        leaves.push({ id: "created" });
        return true;
      },
      pluginEnabled: true,
    })).resolves.toBe("created");
    expect(reveal).toHaveBeenCalledWith({ id: "created" });
  });

  it("waits for an asynchronously created calendar leaf before revealing it", async () => {
    const leaves: { id: string }[] = [];
    const reveal = vi.fn(async () => undefined);
    let attempts = 0;

    await expect(showChineseCalendar({
      leaves: () => leaves,
      reveal,
      executeCreateCommand: () => true,
      pluginEnabled: true,
      creationAttempts: 4,
      afterCreate: async () => {
        attempts += 1;
        if (attempts === 3) leaves.push({ id: "async-created" });
      },
    })).resolves.toBe("created");
    expect(attempts).toBe(3);
    expect(reveal).toHaveBeenCalledWith({ id: "async-created" });
  });

  it("reports creation success without a real view as an error", async () => {
    await expect(showChineseCalendar({
      leaves: () => [],
      reveal: async () => undefined,
      executeCreateCommand: () => true,
      pluginEnabled: true,
      creationAttempts: 2,
      afterCreate: async () => undefined,
    })).rejects.toThrow("日历视图没有出现");
  });

  it("reports a disabled plugin accurately", async () => {
    await expect(showChineseCalendar({
      leaves: () => [],
      reveal: async () => undefined,
      executeCreateCommand: () => false,
      pluginEnabled: false,
    })).rejects.toThrow("Chinese Calendar 未启用");
  });
});

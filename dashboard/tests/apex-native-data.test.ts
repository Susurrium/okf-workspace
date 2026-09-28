import type { App } from "obsidian";
import { describe, expect, it } from "vitest";

import {
  APEX_NATIVE_DATA_FILES,
  readLegacyApexSettings,
  takeoverApexNativeData,
} from "../src/adapters/apex-native-data.js";
import { registerApexHost } from "../apex/src/host.js";
import { WereadProgressStore } from "../apex/src/weread-progress-store.js";

class MemoryAdapter {
  public readonly files = new Map<string, string>();
  public readonly directories = new Set<string>([".obsidian/plugins/okf-workspace-dashboard"]);

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(source: string, target: string): Promise<void> {
    const value = await this.read(source);
    if (this.files.has(target)) throw new Error(`target exists ${target}`);
    this.files.set(target, value);
    this.files.delete(source);
  }
}

function app(adapter: MemoryAdapter): App {
  return {
    vault: { configDir: ".obsidian", adapter },
  } as unknown as App;
}

describe("Apex native data takeover", () => {
  it("copies each existing JSON byte-for-byte and leaves the legacy files untouched", async () => {
    const adapter = new MemoryAdapter();
    for (const [index, file] of APEX_NATIVE_DATA_FILES.entries()) {
      adapter.files.set(`.obsidian/plugins/apex-dashboard/${file}`, ` {\"file\":${index}}\n`);
    }

    const receipt = await takeoverApexNativeData(app(adapter), "okf-workspace-dashboard", new Date("2026-09-21T00:00:00Z"));

    expect(receipt.entries.every((entry) => entry.status === "copied")).toBe(true);
    for (const file of APEX_NATIVE_DATA_FILES) {
      expect(adapter.files.get(`.obsidian/plugins/okf-workspace-dashboard/${file}`))
        .toBe(adapter.files.get(`.obsidian/plugins/apex-dashboard/${file}`));
    }
    expect(adapter.files.get(".obsidian/plugins/okf-workspace-dashboard/apex-native-data-takeover.json"))
      .toContain('"sourcePluginId": "apex-dashboard"');
  });

  it("never overwrites a target changed after takeover and remains idempotent", async () => {
    const adapter = new MemoryAdapter();
    const source = ".obsidian/plugins/apex-dashboard/habits.json";
    const target = ".obsidian/plugins/okf-workspace-dashboard/habits.json";
    adapter.files.set(source, "legacy");
    adapter.files.set(target, "manual-target-edit");

    const first = await takeoverApexNativeData(app(adapter), "okf-workspace-dashboard");
    const second = await takeoverApexNativeData(app(adapter), "okf-workspace-dashboard");

    expect(first.entries.find((entry) => entry.file === "habits.json")?.status).toBe("target-kept");
    expect(second.entries.find((entry) => entry.file === "habits.json")?.status).toBe("target-kept");
    expect(adapter.files.get(target)).toBe("manual-target-edit");
    expect(adapter.files.get(source)).toBe("legacy");
  });

  it("keeps takeover results stable while refreshing the diagnostic completion timestamp", async () => {
    const adapter = new MemoryAdapter();
    const source = ".obsidian/plugins/apex-dashboard/habits.json";
    const target = ".obsidian/plugins/okf-workspace-dashboard/habits.json";
    const receiptPath = ".obsidian/plugins/okf-workspace-dashboard/apex-native-data-takeover.json";
    adapter.files.set(source, "{\"version\":1,\"entries\":{}}\n");

    const first = await takeoverApexNativeData(app(adapter), "okf-workspace-dashboard", new Date("2026-09-28T00:00:00Z"));
    const firstRaw = adapter.files.get(receiptPath)!;
    const targetBeforeRetry = adapter.files.get(target);
    const second = await takeoverApexNativeData(app(adapter), "okf-workspace-dashboard", new Date("2026-09-28T01:00:00Z"));
    const secondRaw = adapter.files.get(receiptPath)!;
    const stableReceipt = (raw: string): Record<string, unknown> => {
      const receipt = JSON.parse(raw) as Record<string, unknown>;
      delete receipt.completedAt;
      receipt.entries = (receipt.entries as Record<string, unknown>[]).map((entry) => ({
        ...entry,
        status: entry.status === "copied" || entry.status === "already-copied"
          ? "target-present"
          : entry.status,
      }));
      return receipt;
    };

    expect(first.completedAt).not.toBe(second.completedAt);
    expect(firstRaw).not.toBe(secondRaw);
    expect(stableReceipt(secondRaw)).toEqual(stableReceipt(firstRaw));
    expect(adapter.files.get(target)).toBe(targetBeforeRetry);
    expect(second.entries).toEqual(first.entries.map((entry) => ({
      ...entry,
      status: entry.status === "copied" ? "already-copied" : entry.status,
    })));
  });

  it("resumes a verified temporary copy after interruption", async () => {
    const adapter = new MemoryAdapter();
    const source = ".obsidian/plugins/apex-dashboard/reading.json";
    const target = ".obsidian/plugins/okf-workspace-dashboard/reading.json";
    adapter.files.set(source, "reading-history");
    adapter.files.set(`${target}.takeover.tmp`, "reading-history");

    const receipt = await takeoverApexNativeData(app(adapter), "okf-workspace-dashboard");

    expect(receipt.entries.find((entry) => entry.file === "reading.json")?.status).toBe("copied");
    expect(adapter.files.get(target)).toBe("reading-history");
    expect(adapter.files.has(`${target}.takeover.tmp`)).toBe(false);
  });

  it("reads old flat Apex settings without modifying them", async () => {
    const adapter = new MemoryAdapter();
    const path = ".obsidian/plugins/apex-dashboard/data.json";
    adapter.files.set(path, '{"stylePreset":"nordic","musicVolume":0.4}');

    await expect(readLegacyApexSettings(app(adapter))).resolves.toEqual({
      stylePreset: "nordic",
      musicVolume: 0.4,
    });
    expect(adapter.files.get(path)).toBe('{"stylePreset":"nordic","musicVolume":0.4}');
  });

  it("routes WeRead progress through the registered unified host directory", async () => {
    const adapter = new MemoryAdapter();
    adapter.files.set(
      ".obsidian/plugins/okf-workspace-dashboard/weread-progress.json",
      JSON.stringify({
        version: 1,
        entries: {
          book: { progress: 42, readingState: "reading", ts: 1_799_990_000_000 },
        },
      }),
    );
    registerApexHost({ manifest: { id: "okf-workspace-dashboard" } } as never);
    try {
      const store = new WereadProgressStore(app(adapter));
      await store.load();
      expect(store.entry("book")?.progress).toBe(42);
    } finally {
      registerApexHost(null);
    }
  });
});

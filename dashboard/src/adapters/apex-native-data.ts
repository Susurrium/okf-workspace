import type { App } from "obsidian";

export const LEGACY_APEX_PLUGIN_ID = "apex-dashboard";
export const APEX_NATIVE_DATA_FILES = [
  "habits.json",
  "expense.json",
  "pomodoro.json",
  "reading.json",
  "weread-progress.json",
] as const;

export type ApexNativeDataFile = typeof APEX_NATIVE_DATA_FILES[number];
export type ApexNativeTakeoverStatus =
  | "copied"
  | "already-copied"
  | "target-kept"
  | "source-missing";

export interface ApexNativeTakeoverEntry {
  file: ApexNativeDataFile;
  status: ApexNativeTakeoverStatus;
  sourceBytes?: number;
  targetBytes?: number;
}

export interface ApexNativeTakeoverReceipt {
  version: 1;
  sourcePluginId: typeof LEGACY_APEX_PLUGIN_ID;
  targetPluginId: string;
  completedAt: string;
  entries: ApexNativeTakeoverEntry[];
}

const RECEIPT_FILE = "apex-native-data-takeover.json";

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function pluginDirectory(app: App, pluginId: string): string {
  return `${app.vault.configDir}/plugins/${pluginId}`;
}

async function ensureDirectory(app: App, path: string): Promise<void> {
  if (!(await app.vault.adapter.exists(path))) await app.vault.adapter.mkdir(path);
}

/**
 * Copy each Apex-owned JSON file byte-for-byte into the unified plugin data
 * directory. Existing targets always win, so a retry never overwrites edits
 * made after takeover. A verified temporary file makes interruption resumable.
 */
export async function takeoverApexNativeData(
  app: App,
  targetPluginId: string,
  now = new Date(),
): Promise<ApexNativeTakeoverReceipt> {
  const adapter = app.vault.adapter;
  const sourceDirectory = pluginDirectory(app, LEGACY_APEX_PLUGIN_ID);
  const targetDirectory = pluginDirectory(app, targetPluginId);
  await ensureDirectory(app, targetDirectory);
  const entries: ApexNativeTakeoverEntry[] = [];

  for (const file of APEX_NATIVE_DATA_FILES) {
    const source = `${sourceDirectory}/${file}`;
    const target = `${targetDirectory}/${file}`;
    const temporary = `${target}.takeover.tmp`;
    if (!(await adapter.exists(source))) {
      entries.push({ file, status: "source-missing" });
      continue;
    }
    const sourceRaw = await adapter.read(source);
    if (await adapter.exists(target)) {
      const targetRaw = await adapter.read(target);
      entries.push({
        file,
        status: targetRaw === sourceRaw ? "already-copied" : "target-kept",
        sourceBytes: utf8Bytes(sourceRaw),
        targetBytes: utf8Bytes(targetRaw),
      });
      continue;
    }

    if (await adapter.exists(temporary)) {
      const pending = await adapter.read(temporary);
      if (pending !== sourceRaw) await adapter.remove(temporary);
    }
    if (!(await adapter.exists(temporary))) await adapter.write(temporary, sourceRaw);
    const verified = await adapter.read(temporary);
    if (verified !== sourceRaw) {
      throw new Error(`Apex 原数据接管校验失败：${file}`);
    }
    if (await adapter.exists(target)) {
      await adapter.remove(temporary);
      const targetRaw = await adapter.read(target);
      entries.push({
        file,
        status: targetRaw === sourceRaw ? "already-copied" : "target-kept",
        sourceBytes: utf8Bytes(sourceRaw),
        targetBytes: utf8Bytes(targetRaw),
      });
      continue;
    }
    await adapter.rename(temporary, target);
    const copied = await adapter.read(target);
    if (copied !== sourceRaw) throw new Error(`Apex 原数据接管落盘校验失败：${file}`);
    entries.push({ file, status: "copied", sourceBytes: utf8Bytes(sourceRaw), targetBytes: utf8Bytes(copied) });
  }

  const receipt: ApexNativeTakeoverReceipt = {
    version: 1,
    sourcePluginId: LEGACY_APEX_PLUGIN_ID,
    targetPluginId,
    completedAt: now.toISOString(),
    entries,
  };
  await adapter.write(`${targetDirectory}/${RECEIPT_FILE}`, JSON.stringify(receipt, null, 2));
  return receipt;
}

/** Read the legacy Apex settings without mutating its data.json. */
export async function readLegacyApexSettings(app: App): Promise<unknown | undefined> {
  const path = `${pluginDirectory(app, LEGACY_APEX_PLUGIN_ID)}/data.json`;
  if (!(await app.vault.adapter.exists(path))) return undefined;
  const raw = await app.vault.adapter.read(path);
  return JSON.parse(raw) as unknown;
}

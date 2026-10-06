import type { App } from "obsidian";

interface LiveSyncPort {
  core?: {
    settings?: { syncMaxSizeInMB?: number };
    services?: { setting?: {
      applyPartial?: (settings: { syncMaxSizeInMB: number }) => Promise<unknown>;
      saveSettingData?: () => Promise<unknown>;
    } };
  };
}

/** Align the installed LiveSync's local attachment limit with document intake. */
export async function ensureDocumentSyncCapacity(app: App): Promise<void> {
  const manager = (app as App & { plugins?: {
    getPlugin?: (id: string) => unknown;
    plugins?: Record<string, unknown>;
  } }).plugins;
  const plugin = (manager?.getPlugin?.("obsidian-livesync")
    ?? manager?.plugins?.["obsidian-livesync"]) as LiveSyncPort | undefined;
  const maximum = plugin?.core?.settings?.syncMaxSizeInMB;
  // Zero means unlimited. Preserve larger limits and unknown plugin versions.
  if (maximum === undefined || maximum === 0 || maximum >= 64) return;
  const setting = plugin?.core?.services?.setting;
  if (!setting?.applyPartial || !setting.saveSettingData) {
    throw new Error(`请将 LiveSync 的单文件同步上限从 ${maximum} MiB 改为至少 64 MiB 后提交`);
  }
  await setting.applyPartial({ syncMaxSizeInMB: 64 });
  await setting.saveSettingData();
}

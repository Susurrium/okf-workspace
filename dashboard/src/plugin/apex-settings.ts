import {
  DEFAULT_SETTINGS as DEFAULT_APEX_SETTINGS,
  type DashboardSettings as ApexDashboardSettings,
} from "../../apex/src/types.js";
import { migrateWorkspaces } from "../../apex/src/workspace-registry.js";

export function assertApexSettingsPersisted(stored: unknown, expectedJson: string): void {
  if (JSON.stringify((stored as { apex?: unknown } | null)?.apex) !== expectedJson) {
    throw new Error('工作台设置尚未实际保存到磁盘，请检查设置目录后重试。');
  }
}

export async function resolveApexStartupSettings(raw: unknown, readLegacy: () => Promise<unknown>): Promise<{
  settings: unknown; firstInstall: boolean; importedLegacy: boolean;
}> {
  const current = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).apex : undefined;
  if (current && typeof current === 'object') return { settings: current, firstInstall: false, importedLegacy: false };
  const legacy = await readLegacy();
  if (legacy !== undefined && (!legacy || typeof legacy !== 'object' || Array.isArray(legacy))) throw new Error('旧 Apex 设置格式无效');
  return { settings: legacy, firstInstall: raw == null && legacy === undefined, importedLegacy: legacy !== undefined };
}

function sanitizeMediaTags(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [path, tags] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(tags)) continue;
    const normalized = [...new Set(tags
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0 && tag.length <= 40))]
      .sort((left, right) => left.localeCompare(right));
    if (normalized.length > 0) result[path] = normalized;
  }
  return result;
}

/** Preserve future Apex fields while normalizing the values needed at startup. */
export function normalizeApexSettings(value: unknown, firstInstall = false): ApexDashboardSettings {
  const raw = value && typeof value === "object"
    ? value as Record<string, unknown> & Partial<ApexDashboardSettings>
    : {};
  const workspace = migrateWorkspaces(raw);
  return {
    ...DEFAULT_APEX_SETTINGS,
    ...(firstInstall ? { quickNotesEnabled: true, quickCaptureEnabled: true } : {}),
    ...raw,
    countdowns: Array.isArray(raw.countdowns) ? raw.countdowns : [...DEFAULT_APEX_SETTINGS.countdowns],
    mediaTags: sanitizeMediaTags(raw.mediaTags),
    workspaceFiles: workspace.files,
    workspaceNames: workspace.names,
    dashboardFile: workspace.active,
  };
}

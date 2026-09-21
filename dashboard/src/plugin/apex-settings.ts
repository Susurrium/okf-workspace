import {
  DEFAULT_SETTINGS as DEFAULT_APEX_SETTINGS,
  type DashboardSettings as ApexDashboardSettings,
} from "../../apex/src/types.js";
import { migrateWorkspaces } from "../../apex/src/workspace-registry.js";

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
export function normalizeApexSettings(value: unknown): ApexDashboardSettings {
  const raw = value && typeof value === "object"
    ? value as Record<string, unknown> & Partial<ApexDashboardSettings>
    : {};
  const workspace = migrateWorkspaces(raw);
  return {
    ...DEFAULT_APEX_SETTINGS,
    ...raw,
    countdowns: Array.isArray(raw.countdowns) ? raw.countdowns : [...DEFAULT_APEX_SETTINGS.countdowns],
    mediaTags: sanitizeMediaTags(raw.mediaTags),
    workspaceFiles: workspace.files,
    workspaceNames: workspace.names,
    dashboardFile: workspace.active,
  };
}

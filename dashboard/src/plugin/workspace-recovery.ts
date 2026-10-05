import type { DataAdapter } from "obsidian";
import { parseDocument } from "yaml";

import { normalizeWorkspacePath } from "../../apex/src/workspace-registry.js";

/** Recover a lost registry before the view can create a new default board.
 * Read the adapter directly: the metadata/file cache may be cold during startup.
 * Explicit paths remain authoritative, including files still waiting for sync.
 */
export async function recoverWorkspaceRegistry(
  value: unknown,
  adapter: Pick<DataAdapter, "list" | "read">,
): Promise<{ settings: Record<string, unknown>; recovered: boolean }> {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (normalizeWorkspacePath(raw.dashboardFile) ||
    (Array.isArray(raw.workspaceFiles) && raw.workspaceFiles.some(normalizeWorkspacePath))) {
    return { settings: raw, recovered: false };
  }

  const paths: string[] = [];
  async function scan(folder: string): Promise<void> {
    // Propagate I/O failures instead of treating an incomplete scan as an empty Vault.
    const listing = await adapter.list(folder);
    for (const path of listing.files) {
      if (!path.toLowerCase().endsWith(".md") || path === "index.md") continue;
      const markdown = await adapter.read(path);
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown)?.[1];
      if (!frontmatter) continue;
      const document = parseDocument(frontmatter);
      if (document.errors.length) continue;
      const data: unknown = document.toJS();
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      const record = data as Record<string, unknown>;
      if (record.dashboard !== true) continue;
      if (record.type != null && record.type !== "") continue;
      const schema = record.workbench_schema;
      if (schema !== undefined && !(typeof schema === "number" && Number.isInteger(schema) && schema > 0)) continue;
      paths.push(normalizeWorkspacePath(path));
    }
    for (const child of listing.folders) {
      if (child.split("/").some((part) => part.startsWith("."))) continue;
      await scan(child);
    }
  }
  await scan("");
  paths.sort();
  if (!paths.length) return { settings: raw, recovered: false };
  return {
    settings: {
      ...raw,
      dashboardFile: paths.includes("dashboard") ? "dashboard" : paths[0],
      workspaceFiles: paths,
      workspaceNames: paths.map(() => ""),
    },
    recovered: true,
  };
}

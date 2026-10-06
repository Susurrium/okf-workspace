import { TFile, type App } from "obsidian";
import { documentFields } from "./synced-intake.js";

export interface OriginalReference { digest: string; filename: string; path?: string }

export function originalReference(resource: unknown): OriginalReference | undefined {
  if (typeof resource !== "string") return undefined;
  const local = /^\/?(sources\/originals\/([0-9a-f]{64})\/([^/\\]+))$/u.exec(resource);
  if (local && ![".", ".."].includes(local[3]!)) {
    return { digest: local[2]!, filename: local[3]!, path: local[1]! };
  }
  const match = /^okf-original:\/\/sha256\/([0-9a-f]{64})\/([^/?#]+)$/u.exec(resource);
  if (!match) return undefined;
  try {
    const filename = decodeURIComponent(match[2]!);
    if (/[<>:"/\\|?*\u0000-\u001f]/u.test(filename)) return undefined;
    return { digest: match[1]!, filename };
  } catch { return undefined; }
}

/** Follow actual Source links, not indexes or transient conversion receipts. */
export async function originalsForNote(app: App, notePath: string): Promise<OriginalReference[]> {
  const pending = [notePath];
  const visited = new Set<string>();
  const results = new Map<string, OriginalReference>();
  while (pending.length && visited.size < 64) {
    const path = pending.shift()!.replace(/^\//u, "");
    if (visited.has(path) || path.split("/").some((part) => !part || part === ".." || part === "." || /[:\\]/u.test(part))) continue;
    visited.add(path);
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !path.endsWith(".md")) continue;
    const fields = documentFields(await app.vault.cachedRead(file));
    const direct = originalReference(fields.resource);
    if (direct) results.set(direct.digest, direct);
    const sources = Array.isArray(fields.sources) ? fields.sources : [];
    for (const entry of sources) {
      const resource: unknown = entry && typeof entry === "object" ? entry.resource : entry;
      const original = originalReference(resource);
      if (original) results.set(original.digest, original);
      else if (typeof resource === "string" && resource.startsWith("/") && !resource.startsWith("//")) pending.push(resource);
    }
  }
  return [...results.values()];
}

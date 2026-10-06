import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { OriginalFiles } from "../src/plugin/original-files.js";
import { originalsForNote } from "../src/imports/original-references.js";
import { TFile } from "./obsidian-runtime.js";

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<object>(), FileSystemAdapter: class {},
}));

vi.mock("../src/plugin/prompts.js", () => ({ ChoiceModal: class {} }));

describe("native Obsidian original reading", () => {
  it("opens a synced PDF through a Source Text link without Engine, network or an external app", async () => {
    const digest = "a".repeat(64);
    const path = `sources/originals/${digest}/课件.pdf`;
    const texts: Record<string, string> = {
      [`${path}.md`]: "",
      "text.md": "---\nsources:\n  - resource: /source.md\n---\n# Text",
      "source.md": `---\nresource: /${path}\n---\n# Source`,
      [path]: "pdf",
    };
    const openFile = vi.fn(async () => {});
    const app = { vault: {
      adapter: { getResourcePath: () => "fixture" },
      getAbstractFileByPath: (p: string) => p in texts ? new TFile(p) : null,
      getFiles: () => Object.keys(texts).map((p) => new TFile(p)),
      cachedRead: async (file: TFile) => texts[file.path],
    }, workspace: { getLeaf: () => ({ openFile }) } } as unknown as App;
    expect(await originalsForNote(app, "text.md")).toEqual([{ digest, filename: "课件.pdf", path }]);
    const originals = new OriginalFiles(app);
    await originals.openNote("text.md");
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path }));
    // Old protocol links remain readable after migration, even with a renamed title.
    await originals.open({ digest, filename: "old.pdf" });
    expect(openFile).toHaveBeenCalledTimes(2);
    delete texts[path];
    await originals.open({ digest, filename: "old.pdf" });
    expect(openFile).toHaveBeenCalledTimes(2);
  });
});

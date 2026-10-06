import { createRequire } from "node:module";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

describe("mobile plugin loading", () => {
  it("loads the actual bundled plugin without importing a desktop Node module", () => {
    const bundle = buildSync({
      entryPoints: [fileURLToPath(new URL("../src/plugin/main.ts", import.meta.url))],
      bundle: true, format: "cjs", write: false, target: "es2022",
      external: ["obsidian", "@codemirror/state", "@codemirror/view", "node:fs", "node:crypto", "node:child_process"],
    }).outputFiles[0]!.text;
    const nativeRequire = createRequire(import.meta.url);
    const seen: string[] = [];
    const obsidian = new Proxy({}, { get: (_target, name) => name === "Platform"
      ? { isMobile: true, isDesktop: false, isPhone: true } : class {} });
    const module = { exports: {} };
    new Script(bundle).runInNewContext({
      module, exports: module.exports, window: {}, setTimeout, clearTimeout, console, TextEncoder, TextDecoder,
      require: (name: string): unknown => {
        seen.push(name);
        if (name.startsWith("node:")) throw new Error(`Mobile loaded ${name}`);
        return name === "obsidian" ? obsidian : nativeRequire(name);
      },
    });
    expect(seen).not.toContain("node:fs");
    expect(seen).not.toContain("node:crypto");
    expect(seen).not.toContain("node:child_process");
  });
});

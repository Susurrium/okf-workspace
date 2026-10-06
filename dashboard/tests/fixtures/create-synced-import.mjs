// Exercise the actual mobile submission module against a fixture Vault on disk.
import { buildSync } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.argv[2];
const source = process.argv[3];
class TFile { constructor(path) { this.path = path; } }
const result = buildSync({
  entryPoints: [fileURLToPath(new URL("../../src/imports/synced-intake.ts", import.meta.url))],
  bundle: true, format: "cjs", platform: "browser", external: ["obsidian"], write: false,
});
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(
  (id) => id === "obsidian" ? { TFile } : require(id), module, module.exports,
);
const app = { vault: {
  getAbstractFileByPath: (path) => existsSync(join(root, path)) ? new TFile(path) : null,
  getFiles: () => readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => new TFile(join(e.parentPath, e.name).slice(root.length + 1).replaceAll("\\", "/"))),
  readBinary: async (file) => Uint8Array.from(readFileSync(join(root, file.path))).buffer,
  cachedRead: async (file) => readFileSync(join(root, file.path), "utf8"),
  createFolder: async (path) => mkdirSync(join(root, path), { recursive: true }),
  createBinary: async (path, bytes) => writeFileSync(join(root, path), new Uint8Array(bytes)),
  create: async (path, text) => writeFileSync(join(root, path), text, "utf8"),
} };
const saved = await module.exports.saveSyncedDocument(app,
  new File([readFileSync(source)], "手机课件.pdf"),
  { intent: "source", quality: "quick", parser: "auto", method: "auto", generate: false,
    ...(process.argv[4] ? { action: process.argv[4] } : {}) });
process.stdout.write(JSON.stringify(saved));

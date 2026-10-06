// Real legacy writer -> one-way Vault recovery, with no HTTP transport.
import { buildSync } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = process.argv[2];
const source = process.argv[3];
class TFile { constructor(path) { this.path = path; } }
function load(name) {
  const result = buildSync({ entryPoints: [fileURLToPath(new URL(`../../src/imports/${name}.ts`, import.meta.url))],
    bundle: true, format: "cjs", platform: "browser", external: ["obsidian"], write: false });
  const module = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(
    (id) => id === "obsidian" ? { TFile } : require(id), module, module.exports);
  return module.exports;
}
const app = { vault: {
  getAbstractFileByPath: (path) => existsSync(join(root, path)) ? new TFile(path) : null,
  getFiles: () => readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => new TFile(relative(root, join(e.parentPath, e.name)).replaceAll("\\", "/"))),
  readBinary: async (file) => Uint8Array.from(readFileSync(join(root, file.path))).buffer,
  cachedRead: async (file) => readFileSync(join(root, file.path), "utf8"),
  createFolder: async (path) => mkdirSync(join(root, path), { recursive: true }),
  createBinary: async (path, bytes) => writeFileSync(join(root, path), new Uint8Array(bytes)),
  create: async (path, text) => writeFileSync(join(root, path), text, "utf8"),
} };
const records = new Map();
const store = {
  get: async (key) => records.get(key), put: async (key, value) => { records.set(key, value); },
  delete: async (key) => { records.delete(key); },
  keys: async (prefix) => [...records.keys()].filter((key) => key.startsWith(prefix)),
};
const { DocumentOutbox } = load("document-outbox");
const { OriginalCache } = load("original-cache");
const outbox = new DocumentOutbox(app, store, async () => { throw new Error("Retired service must not be called"); }, new OriginalCache(store));
const saved = await outbox.save(new File([readFileSync(source)], "旧平板课件.pdf"),
  { intent: "source", quality: "quick", parser: "auto", method: "auto", generate: false });
const { recoverLegacyUploads } = load("recover-legacy-uploads");
const issues = await recoverLegacyUploads(app, store);
const repeated = await recoverLegacyUploads(app, store);
process.stdout.write(JSON.stringify({ saved, issues, repeated, uploadKeys: await store.keys("upload:") }));

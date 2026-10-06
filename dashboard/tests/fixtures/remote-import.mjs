// Real TypeScript mobile transport against a running file service and a fixture Vault.
import { buildSync } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, vault, devicePath, source, baseUrl, token] = process.argv.slice(2);
const moduleRoot = fileURLToPath(new URL("../../src/imports/", import.meta.url)).replaceAll("\\", "/");
const result = buildSync({
  stdin: { contents: `export { DocumentOutbox } from '${moduleRoot}document-outbox.ts';
    export { OriginalCache } from '${moduleRoot}original-cache.ts';
    export { HttpFileService } from '${moduleRoot}file-service.ts';`, resolveDir: moduleRoot },
  bundle: true, format: "cjs", platform: "browser", external: ["obsidian"], write: false,
});
class TFile { constructor(path) { this.path = path; } }
const requestUrl = async ({ url, method, headers, body }) => {
  const response = await fetch(url, { method, headers, body });
  const bytes = await response.arrayBuffer();
  return { status: response.status, arrayBuffer: bytes,
    get json() { return JSON.parse(new TextDecoder().decode(bytes)); } };
};
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(
  () => ({ TFile, requestUrl }), module, module.exports,
);
const stored = existsSync(devicePath) ? JSON.parse(readFileSync(devicePath, "utf8")) : {};
const persist = () => writeFileSync(devicePath, JSON.stringify(stored));
const device = {
  get: async (key) => stored[key]?.binary
    ? Uint8Array.from(Buffer.from(stored[key].binary, "base64")).buffer : stored[key]?.value,
  put: async (key, value) => {
    stored[key] = value instanceof ArrayBuffer ? { binary: Buffer.from(value).toString("base64") } : { value };
    persist();
  },
  delete: async (key) => { delete stored[key]; persist(); },
  keys: async (prefix) => Object.keys(stored).filter((key) => key.startsWith(prefix)),
};
const app = { vault: {
  getAbstractFileByPath: (path) => existsSync(join(vault, path)) ? new TFile(path) : null,
  createFolder: async (path) => mkdirSync(join(vault, path), { recursive: true }),
  create: async (path, text) => writeFileSync(join(vault, path), text, { encoding: "utf8", flag: "wx" }),
  cachedRead: async (file) => readFileSync(join(vault, file.path), "utf8"),
} };
const remote = new module.exports.HttpFileService({ baseUrl, token, storeId: "fixture-store" });
const cache = new module.exports.OriginalCache(device);
const outbox = new module.exports.DocumentOutbox(app, device, async () => remote, cache);
if (mode === "submit") await outbox.save(new File([readFileSync(source)], "手机课件.pdf"),
  { intent: "source", quality: "quick", parser: "auto", method: "auto", generate: false });
await outbox.flush();
const jobs = await outbox.list();
let downloaded = false;
if (mode === "download") {
  const bytes = await cache.get(jobs[0].digest, async () => remote);
  downloaded = Buffer.from(bytes).equals(readFileSync(source));
}
process.stdout.write(JSON.stringify({ jobs, uploadKeys: await device.keys("upload:"), downloaded,
  vaultFiles: readdirSync(vault, { recursive: true }).filter((path) => String(path).endsWith(".pdf")) }));

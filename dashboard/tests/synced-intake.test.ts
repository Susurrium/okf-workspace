import { createHash } from "node:crypto";
import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { listSyncedImports, saveSyncedDocument } from "../src/imports/synced-intake.js";
import { ensureDocumentSyncCapacity } from "../src/imports/sync-capacity.js";
import { recoverLegacyUploads } from "../src/imports/recover-legacy-uploads.js";
import type { DeviceStore } from "../src/imports/device-store.js";
import { DocumentImportModal } from "../src/plugin/document-import-modal.js";
import { Platform, TestElement, TFile } from "./obsidian-runtime.js";

function vaultFixture() {
  const files = new Map<string, string | ArrayBuffer>();
  const folders = new Set<string>();
  const writes: string[] = [];
  const app = { vault: {
    getAbstractFileByPath: (path: string) => files.has(path) ? new TFile(path) : folders.has(path) ? {} : null,
    createFolder: async (path: string) => { folders.add(path); },
    createBinary: async (path: string, bytes: ArrayBuffer) => { files.set(path, bytes); writes.push(path); },
    create: async (path: string, text: string) => { files.set(path, text); writes.push(path); },
    getMarkdownFiles: () => [...files.keys()].filter((path) => path.endsWith(".md")).map((path) => new TFile(path)),
    getFiles: () => [...files.keys()].map((path) => new TFile(path)),
    readBinary: async (file: TFile) => files.get(file.path) as ArrayBuffer,
    cachedRead: async (file: TFile) => String(files.get(file.path)),
  } } as unknown as App;
  return { app, files, writes };
}

const options = { intent: "source", quality: "quick", parser: "auto", method: "auto", generate: false } as const;

describe("Vault-native document submissions", () => {
  it("ignores Markdown sidecars when locating an original", async () => {
    const { app, files } = vaultFixture();
    const digest = createHash("sha256").update("pdf").digest("hex");
    files.set(`sources/originals/${digest}/lecture.pdf.md`, "");
    const saved = await saveSyncedDocument(app, new File(["pdf"], "lecture.pdf"), { ...options, action: "store" });
    expect(saved.saved_path).toBe(`sources/originals/${digest}/lecture.pdf`);
    expect(files.has(`sources/originals/${digest}/lecture.pdf.md`)).toBe(true);
  });
  it("stores a complete original without any conversion parameters and offers it immediately", async () => {
    const { app, files } = vaultFixture();
    const result = await saveSyncedDocument(app, new File(["pdf"], "lecture.pdf"), { ...options, action: "store" });
    const fields = parseYaml(String(files.get(result.request_path)).split("---")[1]!) as Record<string, unknown>;
    expect(fields).toMatchObject({ action: "store", request_version: 4 });
    for (const field of ["quality", "method", "parser", "generate"]) expect(fields).not.toHaveProperty(field);
    expect(await listSyncedImports(app)).toMatchObject([{ status: "stored", action: "store" }]);
    await saveSyncedDocument(app, new File(["pdf"], "lecture.pdf"), { ...options, action: "convert" });
    expect(await listSyncedImports(app)).toMatchObject([{ status: "saved-local", action: "convert" }]);
    expect([...files.keys()].filter((path) => path.endsWith(".pdf"))).toHaveLength(1);
  });
  it("raises LiveSync's local file limit without changing other sync settings", async () => {
    const applyPartial = vi.fn(async () => {});
    const saveSettingData = vi.fn(async () => {});
    const app = { plugins: { getPlugin: () => ({ core: {
      settings: { syncMaxSizeInMB: 50 }, services: { setting: { applyPartial, saveSettingData } },
    } }) } } as unknown as App;
    await ensureDocumentSyncCapacity(app);
    expect(applyPartial).toHaveBeenCalledWith({ syncMaxSizeInMB: 64 });
    expect(saveSettingData).toHaveBeenCalledOnce();
  });
  it("persists the attachment before the complete immutable request, without an Engine", async () => {
    const { app, files, writes } = vaultFixture();
    const contents = "%PDF-1.7 mobile";
    const result = await saveSyncedDocument(app, new File([contents], "课件.pdf"), options);
    expect(writes).toEqual([result.saved_path, result.request_path]);
    const text = String(files.get(result.request_path));
    const fields = parseYaml(text.split("---")[1]!) as Record<string, unknown>;
    expect(fields.file_sha256).toBe(createHash("sha256").update(contents).digest("hex"));
    expect(fields.size_bytes).toBe(new TextEncoder().encode(contents).length);
    expect(fields.method).toBe("auto");
    expect(fields.generate).toBe(false);
    expect(fields.file).toBe(`/${result.saved_path}`);
    expect(await listSyncedImports(app)).toMatchObject([{ status: "saved-local", filename: "课件.pdf" }]);
  });

  it("keeps same-name submissions separate and persists course selection", async () => {
    const { app, files } = vaultFixture();
    files.set("learning/courses/mobile/course.md", "# Course");
    const first = await saveSyncedDocument(app, new File(["first"], "lecture.pdf"), { ...options, course: "mobile" });
    const second = await saveSyncedDocument(app, new File(["second"], "lecture.pdf"), options);
    expect(first.saved_path).not.toBe(second.saved_path);
    const fields = parseYaml(String(files.get(first.request_path)).split("---")[1]!) as Record<string, unknown>;
    expect(fields.course).toBe("/learning/courses/mobile/course.md");
    expect(await listSyncedImports(app)).toHaveLength(2);
  });

  it("reuses verified originals for repeated imports without replacing changed bytes", async () => {
    const { app, files } = vaultFixture();
    const first = await saveSyncedDocument(app, new File(["same"], "one.pdf"), options);
    const second = await saveSyncedDocument(app, new File(["same"], "renamed.pdf"), options);
    expect(first.saved_path).toBe(second.saved_path);
    expect(first.request_path).not.toBe(second.request_path);
    expect([...files.keys()].filter((path) => path.endsWith(".pdf"))).toHaveLength(1);
    files.set(first.saved_path, new TextEncoder().encode("human annotation").buffer);
    await expect(saveSyncedDocument(app, new File(["same"], "one.pdf"), options)).rejects.toThrow("校验值");
    expect(new TextDecoder().decode(files.get(first.saved_path) as ArrayBuffer)).toBe("human annotation");
  });

  it("recovers old pending uploads without contacting a server or creating a second request", async () => {
    const { app, files } = vaultFixture();
    const records = new Map<string, unknown>();
    const store: DeviceStore = {
      get: async <T>(key: string) => records.get(key) as T | undefined,
      put: async (key, value) => { records.set(key, value); },
      delete: async (key) => { records.delete(key); },
      keys: async (prefix) => [...records.keys()].filter((key) => key.startsWith(prefix)),
    };
    const id = crypto.randomUUID();
    const bytes = new TextEncoder().encode("old upload").buffer;
    const digest = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
    const job = { id, digest, filename: "旧课件.pdf", size: bytes.byteLength, options,
      createdAt: "2026-10-05T00:00:00Z", stage: "submitted" };
    records.set(`upload:${id}`, bytes);
    records.set(`outbox:${id}`, job);
    const request = `system/imports/${id}/request.md`;
    const originalText = `---\ntype: Document Import Request\nrequest_id: ${id}\nfile_sha256: ${digest}\ntransport: file-store\n---\n人工备注\n`;
    files.set(request, originalText);
    expect(await recoverLegacyUploads(app, store)).toEqual([]);
    expect(records.has(`upload:${id}`)).toBe(false);
    expect(files.get(request)).toBe(originalText);
    expect([...files.keys()].filter((path) => path.endsWith(".pdf"))).toHaveLength(1);
    expect(await recoverLegacyUploads(app, store)).toEqual([]);
    // An altered request must not release another pending upload.
    const another = crypto.randomUUID();
    records.set(`upload:${another}`, bytes);
    records.set(`outbox:${another}`, { ...job, id: another });
    files.set(`system/imports/${another}/request.md`, "---\nrequest_id: changed\n---\n");
    expect(await recoverLegacyUploads(app, store)).toHaveLength(1);
    expect(records.has(`upload:${another}`)).toBe(true);
  });

  it("displays returned receipt links while filtering non-Vault paths", async () => {
    const { app, files } = vaultFixture();
    const saved = await saveSyncedDocument(app, new File(["doc"], "lecture.pdf"), options);
    files.set(saved.request_path.replace("request.md", "receipt.md"),
      `---\ntype: Document Import Receipt\nrequest_id: ${saved.request_id}\nprocessing_status: imported\nmessage: 转换完成\noutputs:\n  source_text: sources/text/lecture.md\n  routed_target: ../../private.md\n---\n`);
    const entries = await listSyncedImports(app);
    expect(entries[0]).toMatchObject({ status: "imported", message: "转换完成", outputs: { source_text: "sources/text/lecture.md" } });
    expect(entries[0]!.outputs.routed_target).toBeUndefined();
  });

  it("rejects oversize input before reading or writing any bytes", async () => {
    const { app, writes } = vaultFixture();
    const arrayBuffer = vi.fn();
    const file = { name: "large.pdf", size: 64 * 1024 * 1024 + 1, arrayBuffer } as unknown as File;
    await expect(saveSyncedDocument(app, file, options)).rejects.toThrow("64 MiB");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("allows offline mobile submission and shows local persistence instead of conversion success", async () => {
    const { app } = vaultFixture();
    const save = vi.fn((file: File) => saveSyncedDocument(app, file, options));
    Platform.isMobile = true;
    try {
      const modal = new DocumentImportModal(app,
        [{ file: new File(["doc"], "lecture.pdf"), relativePath: "lecture.pdf" }],
        {}, "command", save, undefined, undefined, true);
      modal.open();
      const content = modal.contentEl as unknown as TestElement;
      expect(content.descendants().some((element) => element.textContent === "选择文件夹")).toBe(false);
      content.descendants().find((element) => element.textContent === "保存原件")!.click();
      await vi.waitFor(() => expect(content.descendants().some((element) => element.textContent.includes("已保存 1 个"))).toBe(true));
      expect(save).toHaveBeenCalledOnce();
    } finally { Platform.isMobile = false; }
  });
});

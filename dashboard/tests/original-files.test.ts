import "fake-indexeddb/auto";
import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { IndexedDeviceStore } from "../src/imports/device-store.js";
import { DocumentOutbox, documentFields } from "../src/imports/document-outbox.js";
import { digestBytes, type FileService } from "../src/imports/file-service.js";
import { OriginalCache } from "../src/imports/original-cache.js";
import { originalsForNote } from "../src/imports/original-references.js";
import { TFile } from "./obsidian-runtime.js";

function fixture() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const app = { vault: {
    getAbstractFileByPath: (path: string) => files.has(path) ? new TFile(path) : folders.has(path) ? {} : null,
    createFolder: async (path: string) => { folders.add(path); },
    create: async (path: string, text: string) => { if (files.has(path)) throw new Error("exists"); files.set(path, text); },
    cachedRead: async (file: TFile) => files.get(file.path),
  } } as unknown as App;
  const namespace = crypto.randomUUID();
  const store = new IndexedDeviceStore(namespace);
  const cache = new OriginalCache(store, 12);
  const blobs = new Map<string, ArrayBuffer>();
  const remote: FileService = { storeId: "fixture-store",
    upload: vi.fn(async (digest, bytes) => { expect(await digestBytes(bytes)).toBe(digest); blobs.set(digest, bytes); }),
    download: vi.fn(async (digest) => { const bytes = blobs.get(digest); if (!bytes) throw new Error("offline"); return bytes; }),
  };
  return { app, files, namespace, store, cache, remote, blobs };
}
const options = { intent: "source", quality: "quick", parser: "auto", method: "auto", generate: false } as const;

describe("device-only originals lifecycle", () => {
  it("survives offline save and restart, publishes metadata only, and waits for a matching archive ack", async () => {
    const { app, files, namespace, store, cache, remote } = fixture();
    const offline = new DocumentOutbox(app, store, async () => { throw new Error("offline"); }, cache);
    const saved = await offline.save(new File(["pdf fixture"], "课件.pdf"), options);
    await offline.flush();
    expect(files.size).toBe(0);
    expect((await offline.list())[0]).toMatchObject({ stage: "saved-local", error: "offline" });
    const reopened = new IndexedDeviceStore(namespace);
    const online = new DocumentOutbox(app, reopened, async () => remote, cache);
    await Promise.all([online.flush(), online.flush()]);
    expect(remote.upload).toHaveBeenCalledOnce();
    expect([...files.keys()]).toEqual([saved.request_path]);
    const fields = documentFields(files.get(saved.request_path)!);
    expect(fields).toMatchObject({ transport: "file-store", original_store: remote.storeId });
    expect(fields.file).toBeUndefined();
    expect(await reopened.get(`upload:${saved.request_id}`)).toBeInstanceOf(ArrayBuffer);
    const receiptPath = saved.request_path.replace("request.md", "receipt.md");
    files.set(receiptPath, `---\ntype: Document Import Receipt\nrequest_id: ${saved.request_id}\noriginal_archived: true\nfile_sha256: wrong\n---\n`);
    await online.flush();
    expect(await reopened.get(`upload:${saved.request_id}`)).toBeDefined();
    files.set(receiptPath, files.get(receiptPath)!.replace("wrong", String(fields.file_sha256)));
    await online.flush();
    expect(await reopened.get(`upload:${saved.request_id}`)).toBeUndefined();
    expect((await online.list())[0]!.stage).toBe("archived");
    expect(remote.upload).toHaveBeenCalledOnce();
  });

  it("keeps offline originals when archive acknowledgement arrives before conversion completes", async () => {
    const { app, files, store, cache, remote } = fixture();
    const outbox = new DocumentOutbox(app, store, async () => remote, cache);
    const saved = await outbox.save(new File(["pinned pdf"], "book.pdf"), { ...options, keepOffline: true });
    await outbox.flush();
    const job = (await outbox.list())[0]!;
    files.set(saved.request_path.replace("request.md", "receipt.md"),
      `---\ntype: Document Import Receipt\nrequest_id: ${job.id}\nfile_sha256: ${job.digest}\noriginal_archived: true\nprocessing_status: failed\n---\n`);
    await outbox.flush();
    await cache.clear();
    expect(await cache.isPinned(job.digest)).toBe(true);
    expect(await cache.read(job.digest)).toBeInstanceOf(ArrayBuffer);
    expect(await store.get(`upload:${job.id}`)).toBeUndefined();
  });

  it("evicts only unpinned downloads and leaves unacknowledged uploads untouched", async () => {
    const { store, cache } = fixture();
    const data = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
    const a = data("aaaaaaaa"); const b = data("bbbbbbbb"); const pinned = data("cccccccc");
    const ah = await digestBytes(a); const bh = await digestBytes(b); const ph = await digestBytes(pinned);
    await store.put("upload:pending", a);
    await cache.save(ph, pinned, true);
    await cache.save(ah, a);
    await cache.save(bh, b);
    expect(await cache.read(ah)).toBeUndefined();
    expect(await cache.read(bh)).toBeDefined();
    await cache.clear();
    expect(await cache.read(bh)).toBeUndefined();
    expect(await cache.read(ph)).toBeDefined();
    expect(await store.get("upload:pending")).toBeDefined();
  });

  it("does not overwrite a modified request or release the upload on publication failure", async () => {
    const { app, files, store, cache, remote } = fixture();
    const outbox = new DocumentOutbox(app, store, async () => remote, cache);
    const saved = await outbox.save(new File(["pdf fixture"], "lecture.pdf"), options);
    files.set(saved.request_path, "---\nrequest_id: changed\n---\n# Human note\n");
    await outbox.flush();
    expect(files.get(saved.request_path)).toContain("Human note");
    expect(await store.get(`upload:${saved.request_id}`)).toBeDefined();
    expect((await outbox.list())[0]!.stage).toBe("uploaded");
  });

  it("resolves originals from a study guide through Source Text and stops cycles", async () => {
    const { app, files } = fixture();
    const digest = "a".repeat(64);
    files.set("guide.md", "---\nsources:\n  - resource: /text.md\n---\n# Guide");
    files.set("text.md", "---\nsources:\n  - resource: /source.md\n  - resource: /guide.md\n---\n# Text");
    files.set("source.md", `---\nresource: okf-original://sha256/${digest}/lecture.pdf\n---\n# Source`);
    expect(await originalsForNote(app, "guide.md")).toEqual([{ digest, filename: "lecture.pdf" }]);
  });

  it("opens cached originals without requiring configured or reachable remote storage", async () => {
    const { cache } = fixture();
    const bytes = new TextEncoder().encode("original").buffer as ArrayBuffer;
    const digest = await digestBytes(bytes);
    await cache.save(digest, bytes);
    const remote = vi.fn(async (): Promise<FileService> => { throw new Error("not configured"); });
    expect(await cache.get(digest, remote)).toEqual(bytes);
    expect(remote).not.toHaveBeenCalled();
  });
});

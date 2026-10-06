/** Legacy format/upgrade fixtures only. The active plugin uses Vault full sync. */
import { TFile, type App } from "obsidian";
import { parse, stringify } from "yaml";
import { normalizeCaptureRelation } from "../domain/capture-context.js";
import type { DeviceStore } from "./device-store.js";
import { digestBytes, type FileService } from "./file-service.js";
import { OriginalCache } from "./original-cache.js";
import { isSupportedDocument, MAX_DOCUMENT_BYTES } from "./drop.js";
import type { DocumentImportOptions } from "./types.js";
import type { SavedDocumentImport } from "./synced-intake.js";

export interface PendingDocument {
  id: string;
  filename: string;
  digest: string;
  size: number;
  createdAt: string;
  options: DocumentImportOptions;
  stage: "saved-local" | "uploaded" | "submitted" | "archived";
  storeId?: string;
  error?: string;
  course?: string;
  project?: string;
}

export function documentFields(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  const value: unknown = match ? parse(match[1]!) : undefined;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Only upload transport runs on mobile. Engine remains the conversion/semantic authority. */
export class DocumentOutbox {
  private running?: Promise<void>;
  public constructor(private readonly app: App, private readonly store: DeviceStore,
    private readonly remote: () => Promise<FileService>, private readonly cache: OriginalCache) {}

  public async save(file: File, options: DocumentImportOptions): Promise<SavedDocumentImport> {
    if (!isSupportedDocument(file)) throw new Error("支持 PDF、Word、PowerPoint 和常见图片");
    if (!file.size || file.size > MAX_DOCUMENT_BYTES) throw new Error("单个文件必须大于 0 且不超过 64 MiB");
    const filename = file.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/gu, "");
    if (!filename) throw new Error("文件名无效");
    const relation: { course?: string; project?: string } = {};
    for (const kind of ["course", "project"] as const) {
      const value = options[kind];
      if (!value) continue;
      const raw = value.includes("/") ? value : kind === "course"
        ? `learning/courses/${value}/course.md` : `projects/${value}/project.md`;
      const path = normalizeCaptureRelation({ [kind]: raw })[kind];
      if (!path || !(this.app.vault.getAbstractFileByPath(path.slice(1)) instanceof TFile)) {
        throw new Error("关联的课程或项目尚未保存在当前笔记库");
      }
      relation[kind] = path;
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== file.size) throw new Error("文件读取不完整");
    const id = crypto.randomUUID();
    const job: PendingDocument = { id, filename, digest: await digestBytes(bytes), size: bytes.byteLength,
      createdAt: new Date().toISOString(), options, stage: "saved-local", ...relation };
    await this.store.put(`upload:${id}`, bytes);
    try { await this.store.put(`outbox:${id}`, job); }
    catch (error) { await this.store.delete(`upload:${id}`); throw error; }
    return { request_id: id, request_path: `system/imports/${id}/request.md`, saved_path: `device:${id}` };
  }

  public async list(): Promise<PendingDocument[]> {
    const result: PendingDocument[] = [];
    for (const key of await this.store.keys("outbox:")) {
      const job = await this.store.get<PendingDocument>(key);
      if (job) result.push(job);
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public flush(): Promise<void> {
    return this.running ??= this.process().finally(() => { this.running = undefined; });
  }

  private async process(): Promise<void> {
    for (const job of await this.list()) {
      try {
        if (job.stage === "archived") {
          await this.store.delete(`upload:${job.id}`); // Recover an interrupted cleanup.
          continue;
        }
        if (job.stage === "saved-local") {
          const bytes = await this.store.get<ArrayBuffer>(`upload:${job.id}`);
          if (!bytes) throw new Error("本机待上传文件缺失，请重新选择文件");
          const remote = await this.remote();
          await remote.upload(job.digest, bytes);
          job.storeId = remote.storeId;
          job.stage = "uploaded";
          job.error = undefined;
          await this.store.put(`outbox:${job.id}`, job);
        }
        if (job.stage === "uploaded") {
          await this.publish(job);
          job.stage = "submitted";
          job.error = undefined;
          await this.store.put(`outbox:${job.id}`, job);
        }
        const receipt = this.app.vault.getAbstractFileByPath(`system/imports/${job.id}/receipt.md`);
        if (!(receipt instanceof TFile)) continue;
        const fields = documentFields(await this.app.vault.cachedRead(receipt));
        if (fields.type !== "Document Import Receipt" || fields.request_id !== job.id
          || fields.file_sha256 !== job.digest || fields.original_archived !== true) continue;
        if (job.options.keepOffline) {
          const bytes = await this.store.get<ArrayBuffer>(`upload:${job.id}`);
          if (!bytes) throw new Error("待保留离线的原件缺失");
          await this.cache.save(job.digest, bytes, true);
        }
        job.stage = "archived";
        job.error = undefined;
        await this.store.put(`outbox:${job.id}`, job);
        await this.store.delete(`upload:${job.id}`);
      } catch (error) {
        job.error = error instanceof Error ? error.message : "文件传输暂时失败，稍后重试";
        await this.store.put(`outbox:${job.id}`, job);
      }
    }
  }

  private async publish(job: PendingDocument): Promise<void> {
    for (const path of ["system", "system/imports", `system/imports/${job.id}`]) {
      if (!this.app.vault.getAbstractFileByPath(path)) {
        try { await this.app.vault.createFolder(path); }
        catch (error) { if (!this.app.vault.getAbstractFileByPath(path)) throw error; }
      }
    }
    const path = `system/imports/${job.id}/request.md`;
    const fields = {
      type: "Document Import Request", title: job.filename, created_at: job.createdAt,
      request_id: job.id, filename: job.filename, file_sha256: job.digest, size_bytes: job.size,
      transport: "file-store", original_store: job.storeId,
      intent: job.options.intent, quality: job.options.quality, method: job.options.method ?? "auto",
      generate: job.options.generate,
      ...(job.course ? { course: job.course } : {}), ...(job.project ? { project: job.project } : {}),
    };
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const previous = documentFields(await this.app.vault.cachedRead(existing));
      if (Object.entries(fields).some(([key, value]) => previous[key] !== value)) {
        throw new Error("导入申请已经改变，已保留本机文件，请检查申请");
      }
      return;
    }
    await this.app.vault.create(path,
      `---\n${stringify(fields)}---\n\n# ${job.filename}\n\n原件已上传，等待电脑接收。\n`);
  }
}

import { TFile, type App } from "obsidian";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { normalizeCaptureRelation } from "../domain/capture-context.js";
import { isSupportedDocument, MAX_DOCUMENT_BYTES } from "./drop.js";
import type { DocumentImportOptions } from "./types.js";
import { ensureDocumentSyncCapacity } from "./sync-capacity.js";

export interface SavedDocumentImport {
  saved_path: string;
  request_path: string;
  request_id: string;
}

export interface SyncedImportEntry {
  action?: "store" | "convert";
  course?: string;
  project?: string;
  createdAt?: string;
  semanticStatus?: string;
  generationKind?: "learn" | "wiki";
  id: string;
  filename: string;
  filePath: string;
  digest?: string;
  requestPath: string;
  receiptPath?: string;
  status: string;
  message: string;
  outputs: Record<string, string>;
}

export function originalDirectory(digest: string): string {
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("原件校验值无效");
  return `sources/originals/${digest}`;
}

export async function digestBytes(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (value) => value.toString(16).padStart(2, "0")).join("");
}

function markdown(fields: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(fields)}---\n\n${body}\n`;
}

function contextReference(value: string | undefined, kind: "course" | "project"): string | undefined {
  if (!value) return undefined;
  const raw = value.includes("/") ? value : kind === "course"
    ? `learning/courses/${value}/course.md` : `projects/${value}/project.md`;
  return normalizeCaptureRelation({ [kind]: raw })[kind];
}

/** Persist bytes first and the immutable user request last, entirely through Vault APIs. */
export async function saveSyncedDocument(
  app: App,
  file: File,
  options: DocumentImportOptions,
  recovery?: { id: string; createdAt: string },
): Promise<SavedDocumentImport> {
  if (options.action === "store" && (options.generate || !["source", "later"].includes(options.intent))) {
    throw new Error("仅保存原件不能请求生成笔记");
  }
  if (!isSupportedDocument(file)) throw new Error("支持 PDF、Word、PowerPoint 和常见图片");
  if (!file.size || file.size > MAX_DOCUMENT_BYTES) throw new Error("单个文件必须大于 0 且不超过 64 MiB");
  await ensureDocumentSyncCapacity(app);
  const requestId = recovery?.id ?? crypto.randomUUID();
  if (!/^[0-9a-f-]{36}$/u.test(requestId)) throw new Error("申请编号无效");
  const directory = `system/imports/${requestId}`;
  const filename = file.name.replace(/[<>:"/\\|?*\u0000-\u001f\[\]#^]/gu, "_").replace(/[. ]+$/gu, "");
  if (!filename) throw new Error("文件名无效");
  const requestPath = `${directory}/request.md`;
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size) throw new Error("文件读取不完整");
  const sha256 = await digestBytes(bytes);
  const originalRoot = originalDirectory(sha256);
  const existingOriginal = app.vault.getFiles().find((item) =>
    item.path.startsWith(`${originalRoot}/`) && isSupportedDocument(item));
  const filePath = existingOriginal?.path ?? `${originalRoot}/${filename}`;
  const relation = {
    course: contextReference(options.course, "course"),
    project: contextReference(options.project, "project"),
  };
  for (const reference of Object.values(relation)) {
    if (reference && !(app.vault.getAbstractFileByPath(reference.slice(1)) instanceof TFile)) {
      throw new Error("关联的课程或项目尚未保存在当前笔记库");
    }
  }
  const previous = app.vault.getAbstractFileByPath(requestPath);
  if (previous instanceof TFile) {
    const fields = documentFields(await app.vault.cachedRead(previous));
    if (fields.type !== "Document Import Request" || fields.request_id !== requestId || fields.file_sha256 !== sha256) {
      throw new Error("已有申请发生变化，已保留旧版待提交文件");
    }
  }
  for (const path of ["sources", "sources/originals", originalRoot, "system", "system/imports", directory]) {
    if (!app.vault.getAbstractFileByPath(path)) {
      try { await app.vault.createFolder(path); }
      catch (error) { if (!app.vault.getAbstractFileByPath(path)) throw error; }
    }
  }
  const verify = async (): Promise<void> => {
    const stored = app.vault.getAbstractFileByPath(filePath);
    if (!(stored instanceof TFile) || await digestBytes(await app.vault.readBinary(stored)) !== sha256) {
      throw new Error("原件内容与校验值不符，已保留文件，请检查后重试");
    }
  };
  if (!existingOriginal) {
    try { await app.vault.createBinary(filePath, bytes); }
    catch (error) { if (!(app.vault.getAbstractFileByPath(filePath) instanceof TFile)) throw error; }
  }
  await verify();
  if (previous instanceof TFile) return { saved_path: filePath, request_path: requestPath, request_id: requestId };
  // No API, converter availability check, or device-local plugin data is
  // needed to submit. Engine resolves "auto" when it accepts the request.
  const fields: Record<string, unknown> = {
    type: "Document Import Request", title: filename, created_at: recovery?.createdAt ?? new Date().toISOString(),
    request_id: requestId, file: `/${filePath}`, filename, file_sha256: sha256,
    size_bytes: bytes.byteLength, intent: options.intent,
    ...(options.action ? { request_version: 4, action: options.action } : {}),
    ...(options.action === "store" ? {} : {
      quality: options.quality, method: options.method ?? "auto", generate: options.generate,
    }),
    ...(relation.course ? { course: relation.course } : {}),
    ...(relation.project ? { project: relation.project } : {}),
  };
  await app.vault.create(requestPath, markdown(fields,
    `# ${filename}\n\n${options.action === "store" ? "原件已保存到本机，不自动转换。" : "原件已保存到本机。转换请求随笔记同步，电脑运行后处理。"}\n\n原文件：[[${filePath}]]`));
  return { saved_path: filePath, request_path: requestPath, request_id: requestId };
}

export function documentFields(markdownText: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdownText);
  if (!match) return {};
  const value: unknown = parseYaml(match[1]!);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function localPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.replace(/^\//u, "");
  if (path.split("/").some((part) => !part || part === "." || part === ".." || /[:\\]/u.test(part))) return undefined;
  return path;
}

/** Receipts are a display projection; mobile never runs Engine's state machine. */
export async function listSyncedImports(app: App): Promise<SyncedImportEntry[]> {
  const sources = new Map<string, { source: string; source_text?: string }>();
  for (const file of app.vault.getMarkdownFiles().filter((item) => item.path.startsWith("sources/records/"))) {
    try {
      const fields = documentFields(await app.vault.cachedRead(file));
      if (fields.type === "Source" && typeof fields.sha256 === "string") {
        sources.set(fields.sha256, { source: file.path, source_text: localPath(fields.text) });
      }
    } catch { /* A record may be in transit. */ }
  }
  const requests = app.vault.getMarkdownFiles()
    .filter((file) => /^(?:inbox\/uploads|system\/imports)\/[0-9a-f-]+\/request\.md$/u.test(file.path));
  const entries: SyncedImportEntry[] = [];
  for (const file of requests) {
    try {
      const request = documentFields(await app.vault.cachedRead(file));
      if (request.type !== "Document Import Request") continue;
      const filePath = localPath(request.file);
      if (request.transport !== "file-store" && (!filePath || !(
        filePath.startsWith(file.path.slice(0, -"request.md".length))
        || filePath.startsWith(`sources/originals/${String(request.file_sha256)}/`)))) continue;
      const receiptPath = file.path.replace(/request\.md$/u, "receipt.md");
      const receiptFile = app.vault.getAbstractFileByPath(receiptPath);
      const receipt = receiptFile instanceof TFile ? documentFields(await app.vault.cachedRead(receiptFile)) : {};
      const matching = receipt.type === "Document Import Receipt" && receipt.request_id === request.request_id;
      const outputs: Record<string, string> = {};
      const source = sources.get(String(request.file_sha256));
      if (source) {
        outputs.source = source.source;
        if (source.source_text) outputs.source_text = source.source_text;
      }
      if (matching && receipt.outputs && typeof receipt.outputs === "object") {
        for (const [name, value] of Object.entries(receipt.outputs)) {
          const path = localPath(value);
          if (path && ["source", "source_text", "routed_target"].includes(name)) outputs[name] = path;
        }
      }
      entries.push({
        generationKind: request.intent === "wiki" ? "wiki" : request.intent === "learn" ? "learn" : undefined,
        semanticStatus: matching && typeof receipt.semantic_status === "string" ? receipt.semantic_status : undefined,
        createdAt: typeof request.created_at === "string" ? request.created_at : "",
        action: request.action === "store" ? "store" : "convert",
        course: typeof request.course === "string" ? request.course : undefined,
        project: typeof request.project === "string" ? request.project : undefined,
        id: String(request.request_id), filename: String(request.filename), filePath: filePath ?? "",
        digest: typeof request.file_sha256 === "string" ? request.file_sha256 : undefined,
        requestPath: file.path, ...(matching ? { receiptPath } : {}),
        status: matching ? String(receipt.processing_status) : request.action === "store" ? "stored" : "saved-local",
        message: matching ? String(receipt.message) : request.action === "store"
          ? "原件已保存到本机，不自动转换" : "原件已保存，转换请求等待同步及电脑处理",
        outputs,
      });
      const entry = entries[entries.length - 1]!;
      if (entry.status === "stored") {
        if (entry.outputs.source_text) {
          entry.status = "imported";
          entry.message = "原件已保存，已有正文可用";
        } else if (!(app.vault.getAbstractFileByPath(entry.filePath) instanceof TFile)) {
          entry.message = "原件尚未同步到本机";
        }
      }
    } catch {
      // A request or its receipt may still be arriving through replication.
    }
  }
  const unique = new Map<string, SyncedImportEntry>();
  for (const entry of entries.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))) {
    const key = [entry.digest ?? entry.id, entry.course ?? "", entry.project ?? ""].join("|");
    const previous = unique.get(key);
    if (!previous || previous.action === "store" && entry.action === "convert") unique.set(key, entry);
  }
  return [...unique.values()];
}

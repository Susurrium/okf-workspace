import { TFile, type App } from "obsidian";
import type { DeviceStore } from "./device-store.js";
import type { PendingDocument } from "./document-outbox.js";
import { digestBytes, originalDirectory, saveSyncedDocument } from "./synced-intake.js";

export interface RecoveryIssue { filename: string; message: string }

/** One-way upgrade only. Never uploads, downloads or edits an existing request. */
export async function recoverLegacyUploads(app: App, store: DeviceStore): Promise<RecoveryIssue[]> {
  const issues: RecoveryIssue[] = [];
  for (const key of await store.keys("outbox:")) {
    const job = await store.get<PendingDocument & { vaultRecovered?: boolean }>(key);
    if (!job || job.vaultRecovered) continue;
    try {
      const bytes = await store.get<ArrayBuffer>(`upload:${job.id}`);
      if (bytes) {
        if (await digestBytes(bytes) !== job.digest) throw new Error("旧版待提交文件校验失败，已保留原数据");
        await saveSyncedDocument(app, new File([bytes], job.filename), job.options,
          { id: job.id, createdAt: job.createdAt });
      } else {
        const file = app.vault.getFiles().find((item) => item.path.startsWith(`${originalDirectory(job.digest)}/`));
        if (!(file instanceof TFile) || await digestBytes(await app.vault.readBinary(file)) !== job.digest) {
          throw new Error("等待旧原件同步；本机旧记录已保留");
        }
        const request = app.vault.getAbstractFileByPath(`system/imports/${job.id}/request.md`);
        if (!(request instanceof TFile)) throw new Error("等待旧导入申请同步；本机旧记录已保留");
      }
      await store.delete(`upload:${job.id}`);
      await store.put(key, { ...job, vaultRecovered: true });
    } catch (error) {
      issues.push({ filename: job.filename, message: error instanceof Error ? error.message : "恢复失败，已保留旧文件" });
    }
  }
  return issues;
}

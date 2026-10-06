import { FileSystemAdapter, Notice, TFile, type App } from "obsidian";
import { IndexedDeviceStore } from "../imports/device-store.js";
import { recoverLegacyUploads, type RecoveryIssue } from "../imports/recover-legacy-uploads.js";
import { originalDirectory } from "../imports/synced-intake.js";
import { isSupportedDocument } from "../imports/drop.js";
import { originalsForNote, type OriginalReference } from "../imports/original-references.js";
import { ChoiceModal } from "./prompts.js";

/** Originals are normal local Vault attachments; Obsidian owns their viewer. */
export class OriginalFiles {
  private readonly legacyStore: IndexedDeviceStore;
  private recovering?: Promise<void>;
  public recoveryIssues: RecoveryIssue[] = [];

  public constructor(private readonly app: App) {
    const adapter = app.vault.adapter;
    const namespace = adapter instanceof FileSystemAdapter ? adapter.getBasePath()
      : (app as App & { appId?: string }).appId ?? adapter.getResourcePath("").split("?")[0]!;
    this.legacyStore = new IndexedDeviceStore(namespace);
  }

  public recover(): Promise<void> {
    return this.recovering ??= recoverLegacyUploads(this.app, this.legacyStore)
      .then((issues) => { this.recoveryIssues = issues; })
      .catch(() => { this.recoveryIssues = [{ filename: "旧版本机文件", message: "恢复暂时失败，旧文件已保留，请重试" }]; })
      .finally(() => { this.recovering = undefined; });
  }

  public async openNote(path: string): Promise<void> {
    try {
      const references = await originalsForNote(this.app, path);
      if (!references.length) { new Notice("当前笔记没有关联可打开的文件原件"); return; }
      if (references.length === 1) { await this.open(references[0]!); return; }
      new ChoiceModal(this.app, references.map((item) => ({
        value: item.digest, label: item.filename, description: "在 Obsidian 中打开",
      })), "选择原件", async (digest) => { await this.open(references.find((item) => item.digest === digest)!); }).open();
    } catch (error) { new Notice(error instanceof Error ? error.message : "无法读取原件关联"); }
  }

  public async open(reference: OriginalReference): Promise<void> {
    try {
      const directory = originalDirectory(reference.digest);
      const direct = reference.path ? this.app.vault.getAbstractFileByPath(reference.path) : null;
      const file = direct instanceof TFile ? direct
        : this.app.vault.getFiles().find((item) => item.path.startsWith(`${directory}/`) && isSupportedDocument(item));
      if (!(file instanceof TFile)) {
        new Notice("原件尚未同步到本机，请等待 LiveSync 同步完成后再打开", 10_000);
        return;
      }
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) { new Notice(error instanceof Error ? error.message : "原件打开失败", 10_000); }
  }

  public async importVaultFile(file: TFile, submit: (file: File) => void): Promise<void> {
    submit(new File([await this.app.vault.readBinary(file)], file.name));
  }
}

import type {
  DocumentImportOptions,
  DocumentImportResult,
} from "./types.js";
import { assertMatchingVault, VAULT_FINGERPRINT_HEADER, VAULT_MISMATCH_MESSAGE } from "../api/vault-identity.js";

export interface DocumentImportApi {
  importDocument(file: File, options: DocumentImportOptions): Promise<DocumentImportResult>;
}

export class HttpDocumentImportApi implements DocumentImportApi {
  public constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 120_000,
    private readonly expectedVaultFingerprint?: string,
  ) {}

  public async importDocument(
    file: File,
    options: DocumentImportOptions,
  ): Promise<DocumentImportResult> {
    if (this.expectedVaultFingerprint) {
      const identityResponse = await fetch(`${this.baseUrl.replace(/\/$/u, "")}/workspace/identity`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!identityResponse.ok) throw new Error(`无法验证本地服务的 Vault（HTTP ${identityResponse.status}）`);
      const identity = await identityResponse.json() as { vault_fingerprint: string };
      assertMatchingVault(identity.vault_fingerprint, this.expectedVaultFingerprint);
    }
    const form = new FormData();
    form.set("file", file);
    form.set("intent", options.intent);
    form.set("quality", options.quality);
    form.set("parser", options.parser);
    form.set("generate", String(options.generate));
    if (options.course) form.set("course", options.course);
    if (options.project) form.set("project", options.project);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/documents/import`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(this.expectedVaultFingerprint
            ? { [VAULT_FINGERPRINT_HEADER]: this.expectedVaultFingerprint }
            : {}),
        },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
        throw new Error("文档上传超时，请确认工作区服务可用后重试", { cause: error });
      }
      throw error;
    }
    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 409 && detail.includes("Vault identity mismatch")) {
        throw new Error(VAULT_MISMATCH_MESSAGE);
      }
      throw new Error(detail || `文档导入失败（HTTP ${response.status}）`);
    }
    return (await response.json()) as DocumentImportResult;
  }
}

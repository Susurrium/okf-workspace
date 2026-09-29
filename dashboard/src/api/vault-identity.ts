import { FileSystemAdapter, type App } from "obsidian";

import { vaultFingerprint } from "../feeds/open-digest.js";

export const VAULT_FINGERPRINT_HEADER = "X-OKF-Vault-Fingerprint";
export const VAULT_MISMATCH_MESSAGE = "工作区本地服务连接的是另一个 Vault，请检查 Dashboard 的服务地址和部署配置";

export function currentVaultFingerprint(app: App): string {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error("当前 Vault 不支持验证本地服务的 Vault 路径");
  }
  return vaultFingerprint(adapter.getBasePath());
}

export function assertMatchingVault(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(VAULT_MISMATCH_MESSAGE);
  }
}

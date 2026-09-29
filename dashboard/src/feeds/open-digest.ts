import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import type { PreparedFeedDigest } from "./service.js";

export interface DigestVaultPort<File> {
  getFile(path: string): File | undefined;
  hasFolder(path: string): boolean;
  stat(path: string): Promise<"file" | "folder" | undefined>;
  createFolder(path: string): Promise<void>;
  create(path: string, markdown: string): Promise<File>;
  refreshExisting(): Promise<void>;
  open(file: File, blockId?: string): Promise<void>;
  waitForFile(path: string): Promise<File | undefined>;
  describePath(path: string): string;
}

export function vaultFingerprint(root: string): string {
  let canonical = realpathSync.native(root).replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function normalizedDigestPath(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  const segments = normalized.split("/");
  if (
    !normalized.endsWith(".md") ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))
  ) {
    throw new Error("本期汇总返回了无效的 Vault 路径");
  }
  return normalized;
}

function notIndexed(path: string, kind: "汇总" | "目录" = "汇总"): Error {
  return new Error(`${kind}已在当前 Vault 的磁盘中，但 Obsidian 尚未识别。请重新加载 Obsidian 后打开：${path}`);
}

async function ensureFolders<File>(
  path: string,
  port: DigestVaultPort<File>,
): Promise<void> {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const folder = segments.slice(0, index).join("/");
    const state = await port.stat(folder);
    if (state === "file") throw new Error(`汇总目录被文件占用：${port.describePath(folder)}`);
    if (state === "folder") {
      if (!port.hasFolder(folder)) throw notIndexed(port.describePath(folder), "目录");
      continue;
    }
    try {
      await port.createFolder(folder);
    } catch (error) {
      if ((await port.stat(folder)) !== "folder") throw error;
      if (!port.hasFolder(folder)) throw notIndexed(port.describePath(folder), "目录");
    }
  }
}

export async function openPreparedDigest<File>(
  prepared: PreparedFeedDigest,
  currentVaultFingerprint: string,
  port: DigestVaultPort<File>,
  blockId?: string,
): Promise<void> {
  if (prepared.vault_fingerprint !== currentVaultFingerprint) {
    throw new Error("工作区本地服务连接的是另一个 Vault，请检查 Dashboard 的服务地址和部署配置");
  }
  const path = normalizedDigestPath(prepared.vault_path);
  const fullPath = port.describePath(path);
  let file = port.getFile(path);
  if (file !== undefined) {
    await port.refreshExisting();
    await port.open(file, blockId);
    return;
  }
  const state = await port.stat(path);
  if (state === "folder") throw new Error(`汇总路径被目录占用：${fullPath}`);
  if (state === "file") {
    file = await port.waitForFile(path);
    if (file === undefined) throw notIndexed(fullPath);
    await port.refreshExisting();
    await port.open(file, blockId);
    return;
  }
  await ensureFolders(path, port);
  try {
    file = await port.create(path, prepared.markdown);
  } catch (error) {
    if ((await port.stat(path)) !== "file") throw error;
    file = await port.waitForFile(path);
    if (file === undefined) throw notIndexed(fullPath);
    await port.refreshExisting();
  }
  await port.open(file, blockId);
}

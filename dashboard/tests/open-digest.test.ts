import { describe, expect, it, vi } from "vitest";

import {
  normalizedDigestPath,
  openPreparedDigest,
  type DigestVaultPort,
} from "../src/feeds/open-digest.js";
import type { PreparedFeedDigest } from "../src/feeds/service.js";

interface File { path: string }

const PATH = "feeds/treehole/2026/edition.md";
const FINGERPRINT = "current-vault";
const PREPARED: PreparedFeedDigest = {
  vault_path: PATH,
  markdown: "---\ntype: Digest\n---\n# 汇总\n",
  vault_fingerprint: FINGERPRINT,
};

function fixture() {
  const file: File = { path: PATH };
  const port: DigestVaultPort<File> = {
    getFile: vi.fn(() => undefined),
    hasFolder: vi.fn(() => true),
    stat: vi.fn(async () => undefined),
    createFolder: vi.fn(async () => undefined),
    create: vi.fn(async () => file),
    refreshExisting: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    waitForFile: vi.fn(async () => undefined),
    describePath: (path) => `E:/Vault/${path}`,
  };
  return { file, port };
}

describe("opening prepared Feed Digests", () => {
  it("creates a new Digest through Obsidian and opens the returned file directly", async () => {
    const { file, port } = fixture();
    await openPreparedDigest(PREPARED, FINGERPRINT, port, "treehole-123");
    expect(port.createFolder).toHaveBeenCalledTimes(3);
    expect(port.create).toHaveBeenCalledWith(PATH, PREPARED.markdown);
    expect(port.open).toHaveBeenCalledWith(file, "treehole-123");
    expect(port.refreshExisting).not.toHaveBeenCalled();
    expect(port.waitForFile).not.toHaveBeenCalled();
  });

  it("refreshes an indexed Digest without recreating or overwriting it", async () => {
    const { file, port } = fixture();
    port.getFile = vi.fn(() => file);
    await openPreparedDigest(PREPARED, FINGERPRINT, port);
    expect(port.refreshExisting).toHaveBeenCalledTimes(1);
    expect(port.create).not.toHaveBeenCalled();
    expect(port.open).toHaveBeenCalledWith(file, undefined);
  });

  it("reports a file present on disk but absent from Obsidian's index", async () => {
    const { port } = fixture();
    port.stat = vi.fn(async () => "file" as const);
    await expect(openPreparedDigest(PREPARED, FINGERPRINT, port))
      .rejects.toThrow("E:/Vault/feeds/treehole/2026/edition.md");
    expect(port.create).not.toHaveBeenCalled();
    expect(port.refreshExisting).not.toHaveBeenCalled();
  });

  it("does not create beneath a directory missing from Obsidian's index", async () => {
    const { port } = fixture();
    port.stat = vi.fn(async (path) => path === "feeds" ? "folder" : undefined);
    port.hasFolder = vi.fn(() => false);
    await expect(openPreparedDigest(PREPARED, FINGERPRINT, port))
      .rejects.toThrow("E:/Vault/feeds");
    expect(port.create).not.toHaveBeenCalled();
  });

  it("recovers a concurrent create without replacing the winning file", async () => {
    const { file, port } = fixture();
    let exists = false;
    port.stat = vi.fn(async () => exists ? "file" : undefined);
    port.create = vi.fn(async () => {
      exists = true;
      throw new Error("file already exists");
    });
    port.waitForFile = vi.fn(async () => file);
    await openPreparedDigest(PREPARED, FINGERPRINT, port);
    expect(port.refreshExisting).toHaveBeenCalledTimes(1);
    expect(port.open).toHaveBeenCalledWith(file, undefined);
  });

  it("refuses another service Vault before reading or writing a local file", async () => {
    const { port } = fixture();
    await expect(openPreparedDigest(PREPARED, "other-vault", port))
      .rejects.toThrow("另一个 Vault");
    expect(port.stat).not.toHaveBeenCalled();
    expect(port.create).not.toHaveBeenCalled();
  });

  it("rejects traversal and absolute paths returned by the service", () => {
    expect(() => normalizedDigestPath("../outside.md")).toThrow("无效");
    expect(() => normalizedDigestPath("C:/outside.md")).toThrow("无效");
    expect(() => normalizedDigestPath("/outside.md")).toThrow("无效");
  });
});

/** Legacy format/upgrade fixtures only. The active plugin uses Vault full sync. */
import type { DeviceStore } from "./device-store.js";
import { digestBytes, type FileService } from "./file-service.js";

interface CacheEntry { digest: string; size: number; pinned: boolean; accessedAt: number }

export class OriginalCache {
  private pending = Promise.resolve();
  public constructor(private readonly store: DeviceStore, private readonly limit = 512 * 1024 * 1024) {}

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  public async read(digest: string): Promise<ArrayBuffer | undefined> {
    return this.exclusive(async () => {
      const entry = await this.store.get<CacheEntry>(`cache:${digest}`);
      if (!entry) return undefined;
      const bytes = await this.store.get<ArrayBuffer>(`blob:${digest}`);
      if (!bytes || await digestBytes(bytes) !== digest) {
        await this.store.delete(`cache:${digest}`);
        await this.store.delete(`blob:${digest}`);
        return undefined;
      }
      await this.store.put(`cache:${digest}`, { ...entry, accessedAt: Date.now() });
      return bytes;
    });
  }

  public async get(digest: string, remote: () => Promise<FileService>): Promise<ArrayBuffer> {
    const local = await this.read(digest);
    if (local) return local;
    const bytes = await (await remote()).download(digest);
    await this.save(digest, bytes);
    return bytes;
  }

  public async save(digest: string, bytes: ArrayBuffer, pinned = false): Promise<void> {
    if (await digestBytes(bytes) !== digest) throw new Error("原件缓存校验失败");
    await this.exclusive(async () => {
      const previous = await this.store.get<CacheEntry>(`cache:${digest}`);
      const keep = pinned || previous?.pinned === true;
      if (!keep && bytes.byteLength > this.limit) return;
      await this.trim(keep ? this.limit : Math.max(0, this.limit - bytes.byteLength), digest);
      await this.store.put(`blob:${digest}`, bytes);
      await this.store.put<CacheEntry>(`cache:${digest}`, {
        digest, size: bytes.byteLength, pinned: keep, accessedAt: Date.now(),
      });
    });
  }

  public async isPinned(digest: string): Promise<boolean> {
    return (await this.store.get<CacheEntry>(`cache:${digest}`))?.pinned === true;
  }

  public async pin(digest: string, pinned: boolean): Promise<void> {
    await this.exclusive(async () => {
      const entry = await this.store.get<CacheEntry>(`cache:${digest}`);
      if (!entry) throw new Error("请先下载原件再保留离线");
      await this.store.put(`cache:${digest}`, { ...entry, pinned });
      await this.trim(this.limit);
    });
  }

  public async clear(): Promise<void> { await this.exclusive(() => this.trim(0)); }

  private async trim(budget: number, exclude?: string): Promise<void> {
    const entries: CacheEntry[] = [];
    for (const key of await this.store.keys("cache:")) {
      const entry = await this.store.get<CacheEntry>(key);
      if (entry && entry.digest !== exclude && !entry.pinned) entries.push(entry);
    }
    // Recover interrupted writes/deletions without ever touching pending uploads.
    for (const key of await this.store.keys("blob:")) {
      const digest = key.slice("blob:".length);
      if (digest !== exclude && !await this.store.get(`cache:${digest}`)) await this.store.delete(key);
    }
    let size = entries.reduce((total, entry) => total + entry.size, 0);
    for (const entry of entries.sort((a, b) => a.accessedAt - b.accessedAt)) {
      if (size <= budget) break;
      await this.store.delete(`cache:${entry.digest}`);
      await this.store.delete(`blob:${entry.digest}`);
      size -= entry.size;
    }
  }
}

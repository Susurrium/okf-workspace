/** Legacy format/upgrade fixtures only. The active plugin uses Vault full sync. */
import { requestUrl } from "obsidian";

export interface FileServiceConfig { baseUrl: string; token: string; storeId: string }
export interface FileService {
  readonly storeId: string;
  upload(digest: string, bytes: ArrayBuffer): Promise<void>;
  download(digest: string): Promise<ArrayBuffer>;
}

export async function digestBytes(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (value) => value.toString(16).padStart(2, "0")).join("");
}

export function validateFileService(config: FileServiceConfig): void {
  const url = new URL(config.baseUrl);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash) throw new Error("文件服务需要 HTTPS 地址");
  if (config.token.length < 32 || !/^[a-zA-Z0-9_-]{8,80}$/u.test(config.storeId)) {
    throw new Error("请填写文件服务凭据和文件库编号");
  }
}

export class HttpFileService implements FileService {
  public readonly storeId: string;
  public constructor(private readonly config: FileServiceConfig) {
    validateFileService(config);
    this.storeId = config.storeId;
  }

  private async request(path: string, method = "GET", body?: ArrayBuffer) {
    const result = await requestUrl({
      url: `${this.config.baseUrl.replace(/\/$/u, "")}${path}`, method,
      headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/octet-stream" },
      body, throw: false,
    });
    if (result.status < 200 || result.status >= 300) {
      if (result.status === 404) throw new Error("原件尚未上传到服务器，请等待电脑上传完成");
      throw new Error(`原件文件服务暂时不可用（HTTP ${result.status}）`);
    }
    return result;
  }

  public async verify(): Promise<void> {
    const result = await this.request("/v1/status");
    if (result.json.store_id !== this.storeId) throw new Error("文件库编号不一致，请检查配置");
  }

  public async upload(digest: string, bytes: ArrayBuffer): Promise<void> {
    await this.verify();
    if (await digestBytes(bytes) !== digest) throw new Error("本机待上传文件校验失败，已保留文件");
    const result = await this.request(`/v1/blobs/${digest}`, "PUT", bytes);
    if (result.json.sha256 !== digest || result.json.size_bytes !== bytes.byteLength
      || result.json.store_id !== this.storeId) throw new Error("服务器接收确认不匹配，已保留本机文件");
  }

  public async download(digest: string): Promise<ArrayBuffer> {
    if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error("原件标识无效");
    await this.verify();
    const result = await this.request(`/v1/blobs/${digest}`);
    const bytes = result.arrayBuffer;
    if (!bytes.byteLength || bytes.byteLength > 64 * 1024 * 1024 || await digestBytes(bytes) !== digest) {
      throw new Error("原件下载不完整，请重试");
    }
    return bytes;
  }
}

import {
  assertMatchingVault,
  VAULT_FINGERPRINT_HEADER,
  VAULT_MISMATCH_MESSAGE,
} from "./vault-identity.js";

export interface WorkspaceHttpClientOptions {
  baseUrl: string;
  token: string;
  expectedVaultFingerprint?: string;
  defaultTimeout: number;
  setJsonContentTypeForBody?: boolean;
  onHttpError: (status: number, detail: string) => Error;
  onTransportError: (error: unknown, timedOut: boolean) => Error;
}

/** Shared authenticated JSON transport for Dashboard's Engine API clients. */
export class WorkspaceHttpClient {
  public constructor(private readonly options: WorkspaceHttpClientOptions) {}

  public async request<T>(path: string, init?: RequestInit, timeout?: number): Promise<T> {
    const method = (init?.method ?? "GET").toUpperCase();
    const mutating = !["GET", "HEAD"].includes(method);
    if (mutating && this.options.expectedVaultFingerprint) {
      const identity = await this.send<{ vault_fingerprint: string }>(
        "/workspace/identity",
        undefined,
        this.options.defaultTimeout,
      );
      assertMatchingVault(identity.vault_fingerprint, this.options.expectedVaultFingerprint);
    }

    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.options.token}`);
    if (mutating && this.options.expectedVaultFingerprint) {
      headers.set(VAULT_FINGERPRINT_HEADER, this.options.expectedVaultFingerprint);
    }
    if (this.options.setJsonContentTypeForBody && init?.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    return this.send<T>(
      path,
      { ...init, headers },
      timeout ?? this.options.defaultTimeout,
    );
  }

  private async send<T>(path: string, init: RequestInit | undefined, timeout: number): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.options.token}`);
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/$/u, "")}${path}`, {
        ...init,
        headers,
        signal: init?.signal ?? AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const timedOut = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
      throw this.options.onTransportError(error, timedOut);
    }
    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 409 && detail.includes("Vault identity mismatch")) {
        throw new Error(VAULT_MISMATCH_MESSAGE);
      }
      throw this.options.onHttpError(response.status, detail);
    }
    return (await response.json()) as T;
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalApi } from "../src/api/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LocalApi", () => {
  it("presents a recoverable failure without exposing raw backend JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ detail: "internal_state_invalid" }), { status: 500 },
    )));
    const api = new LocalApi("http://127.0.0.1:8765", "token");
    await expect(api.systemStatus()).rejects.toThrow("本地服务处理失败");
    await expect(api.systemStatus()).rejects.not.toThrow("internal_state_invalid");
  });
  it("uses cached system status normally and requests a live probe explicitly", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      generated_at: "2026-08-22T00:00:00+08:00",
      items: [],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    const api = new LocalApi("http://127.0.0.1:8765", "token");

    await api.systemStatus();
    await api.systemStatus(true);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8765/system/status",
      "http://127.0.0.1:8765/system/status?refresh_services=true",
    ]);
  });
});

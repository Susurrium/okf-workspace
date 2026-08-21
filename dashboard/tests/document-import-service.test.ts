import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpDocumentImportApi } from "../src/imports/service.js";

describe("HttpDocumentImportApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a bounded request with the selected import options", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      conversion_id: "conv-1",
      status: "queued",
      source_filename: "paper.pdf",
      intent: "learn",
      quality: "high",
      parser: "mineru",
      outputs: {},
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const api = new HttpDocumentImportApi("http://127.0.0.1:8765", "token", 5_000);

    await api.importDocument(new File(["pdf"], "paper.pdf"), {
      intent: "learn",
      quality: "high",
      parser: "mineru",
      generate: true,
      course: "cs61a",
    });

    const init = fetch.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("course")).toBe("cs61a");
  });

  it("turns an upload timeout into an actionable message", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(timeout)));
    const api = new HttpDocumentImportApi("http://127.0.0.1:8765", "token", 1);

    await expect(api.importDocument(new File(["doc"], "paper.docx"), {
      intent: "source",
      quality: "quick",
      parser: "markitdown",
      generate: false,
    })).rejects.toThrow("文档上传超时");
  });
});

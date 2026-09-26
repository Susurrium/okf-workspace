import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { DocumentImportModal } from "../src/plugin/document-import-modal.js";
import type { DocumentImportOptions, DocumentImportResult } from "../src/imports/types.js";
import { TestElement } from "./obsidian-runtime.js";

describe("shared document import window", () => {
  it("requests generation when the user selects Wiki", async () => {
    const importFile = vi.fn(async (_file: File, _options: DocumentImportOptions): Promise<DocumentImportResult> => ({
      conversion_id: "wiki", status: "queued", parser: "markitdown",
    }));
    const modal = new DocumentImportModal({} as App,
      [{ file: new File(["pdf"], "wiki.pdf"), relativePath: "wiki.pdf" }],
      { course: "algebra" }, "learning", "markitdown-only", importFile);
    modal.open();
    const content = modal.contentEl as unknown as TestElement;
    const intent = content.descendants().find((item) => item.tagName === "select")!;
    intent.value = "wiki";
    intent.dispatch("change");
    content.descendants().find((item) => item.textContent === "开始导入")!.click();
    await vi.waitFor(() => expect(importFile).toHaveBeenCalledOnce());
    expect(importFile.mock.calls[0]?.[1]).toMatchObject({ intent: "wiki", generate: true, course: "algebra" });
  });
  it("submits a dropped folder as separate files with the selected Course", async () => {
    const files = [
      { file: new File(["pdf"], "one.pdf"), relativePath: "course/one.pdf" },
      { file: new File(["word"], "two.docx"), relativePath: "course/chapter/two.docx" },
    ];
    const importFile = vi.fn(async (_file: File, _options: DocumentImportOptions): Promise<DocumentImportResult> => ({
      conversion_id: "conv-1", status: "queued", parser: "markitdown",
    }));
    const modal = new DocumentImportModal(
      {} as App, files, { course: "algebra" }, "learning", "markitdown-only", importFile,
    );
    modal.open();
    const content = modal.contentEl as unknown as TestElement;
    const options = content.descendants().filter((item) => item.tagName === "select");
    expect(options[0]?.value).toBe("learn");
    expect(content.descendants().some((item) => item.textContent.includes("Course：algebra"))).toBe(true);
    const submit = content.descendants().find((item) => item.textContent === "开始导入")!;
    submit.click();

    await vi.waitFor(() => expect(importFile).toHaveBeenCalledTimes(2));
    expect(importFile.mock.calls.map(([file, options]) => [file.name, options.course, options.intent, options.parser])).toEqual([
      ["one.pdf", "algebra", "learn", "markitdown"],
      ["two.docx", "algebra", "learn", "markitdown"],
    ]);
  });

  it("keeps a failed file available for retry without resubmitting successful files", async () => {
    const files = [
      { file: new File(["a"], "ok.pdf"), relativePath: "folder/ok.pdf" },
      { file: new File(["b"], "retry.pdf"), relativePath: "folder/retry.pdf" },
    ];
    let fail = true;
    const importFile = vi.fn(async (file: File, _options: DocumentImportOptions): Promise<DocumentImportResult> => {
      if (file.name === "retry.pdf" && fail) { fail = false; throw new Error("暂时不可用"); }
      return { conversion_id: file.name, status: "queued", parser: "markitdown" };
    });
    const modal = new DocumentImportModal(
      {} as App, files, { project: "workspace" }, "context", "markitdown-only", importFile,
    );
    modal.open();
    const content = modal.contentEl as unknown as TestElement;
    content.descendants().find((item) => item.textContent === "开始导入")!.click();
    await vi.waitFor(() => expect(content.descendants().some((item) => item.textContent === "重试失败项")).toBe(true));
    content.descendants().find((item) => item.textContent === "重试失败项")!.click();
    await vi.waitFor(() => expect(importFile).toHaveBeenCalledTimes(3));
    expect(importFile.mock.calls.map(([file]) => file.name)).toEqual(["ok.pdf", "retry.pdf", "retry.pdf"]);
    expect(importFile.mock.calls.every(([, options]) => options.project === "workspace" && options.intent === "source")).toBe(true);
  });
});

import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { DocumentConversionResultModal, DocumentImportModal, DocumentReconversionModal } from "../src/plugin/document-import-modal.js";
import type { ConverterCatalogue, DocumentImportOptions, DocumentImportResult } from "../src/imports/types.js";
import { TestElement } from "./obsidian-runtime.js";

const catalogue: ConverterCatalogue = {
  default_method: "mineru-cloud",
  methods: ["mineru-cloud", "markitdown-service", "mineru-self-hosted"].map((id) => ({
    id: id as ConverterCatalogue["default_method"], label: id,
    parser: id === "markitdown-service" ? "markitdown" : "mineru",
    enabled: true, configured: id !== "mineru-self-hosted", status: "configured",
    location: "fixture", reason: "", limitations: "fixture capability limits",
    extensions: id === "markitdown-service" ? [".pdf", ".docx"] : [".pdf", ".docx", ".png"],
    max_upload_bytes: 64 * 1024 * 1024,
    capabilities: { ocr: false, page_map: false, pdf_images: false, office_images: true },
  })),
};

describe("shared document import window", () => {
  it("allows configured alternatives when the default cloud credentials are missing", async () => {
    const methods = catalogue.methods.map((entry) => ({ ...entry,
      configured: entry.id === "markitdown-service", reason: "fixture configuration hint" }));
    const importFile = vi.fn(async (_file: File, _options: DocumentImportOptions): Promise<DocumentImportResult> => ({
      conversion_id: "alternative", status: "queued", parser: "markitdown",
    }));
    const modal = new DocumentImportModal({} as App,
      [{ file: new File(["pdf"], "manual.pdf"), relativePath: "manual.pdf" }],
      { course: "course" }, "learning", importFile, async () => ({ ...catalogue, methods }));
    modal.open();
    const content = modal.contentEl as unknown as TestElement;
    await vi.waitFor(() => expect(content.descendants().some((item) => item.textContent.includes("fixture configuration hint"))).toBe(true));
    const submit = content.descendants().find((item) => item.textContent === "开始导入")!;
    expect(submit.disabled).toBe(true);
    const method = content.descendants().filter((item) => item.tagName === "select")[1]!;
    method.value = "markitdown-service";
    method.dispatch("change");
    expect(submit.disabled).toBe(false);
    submit.click();
    await vi.waitFor(() => expect(importFile).toHaveBeenCalledOnce());
    expect(importFile.mock.calls[0]![1].method).toBe("markitdown-service");
  });

  it("keeps unsupported and unconfigured choices visible in the re-conversion window", async () => {
    const convert = vi.fn(async () => {});
    const modal = new DocumentReconversionModal({} as App, "picture.png", async () => catalogue, convert);
    modal.open();
    const content = modal.contentEl as unknown as TestElement;
    await vi.waitFor(() => expect(content.descendants().filter((item) => item.tagName === "button")).toHaveLength(3));
    const buttons = content.descendants().filter((item) => item.tagName === "button");
    expect(buttons.map((item) => item.disabled)).toEqual([false, true, true]);
    buttons[0]!.click();
    await vi.waitFor(() => expect(convert).toHaveBeenCalledWith("mineru-cloud"));
  });

  it("shows re-conversion text and QC warnings in a read-only window", () => {
    const modal = new DocumentConversionResultModal({} as App, {
      method: "markitdown-service", markdown: "# Preserved new result",
      asset_paths: [], qc: { passed: true, warnings: ["PDF 图片完整性未验证"], errors: [] },
    });
    modal.open();
    const content = modal.contentEl as unknown as TestElement;
    expect(content.descendants().some((item) => item.textContent === "PDF 图片完整性未验证")).toBe(true);
    const text = content.descendants().find((item) => item.tagName === "textarea")!;
    expect(text.value).toBe("# Preserved new result");
    expect(text.attributes.get("readonly")).toBe("");
  });

  it("preserves the selected conversion method when strict checks change", async () => {
    const importFile = vi.fn(async (_file: File, _options: DocumentImportOptions): Promise<DocumentImportResult> => ({
      conversion_id: "selected", status: "queued", parser: "markitdown",
    }));
    const modal = new DocumentImportModal({} as App,
      [{ file: new File(["pdf"], "manual.pdf"), relativePath: "manual.pdf" }],
      { course: "course" }, "learning", importFile, async () => catalogue);
    modal.open();
    const content = modal.contentEl as unknown as TestElement;
    await vi.waitFor(() => expect(content.descendants().some((item) => item.textContent.includes("fixture capability limits"))).toBe(true));
    const selects = content.descendants().filter((item) => item.tagName === "select");
    selects[1]!.value = "markitdown-service";
    selects[1]!.dispatch("change");
    selects[2]!.value = "high";
    selects[2]!.dispatch("change");
    content.descendants().find((item) => item.textContent === "开始导入")!.click();
    await vi.waitFor(() => expect(importFile).toHaveBeenCalledOnce());
    expect(importFile.mock.calls[0]).toEqual([
      expect.any(File), expect.objectContaining({ method: "markitdown-service", quality: "high", parser: "auto" }),
    ]);
  });

  it("requires an explicit choice before skipping files unsupported by a method", async () => {
    const importFile = vi.fn(async (_file: File, _options: DocumentImportOptions): Promise<DocumentImportResult> => ({
      conversion_id: "mixed", status: "queued", parser: "markitdown",
    }));
    const modal = new DocumentImportModal({} as App, [
      { file: new File(["pdf"], "document.pdf"), relativePath: "document.pdf" },
      { file: new File(["image"], "picture.png"), relativePath: "picture.png" },
    ], { course: "course" }, "learning", importFile, async () => catalogue);
    modal.open();
    const content = modal.contentEl as unknown as TestElement;
    await vi.waitFor(() => expect(content.descendants().some((item) => item.textContent.includes("fixture capability limits"))).toBe(true));
    const method = content.descendants().filter((item) => item.tagName === "select")[1]!;
    method.value = "markitdown-service";
    method.dispatch("change");
    const submit = content.descendants().find((item) => item.textContent === "开始导入")!;
    expect(submit.disabled).toBe(true);
    expect(content.descendants().some((item) => item.textContent.includes("不支持 .png"))).toBe(true);
    const skip = content.descendants().find((item) => item.tagName === "label"
      && item.children.some((child) => child.textContent.startsWith("仅提交支持的文件")))!.children[0]!;
    (skip as unknown as HTMLInputElement).checked = true;
    skip.dispatch("change");
    expect(submit.disabled).toBe(false);
    submit.click();
    await vi.waitFor(() => expect(importFile).toHaveBeenCalledOnce());
    expect(importFile.mock.calls[0]![0].name).toBe("document.pdf");
  });
  it("requests generation when the user selects Wiki", async () => {
    const importFile = vi.fn(async (_file: File, _options: DocumentImportOptions): Promise<DocumentImportResult> => ({
      conversion_id: "wiki", status: "queued", parser: "markitdown",
    }));
    const modal = new DocumentImportModal({} as App,
      [{ file: new File(["pdf"], "wiki.pdf"), relativePath: "wiki.pdf" }],
      { course: "algebra" }, "learning", importFile);
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
      {} as App, files, { course: "algebra" }, "learning", importFile,
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
      ["one.pdf", "algebra", "learn", "auto"],
      ["two.docx", "algebra", "learn", "auto"],
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
      {} as App, files, { project: "workspace" }, "context", importFile,
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

import { describe, expect, it } from "vitest";

import type { DocumentImportApi } from "../src/imports/service.js";
import type {
  DocumentImportOptions,
  DocumentImportResult,
} from "../src/imports/types.js";
import { DocumentImportPageModel } from "../src/ui/document-import-page.js";

class RecordingApi implements DocumentImportApi {
  public options?: DocumentImportOptions;

  public async importDocument(
    _file: File,
    options: DocumentImportOptions,
  ): Promise<DocumentImportResult> {
    this.options = options;
    return {
      conversion_id: "conv-fixture",
      status: "imported",
      parser: "markitdown",
      source: "sources/records/documents/manual.md",
      source_text: "sources/text/documents/manual.md",
    };
  }
}

describe("DocumentImportPageModel", () => {
  it("defaults to high quality and publishes without an approval step", async () => {
    const api = new RecordingApi();
    const page = new DocumentImportPageModel(api);
    page.selectFile(new File(["fixture"], "manual.docx"));
    page.setIntent("wiki");

    const result = await page.submit();

    expect(api.options).toEqual({
      intent: "wiki",
      quality: "high",
      parser: "auto",
      generate: false,
    });
    expect(result.status).toBe("imported");
    expect(page.state.result?.source_text).toContain("sources/text/");
  });

  it("can auto-generate learning material with an optional course relation", async () => {
    const api = new RecordingApi();
    const page = new DocumentImportPageModel(api);
    page.selectFile(new File(["fixture"], "slides.pptx"));
    page.setIntent("learn");
    page.setGenerate(true);
    page.setCourse("medical-statistics");

    await page.submit();
    expect(api.options).toMatchObject({
      intent: "learn",
      generate: true,
      course: "medical-statistics",
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  convertedDocumentTarget,
  semanticCompletionTitle,
} from "../src/domain/workflow-notifications.js";

describe("workflow notifications", () => {
  it("opens Source Text instead of a not-yet-generated routed target", () => {
    expect(convertedDocumentTarget({
      source: "sources/records/documents/report.md",
      source_text: "sources/text/documents/report.md",
      routed_target: "learning/guides/report.md",
    })).toBe("sources/text/documents/report.md");
  });

  it("identifies the completed artifact by its real title", () => {
    expect(semanticCompletionTitle("generate-study-guide", "Import checklist"))
      .toBe("学习材料已生成：Import checklist");
    expect(semanticCompletionTitle("generate-wiki", "LiveSync 不是备份"))
      .toBe("知识笔记已生成：LiveSync 不是备份");
  });
});

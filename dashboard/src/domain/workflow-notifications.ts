export interface ConvertedDocumentOutputs {
  source_text?: string;
  source?: string;
  routed_target?: string;
}

/** A conversion notice opens the durable converted text, never a future semantic target. */
export function convertedDocumentTarget(outputs: ConvertedDocumentOutputs): string | undefined {
  return outputs.source_text ?? outputs.source;
}

export function semanticCompletionTitle(
  kind: "generate-wiki" | "generate-study-guide" | "refresh-study-guide",
  title: string,
): string {
  return kind === "generate-wiki"
    ? `Wiki 已生成：${title}`
    : `学习材料已生成：${title}`;
}

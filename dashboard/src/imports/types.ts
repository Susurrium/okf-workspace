export type ImportIntent = "learn" | "wiki" | "source" | "later";
export type ImportQuality = "high" | "quick";
export type ImportParser = "auto" | "mineru" | "markitdown";

export interface DocumentImportOptions {
  intent: ImportIntent;
  quality: ImportQuality;
  parser: ImportParser;
  course?: string;
  project?: string;
  generate: boolean;
}

export interface DocumentImportResult {
  conversion_id: string;
  status: "queued" | "converting" | "waiting-for-mineru" | "ready" | "imported" | "failed";
  parser: "mineru" | "markitdown";
  source?: string;
  source_text?: string;
  routed_target?: string;
  outputs?: Record<string, string>;
  warnings?: string[];
  stages?: Record<string, string>;
  semantic_operation?: {
    operation_id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled" | "orphaned";
  } | null;
}

export const intentLabels: Record<ImportIntent, string> = {
  learn: "学习",
  wiki: "直接生成知识笔记",
  source: "只存来源",
  later: "暂不确定",
};

export const qualityLabels: Record<ImportQuality, string> = {
  high: "高级完整解析",
  quick: "MarkItDown 文本转换（默认）",
};

export const parserLabels: Record<ImportParser, string> = {
  auto: "按质量和文件类型选择",
  mineru: "指定 MinerU",
  markitdown: "指定 MarkItDown",
};

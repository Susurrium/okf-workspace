export type ImportIntent = "learn" | "wiki" | "source" | "later";
export type ImportQuality = "high" | "quick";
export type ImportParser = "auto" | "mineru" | "markitdown";
export type ConversionMethod = "mineru-cloud" | "markitdown-service" | "mineru-self-hosted";

export interface ConversionMethodInfo {
  id: ConversionMethod;
  label: string;
  parser: "mineru" | "markitdown";
  enabled: boolean;
  configured: boolean;
  status: "configured" | "not-configured";
  location: string;
  reason: string;
  limitations: string;
  extensions: string[];
  max_upload_bytes: number;
  capabilities: { ocr: boolean; page_map: boolean; pdf_images: boolean; office_images: boolean };
}

export interface ConverterCatalogue {
  default_method: ConversionMethod;
  methods: ConversionMethodInfo[];
}

export const methodLabels: Record<ConversionMethod, string> = {
  "mineru-cloud": "MinerU 云解析",
  "markitdown-service": "MarkItDown",
  "mineru-self-hosted": "MinerU 自建服务",
};

export interface DocumentImportOptions {
  /** Missing only on legacy requests, whose meaning remains conversion. */
  action?: "store" | "convert";
  intent: ImportIntent;
  quality: ImportQuality;
  parser: ImportParser;
  method?: ConversionMethod | "auto";
  course?: string;
  project?: string;
  generate: boolean;
  /** Device-only preference; never sent as a semantic decision. */
  keepOffline?: boolean;
}

export interface DocumentImportResult {
  conversion_id: string;
  status: "queued" | "converting" | "waiting-for-mineru" | "waiting-for-parser" | "ready" | "imported" | "failed";
  parser: "mineru" | "markitdown";
  method?: ConversionMethod;
  reused_existing?: boolean;
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
  high: "严格检查图片",
  quick: "标准检查",
};

export const parserLabels: Record<ImportParser, string> = {
  auto: "使用默认转换方式",
  mineru: "指定 MinerU 云解析",
  markitdown: "指定 MarkItDown",
};

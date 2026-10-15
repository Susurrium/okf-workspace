import type { ConversionRecord, SemanticOperationRecord } from "../api/types.js";
import { hasPendingGeneration } from "./inbox-work-queue.js";
import { isSemanticOperationActive, isSemanticOperationRetryable } from "./semantic-operation-state.js";

export function conversionRecovery(record: ConversionRecord): "generation" | "publish" | "convert" | undefined {
  if (hasPendingGeneration(record)) return "generation";
  if (record.status === "ready" || record.status === "failed" &&
    record.stages?.conversion === "completed" && record.stages.quality === "passed") return "publish";
  if (record.status === "failed" || record.status.startsWith("waiting-for-")) return "convert";
  return undefined;
}

export function conversionIsRunning(record: ConversionRecord): boolean {
  return ["queued", "converting", "waiting-for-mineru", "waiting-for-parser"].includes(record.status);
}

export function conversionHasFailure(record: ConversionRecord): boolean {
  return record.status === "failed" || hasPendingGeneration(record) && record.stages?.semantic === "failed";
}

export function semanticOperationActions(record: SemanticOperationRecord): { cancel: boolean; retry: boolean } {
  return { cancel: isSemanticOperationActive(record.status) && !["publishing", "indexing"].includes(record.stage ?? ""),
    retry: isSemanticOperationRetryable(record.status) };
}

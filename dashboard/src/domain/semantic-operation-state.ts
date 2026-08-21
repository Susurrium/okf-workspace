import type { SemanticOperationRecord } from "../api/types.js";

export type SemanticOperationUiState =
  | "active"
  | "retryable"
  | "completed"
  | "superseded";

/** One UI interpretation of the backend state machine, shared by every Dashboard surface. */
export function semanticOperationUiState(
  status: SemanticOperationRecord["status"],
): SemanticOperationUiState {
  if (status === "queued" || status === "running") return "active";
  if (status === "failed" || status === "cancelled" || status === "orphaned") {
    return "retryable";
  }
  return status === "completed" ? "completed" : "superseded";
}

export function isSemanticOperationActive(status: SemanticOperationRecord["status"]): boolean {
  return semanticOperationUiState(status) === "active";
}

export function isSemanticOperationRetryable(status: SemanticOperationRecord["status"]): boolean {
  return semanticOperationUiState(status) === "retryable";
}

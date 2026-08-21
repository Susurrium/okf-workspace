import { describe, expect, it } from "vitest";

import {
  isSemanticOperationActive,
  isSemanticOperationRetryable,
  semanticOperationUiState,
} from "../src/domain/semantic-operation-state.js";

describe("semantic operation UI state", () => {
  it("matches the backend cancel and retry state machine", () => {
    expect(isSemanticOperationActive("queued")).toBe(true);
    expect(isSemanticOperationActive("running")).toBe(true);
    expect(isSemanticOperationActive("orphaned")).toBe(false);
    expect(isSemanticOperationRetryable("failed")).toBe(true);
    expect(isSemanticOperationRetryable("cancelled")).toBe(true);
    expect(isSemanticOperationRetryable("orphaned")).toBe(true);
    expect(semanticOperationUiState("completed")).toBe("completed");
    expect(semanticOperationUiState("superseded")).toBe("superseded");
  });
});

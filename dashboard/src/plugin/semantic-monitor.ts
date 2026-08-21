import type { SemanticOperationRecord } from "../api/types.js";
import { isSemanticOperationActive } from "../domain/semantic-operation-state.js";

export interface SemanticTransition {
  operation: SemanticOperationRecord;
  previous: SemanticOperationRecord["status"];
}

/** Tracks only work observed as active, so historical completions never produce notices. */
export class SemanticOperationMonitor {
  private initialized = false;
  private readonly statuses = new Map<string, SemanticOperationRecord["status"]>();

  public seed(operations: SemanticOperationRecord[]): void {
    for (const operation of operations) {
      if (isSemanticOperationActive(operation.status)) {
        this.statuses.set(operation.operation_id, operation.status);
      }
    }
    this.initialized = true;
  }

  public watch(operation: SemanticOperationRecord): void {
    this.statuses.set(operation.operation_id, operation.status);
  }

  public update(operations: SemanticOperationRecord[]): SemanticTransition[] {
    if (!this.initialized) {
      this.seed(operations);
      return [];
    }
    const transitions: SemanticTransition[] = [];
    for (const operation of operations) {
      const previous = this.statuses.get(operation.operation_id);
      if (previous === undefined) {
        if (isSemanticOperationActive(operation.status)) {
          this.statuses.set(operation.operation_id, operation.status);
        }
        continue;
      }
      if (previous !== operation.status) {
        transitions.push({ operation, previous });
        this.statuses.set(operation.operation_id, operation.status);
      }
    }
    return transitions;
  }
}

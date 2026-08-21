import { describe, expect, it } from "vitest";

import type { SemanticOperationRecord } from "../src/api/types.js";
import { SemanticOperationMonitor } from "../src/plugin/semantic-monitor.js";

function operation(
  status: SemanticOperationRecord["status"],
  operationId = "op-one",
): SemanticOperationRecord {
  return {
    operation_id: operationId,
    kind: "generate-study-guide",
    status,
    target: "learning/guides/test.md",
    sources: ["sources/text/test.md"],
    actual_reads: [],
    updated_at: "2026-08-17T00:00:00Z",
  };
}

describe("SemanticOperationMonitor", () => {
  it("ignores historical completions but reports an observed task completing", () => {
    const monitor = new SemanticOperationMonitor();
    monitor.seed([operation("completed", "op-history"), operation("queued")]);

    expect(monitor.update([operation("running")])).toEqual([
      { operation: operation("running"), previous: "queued" },
    ]);
    expect(monitor.update([operation("completed")])).toEqual([
      { operation: operation("completed"), previous: "running" },
    ]);
  });

  it("tracks a task explicitly submitted by the current UI", () => {
    const monitor = new SemanticOperationMonitor();
    monitor.seed([]);
    monitor.watch(operation("queued"));

    expect(monitor.update([operation("completed")])[0]?.operation.status).toBe("completed");
  });
});

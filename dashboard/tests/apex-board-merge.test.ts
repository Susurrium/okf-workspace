import { describe, expect, it } from "vitest";

import { mergeBoardData } from "../apex/src/board-merge.js";
import { parse } from "../apex/src/parser.js";

const BOARD = `---
dashboard: true
workbench_schema: 1
columns:
  - id: todo-a
    name: Todo
    color: blue
    type: todo
---
## Todo
<!-- okf-section:todo-a -->
### Tasks
type: task
- [ ] one
`;

describe("board three-way merge", () => {
  it("keeps an external checklist completion while applying a local layout edit", () => {
    const base = parse(BOARD);
    const local = parse(BOARD);
    local.columns[0]!.height = 640;
    const remote = parse(BOARD.replace("- [ ] one", "- [x] one"));

    const result = mergeBoardData(base, local, remote);

    expect(result.conflicts).toEqual([]);
    expect(result.data.columns[0]?.height).toBe(640);
    expect(result.data.columns[0]?.cards[0]?.tasks[0]?.checked).toBe(true);
  });

  it("refuses to guess when local and external writers changed the same field", () => {
    const base = parse(BOARD);
    const local = parse(BOARD);
    const remote = parse(BOARD);
    local.columns[0]!.height = 500;
    remote.columns[0]!.height = 700;

    const result = mergeBoardData(base, local, remote);

    expect(result.conflicts).toContain("section.todo-a.height");
    expect(result.data.columns[0]?.height).toBe(700);
  });

  it("merges independent configuration edits and preserves an external unknown field", () => {
    const base = parse(BOARD);
    base.columns[0]!.extensionConfig = { pageSize: 5 };
    const local = structuredClone(base);
    local.columns[0]!.extensionConfig!.pageSize = 10;
    const remote = structuredClone(base);
    remote.columns[0]!.extensionConfig!.future = { retained: true };
    const result = mergeBoardData(base, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(result.data.columns[0]!.extensionConfig).toEqual({ pageSize: 10, future: { retained: true } });
    remote.columns[0]!.extensionConfig!.pageSize = 20;
    expect(mergeBoardData(base, local, remote).conflicts).toContain("section.todo-a.config.pageSize");
  });
});

import { describe, expect, it } from "vitest";

import {
  OKF_INBOX_SECTION_TYPE,
  OKF_KNOWLEDGE_SECTION_TYPE,
  OKF_LEARNING_SECTION_TYPE,
  workspaceSectionCounts,
} from "../src/features/workspace/workspace-sections.js";

describe("native OKF workspace sections", () => {
  it("uses stable machine types and derives counts only from projections", () => {
    expect([OKF_INBOX_SECTION_TYPE, OKF_LEARNING_SECTION_TYPE, OKF_KNOWLEDGE_SECTION_TYPE]).toEqual([
      "workspace-inbox",
      "workspace-learning",
      "workspace-knowledge",
    ]);
    expect(workspaceSectionCounts({ pending: [1, 2], ready: [3], completed: [] })).toEqual({
      pending: 2,
      ready: 1,
      completed: 0,
    });
  });
});

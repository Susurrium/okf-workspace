import { describe, expect, it } from "vitest";

import { ORGANIZE_DAILY_PROMPT } from "../src/plugin/workflow-prompts.js";

describe("workflow prompts", () => {
  it("keeps the organized summary managed while extracting explicit tasks separately", () => {
    expect(ORGANIZE_DAILY_PROMPT).toContain("organized-daily");
    expect(ORGANIZE_DAILY_PROMPT).toContain("## 任务");
    expect(ORGANIZE_DAILY_PROMPT).toContain("- [ ] #task");
    expect(ORGANIZE_DAILY_PROMPT).toContain("不要把普通想法或 AI 建议变成任务");
  });
});

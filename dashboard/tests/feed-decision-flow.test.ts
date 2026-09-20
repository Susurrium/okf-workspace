import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { renderFeedDecisionFlow, type FeedDecisionFlowActions } from "../src/ui/feed-decision-flow.js";
import { editorFeedMapping } from "../src/plugin/live-preview.js";
import { TestElement, TFile } from "./obsidian-runtime.js";

function mount(overrides: Partial<FeedDecisionFlowActions> = {}) {
  const controls = new TestElement(); const status = new TestElement();
  const actions: FeedDecisionFlowActions = { load: async () => undefined,
    decide: vi.fn(async () => ({ item_id: "a", action: "ignore" as const })),
    openPath: vi.fn(async () => {}), notify: vi.fn(), ...overrides };
  renderFeedDecisionFlow(controls as unknown as HTMLElement, status as unknown as HTMLElement, actions);
  const click = (text: string) => {
    const button = controls.descendants().find((entry) => entry.tagName === "button" && entry.textContent === text);
    if (!button) throw new Error(`Missing button ${text}`); button.click();
  };
  return { controls, status, actions, click };
}

describe("shared Feed decisions", () => {
  it("restores a saved deferred decision and supports the same follow-up generation", async () => {
    const flow = mount({ load: async () => ({ item_id: "a", action: "learn-later", study_guide: "learning/guides/a.md" }) });
    await vi.waitFor(() => expect(flow.controls.descendants().some((item) => item.textContent === "现在生成学习材料")).toBe(true));
    flow.click("现在生成学习材料");
    await vi.waitFor(() => expect(flow.actions.decide).toHaveBeenCalledWith("learn-now"));
  });

  it("keeps a failed decision visible and offers normal actions for retry", async () => {
    const flow = mount({ decide: vi.fn(async () => { throw new Error("offline"); }) });
    await vi.waitFor(() => expect(flow.controls.children).toHaveLength(2));
    flow.click("想学习"); flow.click("稍后学习");
    await vi.waitFor(() => expect(flow.status.textContent).toBe("处理失败：offline"));
    expect(flow.controls.descendants().map((item) => item.textContent)).toContain("想学习");
  });

  it("does not pretend saved history is empty when loading it fails", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const flow = mount({ load });
    await vi.waitFor(() => expect(flow.status.textContent).toContain("offline"));
    expect(flow.controls.descendants().map((item) => item.textContent)).not.toContain("想学习");
    flow.click("重新读取");
    await vi.waitFor(() => expect(flow.controls.descendants().map((item) => item.textContent)).toContain("想学习"));
  });

  it("uses the widget editor file even if another split pane is active", () => {
    const owner = new TFile("feeds/owner.md"); const active = new TFile("feeds/other.md");
    const app = { workspace: { getActiveFile: () => active }, metadataCache: { getFileCache: (file: TFile) => ({
      frontmatter: { feed: "treehole", items: [{ id: file === owner ? "owner-id" : "wrong-id", block_id: "treehole-1" }] },
    }) } } as unknown as App;
    expect(editorFeedMapping(app, owner as never, "treehole-1")?.id).toBe("owner-id");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  buildClaudianFallbackText,
  ClaudianBridgeAdapter,
  type CodexHandoffRequest,
} from "../src/plugin/claudian-bridge.js";

function appWithPlugin(plugin: unknown) {
  return {
    plugins: {
      getPlugin: vi.fn((id: string) => id === "okf-claudian" ? plugin : null),
    },
  } as never;
}

describe("ClaudianBridgeAdapter", () => {
  it("forwards a handoff through the version 1 Claudian contract", async () => {
    const result = {
      accepted: true as const,
      sent: false,
      contextCount: 1,
      actionMode: "read" as const,
      skill: "source-review",
    };
    const handoff = vi.fn(async (_request: CodexHandoffRequest) => result);
    const adapter = new ClaudianBridgeAdapter(appWithPlugin({
      okfBridge: { version: 1, open: vi.fn(), handoff },
    }));
    const request: CodexHandoffRequest = {
      prompt: "Review the source",
      contextPaths: ["sources/example.md"],
      actionMode: "read",
      skill: "source-review",
      autoSend: false,
      newSession: true,
    };

    await expect(adapter.handoff(request)).resolves.toBe(result);
    expect(handoff).toHaveBeenCalledWith(request);
  });

  it.each([
    [null, "plugin is absent"],
    [{ okfBridge: { version: 2, open: vi.fn(), handoff: vi.fn() } }, "version is incompatible"],
    [{ okfBridge: { version: 1, open: vi.fn() } }, "handoff method is absent"],
  ])("reports unavailable Claudian when the bridge is not usable", async (plugin, _reason) => {
    const adapter = new ClaudianBridgeAdapter(appWithPlugin(plugin));

    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.handoff({ prompt: "Review" })).rejects.toThrow(
      "Claudian 面板未启用或版本不兼容",
    );
  });
});

describe("buildClaudianFallbackText", () => {
  it("preserves prompt, action mode, skill and Vault context paths", () => {
    const text = buildClaudianFallbackText({
      prompt: "  Review the source  ",
      actionMode: "plan",
      skill: "source-review",
      contextPaths: ["sources/example.md", "Wiki/topic.md"],
    });

    expect(text).toBe(
      "Review the source\n\n模式：plan\n技能：source-review\n\n上下文文件：\n- sources/example.md\n- Wiki/topic.md",
    );
  });
});

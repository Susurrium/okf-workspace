import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { ClaudianBridgeAdapter } from "../src/plugin/claudian-bridge.js";

describe("ClaudianBridgeAdapter", () => {
  it("passes structured context and authority through the public OKF bridge", async () => {
    const handoff = vi.fn().mockResolvedValue({
      accepted: true,
      sent: false,
      contextCount: 1,
      actionMode: "write",
      skill: "distill-wiki",
    });
    const app = {
      plugins: {
        getPlugin: vi.fn().mockReturnValue({
          okfBridge: { version: 1, open: vi.fn(), handoff },
        }),
      },
    } as unknown as App;
    const adapter = new ClaudianBridgeAdapter(app);

    await expect(
      adapter.handoff({
        prompt: "整理长期知识",
        contextPaths: ["sources/extracts/example.md"],
        actionMode: "write",
        skill: "distill-wiki",
        autoSend: false,
        newSession: true,
      }),
    ).resolves.toMatchObject({ accepted: true, sent: false });
    expect(handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPaths: ["sources/extracts/example.md"],
        actionMode: "write",
      }),
    );
  });

  it("fails clearly instead of falling back to terminal or clipboard", async () => {
    const app = {
      plugins: { getPlugin: vi.fn().mockReturnValue(null) },
    } as unknown as App;
    const adapter = new ClaudianBridgeAdapter(app);

    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.handoff({ prompt: "test" })).rejects.toThrow("Claudian 面板");
  });
});

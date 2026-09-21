import type { App } from "obsidian";

export type CodexActionMode = "read" | "write" | "plan";

export interface CodexHandoffRequest {
  prompt?: string;
  contextPaths?: readonly string[];
  actionMode?: CodexActionMode;
  skill?: string;
  autoSend?: boolean;
  newSession?: boolean;
}

export interface CodexHandoffResult {
  accepted: true;
  sent: boolean;
  contextCount: number;
  actionMode: CodexActionMode;
  skill: string | null;
}

export function buildClaudianFallbackText(request: CodexHandoffRequest): string {
  const context = request.contextPaths?.length
    ? `\n\n上下文文件：\n${request.contextPaths.map((path) => `- ${path}`).join("\n")}`
    : "";
  const instructions = [
    request.actionMode ? `模式：${request.actionMode}` : "",
    request.skill ? `技能：${request.skill}` : "",
  ].filter(Boolean).join("\n");
  return [request.prompt?.trim() || "继续处理当前上下文。", instructions, context.trim()]
    .filter(Boolean)
    .join("\n\n");
}

interface OkfClaudianBridge {
  version: 1;
  open(): Promise<void>;
  handoff(request: CodexHandoffRequest): Promise<CodexHandoffResult>;
}

interface OkfClaudianPlugin {
  okfBridge?: OkfClaudianBridge;
}

interface AppWithPlugins extends App {
  plugins?: {
    getPlugin(id: string): unknown;
  };
}

const PLUGIN_ID = "okf-claudian";

/** Stable, public boundary between Dashboard and the embedded Claudian UI. */
export class ClaudianBridgeAdapter {
  public constructor(private readonly app: App) {}

  public isAvailable(): boolean {
    return this.bridge() !== null;
  }

  public async open(): Promise<void> {
    await this.requireBridge().open();
  }

  public async handoff(request: CodexHandoffRequest): Promise<CodexHandoffResult> {
    return this.requireBridge().handoff(request);
  }

  private requireBridge(): OkfClaudianBridge {
    const bridge = this.bridge();
    if (!bridge) {
      throw new Error(
        "Claudian 面板未启用或版本不兼容；请启用 okf-claudian 后重新加载 Obsidian。",
      );
    }
    return bridge;
  }

  private bridge(): OkfClaudianBridge | null {
    const plugin = (this.app as AppWithPlugins).plugins?.getPlugin(PLUGIN_ID) as
      | OkfClaudianPlugin
      | null
      | undefined;
    const bridge = plugin?.okfBridge;
    if (
      bridge?.version !== 1 ||
      typeof bridge.open !== "function" ||
      typeof bridge.handoff !== "function"
    ) {
      return null;
    }
    return bridge;
  }
}

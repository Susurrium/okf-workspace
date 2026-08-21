export type EmbeddedPreviewState =
  | { status: "idle"; markdown: "" }
  | { status: "loading"; markdown: "" }
  | { status: "ready"; markdown: string }
  | { status: "error"; markdown: string; error: string };

/**
 * The V1 race-safe preview behavior, expressed without an Obsidian dependency
 * so the same model can drive Dashboard and plugin renderers.
 */
export class AiDailyEmbeddedPreview {
  private generation = 0;
  private current: EmbeddedPreviewState = { status: "idle", markdown: "" };

  public state(): EmbeddedPreviewState {
    return this.current;
  }

  public async render(load: () => Promise<string>): Promise<EmbeddedPreviewState> {
    const generation = ++this.generation;
    this.current = { status: "loading", markdown: "" };
    try {
      const markdown = await load();
      if (generation !== this.generation) return this.current;
      if (!markdown.trim()) throw new Error("本期内容为空");
      this.current = { status: "ready", markdown };
    } catch (error) {
      if (generation !== this.generation) return this.current;
      this.current = {
        status: "error",
        markdown: "",
        error: error instanceof Error ? error.message : "无法加载预览",
      };
    }
    return this.current;
  }

  public destroy(): void {
    this.generation += 1;
    this.current = { status: "idle", markdown: "" };
  }
}

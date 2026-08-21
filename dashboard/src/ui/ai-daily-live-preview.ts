import { feedBlockIdsInMarkdown } from "../domain/ai-daily-reading-note.js";

export interface AiDailyLivePreviewTarget {
  blockId: string;
  line: number;
}

/** Locate stable item blocks for inline controls in an Obsidian Live Preview adapter. */
export function scanAiDailyLivePreview(markdown: string): AiDailyLivePreviewTarget[] {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const valid = new Set(feedBlockIdsInMarkdown(markdown));
  const targets: AiDailyLivePreviewTarget[] = [];
  lines.forEach((line, index) => {
    const match = /^\s*\^(feed-[a-f0-9]{12})\s*$/u.exec(line);
    const blockId = match?.[1];
    if (blockId && valid.has(blockId)) targets.push({ blockId, line: index + 1 });
  });
  return targets;
}

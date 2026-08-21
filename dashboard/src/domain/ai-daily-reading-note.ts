import type { AiDailyStream } from "../feeds/types.js";

const ISSUE_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function expectedAiDailyReadingNotePath(
  issueDate: string,
  stream: AiDailyStream,
): string {
  if (!ISSUE_DATE.test(issueDate)) throw new Error("AI Daily issue date is invalid");
  return `feeds/ai-daily/${issueDate.slice(0, 4)}/${issueDate}-${stream}.md`;
}

export function aiDailyReadingNoteLink(
  issueDate: string,
  stream: AiDailyStream,
  blockId?: string,
): string {
  const path = expectedAiDailyReadingNotePath(issueDate, stream);
  return blockId ? `${path}#^${validateFeedBlockId(blockId)}` : path;
}

export function validateFeedBlockId(value: string): string {
  if (!/^feed-[a-f0-9]{12}$/u.test(value)) {
    throw new Error("AI Daily block ID is invalid");
  }
  return value;
}

export function feedBlockIdsInMarkdown(source: string): string[] {
  const ids: string[] = [];
  for (const match of source.matchAll(/(?:^|[ \t])\^(feed-[a-f0-9]{12})(?=[ \t]*$)/gmu)) {
    const blockId = match[1];
    if (blockId && !ids.includes(blockId)) ids.push(blockId);
  }
  return ids;
}

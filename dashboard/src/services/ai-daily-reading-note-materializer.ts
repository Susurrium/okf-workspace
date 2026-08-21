import type { FeedApi, OpenedFeedDigest } from "../feeds/service.js";
import type { AiDailyStream } from "../feeds/types.js";

export interface NativeNoteOpener {
  open(path: string, blockId?: string): Promise<void>;
}

/**
 * Opening delegates the one authoritative materialization to the backend. V1's
 * full-note experience remains, without byte hashes, seals, or identity gates.
 */
export async function materializeAiDailyReadingNote(
  api: FeedApi,
  opener: NativeNoteOpener,
  issueDate: string,
  stream: AiDailyStream,
  blockId?: string,
): Promise<OpenedFeedDigest> {
  const digest = await api.openDigest("ai-daily", `${issueDate}-${stream}`);
  await opener.open(digest.vault_path, blockId);
  return digest;
}

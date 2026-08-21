import type { FeedApi, OpenedFeedDigest } from "../feeds/service.js";
import type { NativeNoteOpener } from "./ai-daily-reading-note-materializer.js";

export async function materializeTreeholeBatchNote(
  api: FeedApi,
  opener: NativeNoteOpener,
  snapshotId: string,
  pid?: number,
): Promise<OpenedFeedDigest> {
  const digest = await api.openDigest("treehole", snapshotId);
  await opener.open(digest.vault_path, pid === undefined ? undefined : `treehole-${pid}`);
  return digest;
}

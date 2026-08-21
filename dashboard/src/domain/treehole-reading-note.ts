const SNAPSHOT = /^[\w.-]+$/u;

export function expectedTreeholeReadingNotePath(
  editionAt: string,
  snapshotId: string,
): string {
  if (!/^\d{4}-\d{2}-\d{2}/u.test(editionAt) || !SNAPSHOT.test(snapshotId)) {
    throw new Error("TreeHole edition identity is invalid");
  }
  return `feeds/treehole/${editionAt.slice(0, 4)}/${snapshotId}.md`;
}

export function treeholeBlockId(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("TreeHole PID is invalid");
  return `treehole-${pid}`;
}

export function treeholeReadingNoteLink(
  editionAt: string,
  snapshotId: string,
  pid?: number,
): string {
  const path = expectedTreeholeReadingNotePath(editionAt, snapshotId);
  return pid === undefined ? path : `${path}#^${treeholeBlockId(pid)}`;
}

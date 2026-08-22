export interface FeedItemMapping {
  id: string;
  block_id: string;
}

/** Read canonical Digest mappings while remaining compatible with pre-contract notes. */
export function feedItemMappings(frontmatter: unknown): FeedItemMapping[] {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  const record = frontmatter as Record<string, unknown>;
  const value = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.feed_items)
      ? record.feed_items
      : [];
  return value.filter((candidate): candidate is FeedItemMapping => {
    if (!candidate || typeof candidate !== "object") return false;
    const mapping = candidate as Record<string, unknown>;
    return typeof mapping.id === "string" && typeof mapping.block_id === "string";
  });
}

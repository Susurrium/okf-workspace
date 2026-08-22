import type { FeedDecisionResult } from "./types.js";

/**
 * A Feed synchronization changes available editions, not durable decisions.
 * Keep confirmed receipts so retained Reading history does not lose its badge,
 * while evicting cached misses so decisions created elsewhere can be discovered.
 */
export function evictUnresolvedFeedDecisions(
  cache: Map<string, FeedDecisionResult | undefined>,
): void {
  for (const [key, value] of cache) {
    if (value === undefined) cache.delete(key);
  }
}

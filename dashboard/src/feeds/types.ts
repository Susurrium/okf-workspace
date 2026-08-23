export type FeedKind = "ai-daily" | "treehole";
export type FeedDecisionAction =
  | "learn-now"
  | "learn-later"
  | "wiki-now"
  | "source-only"
  | "ignore";

/** Read-only compatibility for receipts created before `later` was removed. */
export type FeedDecisionReceiptAction = FeedDecisionAction | "later";

export interface FeedComment {
  text: string;
  cid?: number;
  author?: string;
  is_original_poster: boolean;
  published_at?: string;
  reply_to_cid?: number;
  reply_to_author?: string;
  reply_to_text?: string;
  media: string[];
}

export interface FeedItem {
  item_id: string;
  feed: FeedKind;
  digest_id: string;
  title: string;
  body: string;
  url?: string;
  published_at?: string;
  stream?: AiDailyStream;
  pid?: number;
  metrics: Record<string, number | string>;
  comments: FeedComment[];
  media: string[];
  decision?: FeedDecisionReceiptAction;
}

export interface FeedDigest {
  digest_id: string;
  feed: FeedKind;
  issued_at: string;
  title: string;
  items: FeedItem[];
  section?: AiDailyStream;
  quality?: string;
  quality_reason?: string;
}

export interface FeedDigestSummary {
  digest_id: string;
  issued_at: string;
  title: string;
  section?: AiDailyStream;
  item_count: number;
}

export interface FeedDigestItem {
  item_id: string;
  block_id: string;
  title: string;
  summary: string;
  url?: string | null;
  source: string;
  source_id?: string | null;
  source_name?: string | null;
  native_section?: string | null;
  published_at?: string | null;
  section?: AiDailyStream | null;
  pid?: number | null;
  metrics: Record<string, number | string>;
  comment_count: number;
  media_count: number;
  decision?: FeedDecisionReceiptAction | null;
}

export interface FeedDigestEdition {
  digest_id: string;
  issued_at: string;
  title: string;
  section?: AiDailyStream | null;
  quality?: string | null;
  quality_reason?: string | null;
  item_count: number;
  items: FeedDigestItem[];
}

export interface FeedDashboardDigest {
  ai_daily: FeedDigestEdition[];
  treehole: FeedDigestEdition | null;
}

export interface FeedSubscriptionPage {
  section: "learning";
  source_id?: string | null;
  catalog_complete?: boolean | null;
  catalog_indexing?: boolean | null;
  total_editions?: number | null;
  editions: FeedDigestEdition[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface FeedSubscriptionPageQuery {
  limit?: number;
  cursor?: string;
  source_id?: string;
}

export interface FeedSubscriptionSource {
  source_id: string;
  source_name: string;
  latest_issued_at: string;
  latest_digest_id: string;
  latest_revision?: string;
  quality?: string | null;
  quality_reason?: string | null;
  latest_item_count: number;
  pending_decision_count: number;
  edition_count: number;
  native_section_counts: Record<string, number>;
  preview_items: FeedDigestItem[];
}

export interface FeedSubscriptionSourceItemsPage {
  source_id: string;
  digest_id: string;
  latest_revision?: string;
  issued_at: string;
  item_count: number;
  items: FeedDigestItem[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface FeedSubscriptionSourceItemsQuery {
  limit?: number;
  cursor?: string;
}

export interface FeedSubscriptionSourcePage {
  section: "learning";
  latest_items_pagination?: boolean;
  catalog_complete?: boolean;
  catalog_indexing?: boolean;
  sources: FeedSubscriptionSource[];
  total_sources: number;
  matched_sources: number;
  next_cursor: string | null;
  has_more: boolean;
}

export interface FeedSubscriptionSourcePageQuery {
  limit?: number;
  cursor?: string;
  query?: string;
}

export interface FeedSyncSuccess {
  feed: FeedKind;
  status: "ok";
  digest_id: string;
  issued_at: string;
  item_count: number;
}

export interface FeedSyncFailure {
  feed: FeedKind;
  status: "error";
  section: string | null;
  detail: string;
}

export type FeedSyncResult = FeedSyncSuccess | FeedSyncFailure;

export interface FeedDecisionResult {
  item_id: string;
  action: FeedDecisionReceiptAction;
  source?: string;
  source_text?: string;
  study_guide?: string;
  wiki?: string;
  semantic_operation?: {
    operation_id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled" | "orphaned";
  };
  warnings?: string[];
}

export type AiDailyStream = "hotspot" | "news" | "learning";

export interface AiDailyIssueStream {
  stream: AiDailyStream;
  label: string;
  total_count: number;
  items: FeedItem[];
}

export interface AiDailyReadingPosition {
  artifact_id: string;
  updated_at: string;
}

export interface AiDailyIssue {
  issue_date: string;
  title: string;
  streams: AiDailyIssueStream[];
  reading_positions: Partial<Record<AiDailyStream, AiDailyReadingPosition>>;
}

export interface TreeholePreviewItem extends FeedItem {
  feed: "treehole";
  pid: number;
}

export interface TreeholeBatchPreview extends FeedDigest {
  feed: "treehole";
  items: TreeholePreviewItem[];
}

export type IngestedVia = "web-clip" | "file-import" | "feed" | "direct-entry";

export interface SourceUse {
  purpose: string;
  course?: string | null;
  project?: string | null;
}

export interface NoteSummary {
  path: string;
  title: string;
  note_type: string;
  status: string;
  studied_at?: string | null;
  material_ready?: boolean;
  ai_unverified?: boolean;
  project_status?: string | null;
  course_status?: string | null;
  capture_status?: string | null;
  purpose?: string | null;
  ingested_via?: IngestedVia | null;
  resource?: string | null;
  kind?: string | null;
  course?: string | null;
  project?: string | null;
  uses?: SourceUse[];
  created_at?: string | null;
  modified_at?: string;
  stale_after?: string | null;
  stale: boolean;
  topics?: string[];
  source_paths?: string[];
  excerpt: string;
}

export interface ProjectSummary extends NoteSummary {
  current_state: string;
  next_action: string;
  recent_log: string;
  log_path: string;
  decisions: string[];
  outputs: string[];
  /** Study Guide notes linked to this Project; never Sources or project assets. */
  related_learning: NoteSummary[];
  /** Source notes linked to this Project; never Study Guides, Decisions, or Outputs. */
  related_materials: NoteSummary[];
  pending_captures: NoteSummary[];
}

export interface CourseSummary extends NoteSummary {
  related_learning?: NoteSummary[];
  lessons?: NoteSummary[];
  current_progress: string;
  guide_count: number;
  lesson_count: number;
  latest_lesson?: NoteSummary;
  /** Source notes linked to this Course, independent of their workflow purpose. */
  related_sources: NoteSummary[];
  pending_captures: NoteSummary[];
}

/** Counts Learning queue entries, not all notes or all related Sources in the Vault. */
export interface LearningScopeEntryCounts {
  all: number;
  course: number;
  project: number;
  independent: number;
}

export interface LearningProjection {
  pending_guides: NoteSummary[];
  ready_guides: NoteSummary[];
  completed_guides: NoteSummary[];
  scope_entry_counts: LearningScopeEntryCounts;
  courses: CourseSummary[];
  projects: ProjectSummary[];
}

export interface TaskItem {
  path: string;
  line: number;
  text: string;
}

export interface TodayFeedSummary {
  digest_id: string;
  issued_at: string;
  title: string;
  section?: "hotspot" | "news" | "learning";
  item_count: number;
}

export interface TodayView {
  date: string;
  daily: { path: string; exists: boolean };
  tasks: TaskItem[];
  active_projects: ProjectSummary[];
  active_courses?: CourseSummary[];
  recent_study: NoteSummary[];
  open_inbox_count: number;
  latest_ai_daily?: TodayFeedSummary | null;
  latest_ai_daily_streams?: TodayFeedSummary[];
  latest_treehole?: TodayFeedSummary | null;
  stale_knowledge: NoteSummary[];
}

export interface LocalTodayView {
  date: string;
  daily: { path: string; exists: boolean };
  daily_excerpt: string;
  tasks: TaskItem[];
  active_projects: ProjectSummary[];
  active_courses: CourseSummary[];
  recent_study: NoteSummary[];
  open_inbox_count: number;
  pending_study_count: number;
  pending_wiki_count: number;
  stale_knowledge: NoteSummary[];
}

export interface SystemItem {
  item_id: string;
  label: string;
  status: string;
  detail: string;
  action?: string | null;
}

export interface SystemStatus {
  checked_at: string;
  version: string;
  items: SystemItem[];
  actionable: SystemItem[];
}

export type ConversionStatus =
  | "queued"
  | "converting"
  | "waiting-for-mineru"
  | "ready"
  | "imported"
  | "failed";

export interface ConversionRecord {
  conversion_id: string;
  status: ConversionStatus;
  source_filename: string;
  intent: string;
  quality: string;
  parser: string;
  error?: string | null;
  warnings?: string[];
  stages?: Record<string, string>;
  parser_attempts?: {
    parser: string;
    status: string;
    started_at: string;
    duration_ms: number;
    error?: string | null;
  }[];
  updated_at?: string;
  outputs: Record<string, string>;
}

export interface SemanticOperationRecord {
  operation_id: string;
  kind: "generate-study-guide" | "refresh-study-guide" | "generate-wiki";
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "orphaned"
    | "superseded";
  stage?:
    | "queued"
    | "retrieving"
    | "generating"
    | "publishing"
    | "indexing"
    | "completed"
    | "failed"
    | "cancelled";
  stage_detail?: string | null;
  stage_started_at?: string | null;
  target: string;
  sources: string[];
  course?: string | null;
  project?: string | null;
  error?: string | null;
  actual_reads: string[];
  created_at?: string;
  started_at?: string | null;
  updated_at: string;
}

export type WebCaptureAction = "learn-now" | "learn-later" | "wiki-now" | "source-only";

export interface WebCapturePublishResult {
  action: WebCaptureAction;
  source: string;
  source_text: string;
  routed_target?: string | null;
  reused: boolean;
  semantic_operation?: SemanticOperationRecord | null;
  semantic_error?: string | null;
}

export interface GovernanceReport {
  issue_count: number;
  issues: {
    code: string;
    path: string;
    detail: string;
    severity: string;
  }[];
}

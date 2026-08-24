export const DASHBOARD_SECTIONS = [
  "today",
  "inbox",
  "reading",
  "learning",
  "projects",
  "knowledge",
  "life",
  "system",
] as const;

export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number];
export const DASHBOARD_FEEDS = [
  "ai-daily",
  "ai-daily-hotspot",
  "ai-daily-news",
  "ai-daily-learning",
  "ai-daily-papers",
  "treehole",
] as const;
export type DashboardFeed = (typeof DASHBOARD_FEEDS)[number];
export type DashboardFilterValue = string | number | boolean;

export interface DashboardPageUiState {
  scrollTop: number;
  filters: Record<string, DashboardFilterValue>;
  tab?: string;
}

export interface DashboardFeedUiState {
  scrollTop: number;
  editionId?: string;
  itemId?: string;
  updatedAt?: string;
}

export interface DashboardReadingSourceUiState {
  digestId: string;
  scrollTop: number;
  updatedAt?: string;
}

export interface RecentDashboardFile {
  path: string;
  openedAt: string;
}

export interface DashboardUiState {
  version: 1;
  activeSection: DashboardSection;
  pages: Record<DashboardSection, DashboardPageUiState>;
  feeds: Record<DashboardFeed, DashboardFeedUiState>;
  readingSources: Record<string, DashboardReadingSourceUiState>;
  recentFiles: RecentDashboardFile[];
}

export interface DashboardPageUiStatePatch {
  scrollTop?: number;
  filters?: Record<string, DashboardFilterValue | null | undefined>;
  tab?: string | null;
}

export interface DashboardFeedUiStatePatch {
  scrollTop?: number;
  editionId?: string | null;
  itemId?: string | null;
  updatedAt?: string | null;
}

export interface DashboardReadingSourceUiStatePatch {
  digestId?: string | null;
  scrollTop?: number;
  updatedAt?: string | null;
}

export interface DashboardUiStatePatch {
  activeSection?: DashboardSection;
  pages?: Partial<Record<DashboardSection, DashboardPageUiStatePatch>>;
  feeds?: Partial<Record<DashboardFeed, DashboardFeedUiStatePatch>>;
  readingSources?: Record<string, DashboardReadingSourceUiStatePatch | null>;
  recentFiles?: readonly RecentDashboardFile[];
}

export interface LegacyFeedReadingPosition {
  editionId: string;
  itemId: string;
  updatedAt: string;
}

export type LegacyFeedReadingPositions = Partial<
  Record<"ai-daily" | "treehole", LegacyFeedReadingPosition>
>;

const RECENT_FILE_LIMIT = 50;
const READING_SOURCE_SCROLL_LIMIT = 32;
const CONTINUATION_ROOTS = new Set([
  "feeds",
  "inbox",
  "knowledge",
  "learning",
  "life",
  "projects",
  "self",
]);

export function createDefaultDashboardUiState(): DashboardUiState {
  return {
    version: 1,
    activeSection: "today",
    pages: Object.fromEntries(
      DASHBOARD_SECTIONS.map((section) => [
        section,
        { scrollTop: 0, filters: {} },
      ]),
    ) as Record<DashboardSection, DashboardPageUiState>,
    feeds: {
      "ai-daily": { scrollTop: 0 },
      "ai-daily-hotspot": { scrollTop: 0 },
      "ai-daily-news": { scrollTop: 0 },
      "ai-daily-learning": { scrollTop: 0 },
      "ai-daily-papers": { scrollTop: 0 },
      treehole: { scrollTop: 0 },
    },
    readingSources: {},
    recentFiles: [],
  };
}

export function normalizeDashboardUiState(
  value: unknown,
  legacyFeedPositions: unknown = undefined,
): DashboardUiState {
  const defaults = createDefaultDashboardUiState();
  const record = objectValue(value);
  const legacy = objectValue(legacyFeedPositions);
  const activeSection = isDashboardSection(record?.activeSection)
    ? record.activeSection
    : defaults.activeSection;
  const storedPages = objectValue(record?.pages);
  const pages = { ...defaults.pages };
  for (const section of DASHBOARD_SECTIONS) {
    pages[section] = normalizePageState(storedPages?.[section]);
  }
  const storedFeeds = objectValue(record?.feeds);
  const aiDaily = normalizeFeedState(storedFeeds?.["ai-daily"], legacy?.["ai-daily"]);
  const feeds: Record<DashboardFeed, DashboardFeedUiState> = {
    "ai-daily": aiDaily,
    // Older releases had one scroll position for every AI Daily stream. Use it
    // only as the initial fallback; each surface is persisted independently
    // after the first interaction.
    "ai-daily-hotspot": normalizeFeedState(
      storedFeeds?.["ai-daily-hotspot"],
      { scrollTop: aiDaily.scrollTop },
    ),
    "ai-daily-news": normalizeFeedState(
      storedFeeds?.["ai-daily-news"],
      { scrollTop: aiDaily.scrollTop },
    ),
    "ai-daily-learning": normalizeFeedState(
      storedFeeds?.["ai-daily-learning"],
      { scrollTop: aiDaily.scrollTop },
    ),
    "ai-daily-papers": normalizeFeedState(
      storedFeeds?.["ai-daily-papers"],
      undefined,
    ),
    treehole: normalizeFeedState(storedFeeds?.treehole, legacy?.treehole),
  };
  return {
    version: 1,
    activeSection,
    pages,
    feeds,
    readingSources: normalizeReadingSources(record?.readingSources),
    recentFiles: normalizeRecentFiles(record?.recentFiles),
  };
}

export function patchDashboardUiState(
  state: DashboardUiState,
  patch: DashboardUiStatePatch,
): DashboardUiState {
  const current = normalizeDashboardUiState(state);
  const pages = { ...current.pages };
  for (const section of DASHBOARD_SECTIONS) {
    const pagePatch = patch.pages?.[section];
    if (!pagePatch) continue;
    pages[section] = patchPageState(current.pages[section], pagePatch);
  }
  const feeds = Object.fromEntries(
    DASHBOARD_FEEDS.map((feed) => [
      feed,
      patchFeedState(current.feeds[feed], patch.feeds?.[feed]),
    ]),
  ) as Record<DashboardFeed, DashboardFeedUiState>;
  const readingSources = patchReadingSources(current.readingSources, patch.readingSources);
  return {
    version: 1,
    activeSection: isDashboardSection(patch.activeSection)
      ? patch.activeSection
      : current.activeSection,
    pages,
    feeds,
    readingSources,
    recentFiles: patch.recentFiles === undefined
      ? current.recentFiles
      : normalizeRecentFiles(patch.recentFiles),
  };
}

function patchReadingSources(
  current: Record<string, DashboardReadingSourceUiState>,
  patches: Record<string, DashboardReadingSourceUiStatePatch | null> | undefined,
): Record<string, DashboardReadingSourceUiState> {
  if (!patches) return normalizeReadingSources(current);
  const entries = new Map(Object.entries(current));
  for (const [rawSourceId, patch] of Object.entries(patches)) {
    const sourceId = textValue(rawSourceId);
    if (!sourceId || sourceId.length > 512) continue;
    if (patch === null) {
      entries.delete(sourceId);
      continue;
    }
    const previous = entries.get(sourceId);
    const digestId = patch.digestId === undefined
      ? previous?.digestId
      : textValue(patch.digestId);
    if (!digestId) {
      entries.delete(sourceId);
      continue;
    }
    const updatedAt = patch.updatedAt === undefined
      ? previous?.updatedAt
      : timestampValue(patch.updatedAt);
    entries.set(sourceId, {
      digestId,
      scrollTop: patch.scrollTop === undefined
        ? previous?.scrollTop ?? 0
        : scrollValue(patch.scrollTop),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }
  return normalizeReadingSources(Object.fromEntries(entries));
}

export function recordRecentDashboardFile(
  state: DashboardUiState,
  path: string,
  openedAt = new Date().toISOString(),
): DashboardUiState {
  const normalizedPath = normalizeVaultPath(path);
  if (!isContinuationMarkdownPath(normalizedPath)) return normalizeDashboardUiState(state);
  const normalizedOpenedAt = validTimestamp(openedAt) ? openedAt : new Date().toISOString();
  const key = normalizedPath.toLocaleLowerCase();
  const recentFiles = [
    { path: normalizedPath, openedAt: normalizedOpenedAt },
    ...state.recentFiles.filter((entry) => entry.path.toLocaleLowerCase() !== key),
  ].slice(0, RECENT_FILE_LIMIT);
  return patchDashboardUiState(state, { recentFiles });
}

export function isContinuationMarkdownPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized.toLocaleLowerCase().endsWith(".md")) return false;
  const [root, ...parts] = normalized.split("/");
  if (!root || !parts.length || !CONTINUATION_ROOTS.has(root.toLocaleLowerCase())) return false;
  if (parts.at(-1)?.toLocaleLowerCase() === "index.md") return false;
  return !parts.some((part) => part.startsWith("."));
}

export class DashboardUiStateStore {
  private state: DashboardUiState;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private persistQueue: Promise<void> = Promise.resolve();
  private dirty = false;

  public constructor(
    initialState: DashboardUiState,
    private readonly persist: (state: DashboardUiState) => Promise<void>,
    private readonly debounceMs = 400,
    private readonly onPersistError: (error: unknown) => void = () => undefined,
  ) {
    this.state = normalizeDashboardUiState(initialState);
  }

  public snapshot(): DashboardUiState {
    return normalizeDashboardUiState(this.state);
  }

  public update(patch: DashboardUiStatePatch): DashboardUiState {
    this.state = patchDashboardUiState(this.state, patch);
    this.schedulePersist();
    return this.snapshot();
  }

  public recordFile(path: string, openedAt?: string): DashboardUiState {
    const next = recordRecentDashboardFile(this.state, path, openedAt);
    if (statesEqual(next, this.state)) return this.snapshot();
    this.state = next;
    this.schedulePersist();
    return this.snapshot();
  }

  public async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) {
      await this.persistQueue;
      return;
    }
    this.dirty = false;
    const snapshot = this.snapshot();
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(() => this.persist(snapshot));
    await this.persistQueue;
  }

  public dispose(): Promise<void> {
    return this.flush();
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(this.onPersistError);
    }, this.debounceMs);
  }
}

function normalizePageState(value: unknown): DashboardPageUiState {
  const record = objectValue(value);
  const filters = objectValue(record?.filters);
  const normalizedFilters: Record<string, DashboardFilterValue> = {};
  for (const [key, item] of Object.entries(filters ?? {})) {
    if (isFilterValue(item)) normalizedFilters[key] = item;
  }
  const tab = textValue(record?.tab);
  return {
    scrollTop: scrollValue(record?.scrollTop),
    filters: normalizedFilters,
    ...(tab ? { tab } : {}),
  };
}

function patchPageState(
  current: DashboardPageUiState,
  patch: DashboardPageUiStatePatch,
): DashboardPageUiState {
  const filters = { ...current.filters };
  for (const [key, value] of Object.entries(patch.filters ?? {})) {
    if (value === null || value === undefined) delete filters[key];
    else if (isFilterValue(value)) filters[key] = value;
  }
  const tab = patch.tab === undefined ? current.tab : textValue(patch.tab);
  return {
    scrollTop: patch.scrollTop === undefined ? current.scrollTop : scrollValue(patch.scrollTop),
    filters,
    ...(tab ? { tab } : {}),
  };
}

function normalizeFeedState(value: unknown, legacy: unknown): DashboardFeedUiState {
  const record = objectValue(value);
  const fallback = objectValue(legacy);
  const editionId = textValue(record?.editionId) ?? textValue(fallback?.editionId);
  const itemId = textValue(record?.itemId) ?? textValue(fallback?.itemId);
  const updatedAt = timestampValue(record?.updatedAt) ?? timestampValue(fallback?.updatedAt);
  return {
    scrollTop: record?.scrollTop === undefined
      ? scrollValue(fallback?.scrollTop)
      : scrollValue(record.scrollTop),
    ...(editionId ? { editionId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function patchFeedState(
  current: DashboardFeedUiState,
  patch: DashboardFeedUiStatePatch | undefined,
): DashboardFeedUiState {
  if (!patch) return { ...current };
  const editionId = patch.editionId === undefined ? current.editionId : textValue(patch.editionId);
  const itemId = patch.itemId === undefined ? current.itemId : textValue(patch.itemId);
  const updatedAt = patch.updatedAt === undefined
    ? current.updatedAt
    : timestampValue(patch.updatedAt);
  return {
    scrollTop: patch.scrollTop === undefined ? current.scrollTop : scrollValue(patch.scrollTop),
    ...(editionId ? { editionId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function normalizeReadingSources(
  value: unknown,
): Record<string, DashboardReadingSourceUiState> {
  const record = objectValue(value);
  const normalized: Array<{
    sourceId: string;
    state: DashboardReadingSourceUiState;
    order: number;
  }> = [];
  let order = 0;
  for (const [rawSourceId, item] of Object.entries(record ?? {})) {
    const sourceId = textValue(rawSourceId);
    const source = objectValue(item);
    const digestId = textValue(source?.digestId);
    const updatedAt = timestampValue(source?.updatedAt);
    if (!sourceId || sourceId.length > 512 || !digestId || digestId.length > 512) continue;
    normalized.push({
      sourceId,
      state: {
        digestId,
        scrollTop: scrollValue(source?.scrollTop),
        ...(updatedAt ? { updatedAt } : {}),
      },
      order: order++,
    });
  }
  normalized.sort((left, right) => {
    const leftUpdated = left.state.updatedAt ? Date.parse(left.state.updatedAt) : 0;
    const rightUpdated = right.state.updatedAt ? Date.parse(right.state.updatedAt) : 0;
    return rightUpdated - leftUpdated || left.order - right.order;
  });
  return Object.fromEntries(
    normalized
      .slice(0, READING_SOURCE_SCROLL_LIMIT)
      .map(({ sourceId, state }) => [sourceId, state]),
  );
}

function normalizeRecentFiles(value: unknown): RecentDashboardFile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: RecentDashboardFile[] = [];
  for (const item of value) {
    const record = objectValue(item);
    const path = normalizeVaultPath(textValue(record?.path) ?? "");
    const openedAt = timestampValue(record?.openedAt);
    const key = path.toLocaleLowerCase();
    if (!isContinuationMarkdownPath(path) || !openedAt || seen.has(key)) continue;
    seen.add(key);
    normalized.push({ path, openedAt });
    if (normalized.length === RECENT_FILE_LIMIT) break;
  }
  return normalized;
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
}

function isDashboardSection(value: unknown): value is DashboardSection {
  return typeof value === "string" && (DASHBOARD_SECTIONS as readonly string[]).includes(value);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampValue(value: unknown): string | undefined {
  const text = textValue(value);
  return text && validTimestamp(text) ? text : undefined;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function scrollValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isFilterValue(value: unknown): value is DashboardFilterValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function statesEqual(left: DashboardUiState, right: DashboardUiState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

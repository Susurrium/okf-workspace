export interface RecordPage<T> {
  items: T[];
  version: number;
  index_id: string;
  next_offset: number | null;
  requires_reset: boolean;
}

export class RecordDeltaCache<T extends { updated_at?: string }> {
  private records = new Map<string, T>();
  private version: number | undefined;
  private indexId: string | undefined;
  private pending: Promise<T[]> | undefined;

  public constructor(private readonly identity: (record: T) => string) {}

  public load(fetch: (query: URLSearchParams) => Promise<RecordPage<T>>): Promise<T[]> {
    if (this.pending) return this.pending;
    const pending = this.synchronize(fetch).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private async synchronize(fetch: (query: URLSearchParams) => Promise<RecordPage<T>>): Promise<T[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const staged = new Map(this.records);
        let snapshot: number | undefined;
        let snapshotIndex: string | undefined;
        let offset: number | null = 0;
        do {
          const query = new URLSearchParams({ limit: '200', offset: String(offset) });
          if (this.version !== undefined) query.set('after_version', String(this.version));
          if (this.indexId !== undefined) query.set('after_index_id', this.indexId);
          if (snapshot !== undefined) query.set('snapshot_version', String(snapshot));
          if (snapshotIndex !== undefined) query.set('snapshot_index_id', snapshotIndex);
          const page = await fetch(query);
          if (offset === 0 && page.requires_reset) staged.clear();
          for (const record of page.items) staged.set(this.identity(record), record);
          snapshot = page.version;
          snapshotIndex = page.index_id;
          offset = page.next_offset;
        } while (offset !== null);
        this.records = staged;
        this.version = snapshot;
        this.indexId = snapshotIndex;
        return [...staged.values()].sort((left, right) =>
          String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? '')));
      } catch (error) {
        const cause = error instanceof Error ? error.cause as { status?: number; detail?: string } | undefined : undefined;
        const changed = error instanceof Error && (error.message.includes('state record snapshot changed')
          || cause?.status === 409 && cause.detail?.includes('state record snapshot changed'));
        if (attempt === 2 || !changed) throw error;
      }
    }
    throw new Error('状态记录快照持续变化，请重试');
  }
}

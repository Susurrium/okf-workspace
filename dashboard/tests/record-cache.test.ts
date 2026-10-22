import { describe, expect, it } from 'vitest';
import { RecordDeltaCache, type RecordPage } from '../src/api/record-cache.js';

interface Record { id: string; status: string; updated_at: string }
const record = (id: string, status = 'queued'): Record => ({ id, status, updated_at: '2026-10-22' });
const page = (items: Record[], version: number, next_offset: number | null = null, requires_reset = false): RecordPage<Record> =>
  ({ items, version, next_offset, requires_reset, index_id: 'fixture-index' });

describe('RecordDeltaCache', () => {
  it('loads every page and merges terminal transitions without losing history', async () => {
    const cache = new RecordDeltaCache<Record>(item => item.id);
    const queries: URLSearchParams[] = [];
    await cache.load(async query => {
      queries.push(query);
      return query.get('offset') === '0' ? page([record('a')], 2, 1) : page([record('b')], 2);
    });
    expect(queries[1]!.get('snapshot_version')).toBe('2');
    const updated = await cache.load(async query => {
      expect(query.get('after_version')).toBe('2');
      return page([record('a', 'completed')], 3);
    });
    expect(updated).toHaveLength(2);
    expect(updated.find(item => item.id === 'a')?.status).toBe('completed');
  });

  it('discards partial pages after a snapshot conflict and restarts boundedly', async () => {
    const cache = new RecordDeltaCache<Record>(item => item.id);
    let requests = 0;
    const result = await cache.load(async () => {
      requests++;
      if (requests === 1) return page([record('stale')], 1, 1);
      if (requests === 2) throw new Error('state record snapshot changed');
      return page([record('current')], 2);
    });
    expect(result.map(item => item.id)).toEqual(['current']);
    expect(requests).toBe(3);
  });

  it('resets deleted records after a restored index and shares active fetches', async () => {
    const cache = new RecordDeltaCache<Record>(item => item.id);
    await cache.load(async () => page([record('deleted')], 8));
    let release!: (value: RecordPage<Record>) => void;
    const first = cache.load(() => new Promise(resolve => { release = resolve; }));
    const second = cache.load(async () => { throw new Error('duplicate fetch'); });
    expect(second).toBe(first);
    release(page([record('restored')], 1, null, true));
    expect((await first).map(item => item.id)).toEqual(['restored']);
  });
});

import { TFile, type App } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { VaultDashboardReader } from '../src/plugin/vault-dashboard.js';

function fixture() {
  const file = new (TFile as unknown as new (path: string) => TFile)('knowledge/wiki/a.md');
  const files = [file];
  let content = '---\ntype: Wiki\ntitle: First\n---\n\nContent';
  let reads = 0;
  let pending: Promise<void> = Promise.resolve();
  const app = { vault: {
    getMarkdownFiles: () => files,
    getFiles: () => files,
    getAbstractFileByPath: (path: string) => files.find(item => item.path === path) ?? null,
    cachedRead: async () => { reads++; const value = content; await pending; return value; },
  } } as unknown as App;
  return { app, files, reads: () => reads, content: (value: string) => { content = value; },
    block: () => { let release!: () => void; pending = new Promise(resolve => { release = resolve; }); return release; } };
}

describe('VaultDashboardReader resources', () => {
  it('shares concurrent scans across readers of the same Vault', async () => {
    const data = fixture();
    const release = data.block();
    const first = new VaultDashboardReader(data.app);
    const second = new VaultDashboardReader(data.app);
    const requests = [first.knowledge(), second.inbox()];
    expect(data.reads()).toBe(1);
    release();
    await Promise.all(requests);
    expect(data.reads()).toBe(1);
  });

  it('releases deleted bodies and never republishes a late deleted read', async () => {
    const data = fixture();
    const reader = new VaultDashboardReader(data.app);
    await reader.knowledge();
    data.files.length = 0;
    await reader.knowledge();
    expect(VaultDashboardReader.cacheUsage(data.app).reads).toBe(0);
    const other = fixture();
    const otherReader = new VaultDashboardReader(other.app);
    const release = other.block();
    const request = otherReader.knowledge();
    other.files.length = 0;
    VaultDashboardReader.invalidate(other.app, ['knowledge/wiki/a.md']);
    release();
    expect((await request).notes).toEqual([]);
    expect(VaultDashboardReader.cacheUsage(other.app).reads).toBe(0);
  });

  it('invalidates equal-size explicit modifications and obeys its byte budget', async () => {
    const data = fixture();
    const reader = new VaultDashboardReader(data.app, { cacheLimitBytes: 16 });
    expect((await reader.knowledge()).notes[0]?.title).toBe('First');
    expect(VaultDashboardReader.cacheUsage(data.app).bytes).toBeLessThanOrEqual(16);
    data.content('---\ntype: Wiki\ntitle: Other\n---\n\nContent');
    VaultDashboardReader.invalidate(data.app, ['knowledge/wiki/a.md']);
    expect((await reader.knowledge()).notes[0]?.title).toBe('Other');
  });

  it('retains resources for another reader and releases the last reader', async () => {
    const data = fixture();
    const first = new VaultDashboardReader(data.app);
    const second = new VaultDashboardReader(data.app);
    await first.knowledge();
    first.dispose();
    expect(VaultDashboardReader.cacheUsage(data.app).reads).toBe(1);
    second.dispose();
    expect(VaultDashboardReader.cacheUsage(data.app).reads).toBe(0);
    expect(VaultDashboardReader.cacheUsage(data.app).scans).toBe(0);
  });

  it('keeps a new snapshot when an older invalidated read returns late', async () => {
    const data = fixture();
    const reader = new VaultDashboardReader(data.app);
    const releaseOld = data.block();
    const old = reader.knowledge();
    data.content('---\ntype: Wiki\ntitle: Other\n---\n\nContent');
    VaultDashboardReader.invalidate(data.app, ['knowledge/wiki/a.md']);
    const releaseNew = data.block();
    const current = reader.knowledge();
    releaseNew();
    expect((await current).notes[0]?.title).toBe('Other');
    releaseOld();
    await old;
    expect((await reader.knowledge()).notes[0]?.title).toBe('Other');
    expect(data.reads()).toBe(2);
  });
});

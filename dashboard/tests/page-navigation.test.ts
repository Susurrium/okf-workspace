import type { WorkspaceLeaf } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { matchingDashboardPage, relatedDashboardPage } from '../src/plugin/page-navigation.js';

function page(workbenchPath: string, section: string, config: Record<string, unknown> = {}): WorkspaceLeaf {
  return { getViewState: () => ({ type: 'okf-dashboard', state: { workbenchPath, section, config,
    stateKey: 'restored-instance', pageUiState: { scrollTop: 180 }, navigationHistory: [{ section: 'sources' }] } }) } as unknown as WorkspaceLeaf;
}

describe('restored focused page selection', () => {
  it('finds the same task page from a command without relying on an in-memory association', () => {
    const existing = page('boards/日常', 'tasks', { taskView: 'all', query: '用户查询', sort: 'title' });
    expect(matchingDashboardPage([existing], 'boards/日常.md', 'tasks')).toBe(existing);
    expect(existing.getViewState().state).toMatchObject({ stateKey: 'restored-instance', pageUiState: { scrollTop: 180 } });
  });
  it('matches selection sets independently of order and keeps different business scopes separate', () => {
    const existing = page('boards/home', 'tasks', { course: 'courses/A.md', statuses: ['done', 'todo'] });
    expect(matchingDashboardPage([existing], 'boards/home', 'tasks', { course: 'courses/A', statuses: ['todo', 'done'] })).toBe(existing);
    expect(matchingDashboardPage([existing], 'boards/other', 'tasks', { course: 'courses/A' })).toBeUndefined();
    expect(relatedDashboardPage([existing], 'boards/home', { course: 'courses/B' })).toBeUndefined();
    expect(relatedDashboardPage([existing], 'boards/home', { course: 'courses/A' })).toBe(existing);
  });
});

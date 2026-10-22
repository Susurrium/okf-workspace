import type { WorkspaceLeaf } from 'obsidian';

const SCOPE_KEYS = ['course', 'project', 'statuses', 'feedStreams', 'folders', 'excludeFolders',
  'notePaths', 'readingView', 'readingSourceId', 'catalogueKey', 'taskView', 'savedViewId'] as const;

function boardPath(path: unknown): string {
  return typeof path === 'string' ? path.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '').replace(/\.md$/iu, '') : '';
}

export function pageNavigationIdentity(workbenchPath: unknown, section: unknown, config: Record<string, unknown> = {}): string {
  const scope = SCOPE_KEYS.map(key => {
    let value = config[key];
    if (key === 'taskView' && section === 'tasks') value ??= 'all';
    if (key === 'readingView' && section === 'reading') value ??= 'subscriptions';
    if (key === 'course' || key === 'project') value = boardPath(value);
    return Array.isArray(value) ? [...value].sort() : value;
  });
  return JSON.stringify([boardPath(workbenchPath), section, scope]);
}

export function matchingDashboardPage(pages: WorkspaceLeaf[], workbenchPath: string | undefined,
  section: string, config?: Record<string, unknown>): WorkspaceLeaf | undefined {
  const expected = pageNavigationIdentity(workbenchPath, section, config);
  return pages.find(page => {
    const state = page.getViewState().state;
    return state && pageNavigationIdentity(state.workbenchPath, state.section, state.config as Record<string, unknown> | undefined) === expected;
  });
}

export function relatedDashboardPage(pages: WorkspaceLeaf[], workbenchPath: string,
  config: Record<string, unknown> = {}): WorkspaceLeaf | undefined {
  return pages.find(page => {
    const state = page.getViewState().state;
    const stored = state?.config as Record<string, unknown> | undefined;
    return boardPath(state?.workbenchPath) === boardPath(workbenchPath)
      && boardPath(stored?.course) === boardPath(config.course)
      && boardPath(stored?.project) === boardPath(config.project);
  });
}

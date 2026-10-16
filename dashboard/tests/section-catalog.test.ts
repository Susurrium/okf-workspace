import { describe, expect, it } from 'vitest';
import { SECTION_TYPE_OPTIONS, groupedSectionOptions, sectionOptionLabel } from '../apex/src/section-catalog.js';
import { createOkfSurfaceSectionDefinitions } from '../src/features/workbench/okf-surface-sections.js';

const definitions = createOkfSurfaceSectionDefinitions({ mountOkfDashboardSurface: async () => () => {} });
const options = [...SECTION_TYPE_OPTIONS, ...definitions.filter(item => !item.hidden).map(item => ({ value: item.type, ...item }))];

describe('section selection', () => {
  it('preserves every visible type once in the specified categories and retains sticky notes', () => {
    const groups = groupedSectionOptions(options);
    expect(groups.map(group => group.id)).toEqual(['daily', 'reading', 'learning', 'content', 'tools']);
    const types = groups.flatMap(group => group.options.map(option => option.value));
    expect(types).toHaveLength(24);
    expect(new Set(types).size).toBe(24);
    expect(types.slice(0, 5)).toEqual(['workspace-today', 'workspace-tasks', 'calendar', 'workspace-life', 'ticktick']);
    expect(sectionOptionLabel(options.find(option => option.value === 'sticky')!)).toBe('便利贴');
    expect(types).not.toContain('alltasks');
  });

  it('finds renamed types by their old names and respects the active category', () => {
    expect(groupedSectionOptions(options, '数据库').flatMap(group => group.options.map(option => option.value))).toEqual(['library']);
    expect(groupedSectionOptions(options, '待办').flatMap(group => group.options.map(option => option.value))).toEqual(['workspace-tasks']);
    expect(groupedSectionOptions(options, '数据库', 'daily')).toEqual([]);
    expect(groupedSectionOptions(options, '不匹配的名称')).toEqual([]);
  });
});

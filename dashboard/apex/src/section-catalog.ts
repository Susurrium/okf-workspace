import { t } from './i18n';

export const SECTION_GROUPS = [
	{ id: 'daily', key: 'section.groupDaily', types: ['workspace-today', 'workspace-tasks', 'calendar', 'workspace-life', 'ticktick'] },
	{ id: 'reading', key: 'section.groupReading', types: ['workspace-inbox', 'workspace-reading', 'workspace-updates', 'workspace-sources', 'weread'] },
	{ id: 'learning', key: 'section.groupLearning', types: ['workspace-learning', 'workspace-projects', 'workspace-knowledge'] },
	{ id: 'content', key: 'section.groupContent', types: ['projects', 'memo', 'todo', 'sticky', 'folder', 'images', 'videos', 'web'] },
	{ id: 'tools', key: 'section.groupTools', types: ['library', 'dataview', 'workspace-system'] },
] as const;

export interface SectionTypeOption {
	value: string;
	icon: string;
	labelKey?: string;
	label?: string;
	defaultName?: string;
	group?: string;
	aliases?: readonly string[];
}

export const SECTION_TYPE_OPTIONS: SectionTypeOption[] = [
	{ value: 'projects', icon: 'panels-top-left', labelKey: 'renderer.typeNotes', aliases: ['笔记', 'notes'] },
	{ value: 'todo', icon: 'list-todo', labelKey: 'renderer.typeTodo', aliases: ['清单', 'checklist'] },
	{ value: 'memo', icon: 'sticky-note', labelKey: 'renderer.typeMemo' },
	{ value: 'sticky', icon: 'layers', labelKey: 'renderer.typeSticky' },
	{ value: 'dataview', icon: 'code-xml', labelKey: 'renderer.typeDataview', aliases: ['数据视图', 'Dataview', '查询'] },
	{ value: 'library', icon: 'table-properties', labelKey: 'renderer.typeLibrary', aliases: ['数据库', 'database', 'library'] },
	{ value: 'folder', icon: 'folder-open', labelKey: 'renderer.typeFolder', aliases: ['文件夹'] },
	{ value: 'images', icon: 'images', labelKey: 'renderer.typeImages' },
	{ value: 'videos', icon: 'film', labelKey: 'renderer.typeVideos' },
	{ value: 'calendar', icon: 'calendar-days', labelKey: 'renderer.typeCalendar', aliases: ['日历'] },
	{ value: 'web', icon: 'globe', labelKey: 'renderer.typeWeb', aliases: ['网页'] },
	{ value: 'weread', icon: 'book-open', labelKey: 'renderer.typeWeread' },
	{ value: 'ticktick', icon: 'circle-check', labelKey: 'renderer.typeTickTick' },
];

export function sectionOptionLabel(option: SectionTypeOption): string {
	return option.label ?? (option.labelKey ? t(option.labelKey) : option.value);
}

export function sectionOptionGroup(option: SectionTypeOption): string {
	return SECTION_GROUPS.find(group => (group.types as readonly string[]).includes(option.value))?.id ?? option.group ?? 'content';
}

export function sectionGroupLabel(id: string): string {
	const group = SECTION_GROUPS.find(group => group.id === id);
	return group ? t(group.key) : id;
}

export function groupedSectionOptions(options: readonly SectionTypeOption[], query = '', groupId = ''): Array<{ id: string; options: SectionTypeOption[] }> {
	const term = query.trim().toLocaleLowerCase();
	const groups = [...SECTION_GROUPS.map(group => group.id as string), ...options.map(sectionOptionGroup)];
	return [...new Set(groups)].filter(id => !groupId || id === groupId).map(id => {
		const order = SECTION_GROUPS.find(group => group.id === id)?.types as readonly string[] | undefined;
		return { id, options: options.filter(option => sectionOptionGroup(option) === id
			&& (!term || [sectionOptionLabel(option), option.value, ...(option.aliases ?? []), option.value === 'workspace-tasks' ? '待办' : ''].join(' ').toLocaleLowerCase().includes(term)))
			.sort((a, b) => (order?.indexOf(a.value) ?? 0) - (order?.indexOf(b.value) ?? 0)) };
	}).filter(group => group.options.length);
}

import { sectionRef, type DashboardColumn, type DashboardData } from './types';

export interface BoardMergeResult {
	data: DashboardData;
	conflicts: string[];
}

const COLUMN_FIELDS: Array<keyof DashboardColumn> = [
	'name', 'color', 'sectionType', 'cards', 'libraryConfig', 'wereadConfig', 'ticktickConfig',
	'dataviewConfig', 'webConfig', 'height', 'half', 'width', 'leadingContent', 'rawContent',
];

function same(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function mergeValue<T>(
	label: string,
	base: T,
	local: T,
	remote: T,
	conflicts: string[],
): T {
	const localChanged = !same(local, base);
	const remoteChanged = !same(remote, base);
	if (!localChanged) return remote;
	if (!remoteChanged || same(local, remote)) return local;
	conflicts.push(label);
	return remote;
}

/** Three-way merge used immediately before a board write. Remote wins conflicts. */
export function mergeBoardData(
	base: DashboardData,
	local: DashboardData,
	remote: DashboardData,
): BoardMergeResult {
	const conflicts: string[] = [];
	const baseRefs = base.columns.map(sectionRef);
	const localRefs = local.columns.map(sectionRef);
	const remoteRefs = remote.columns.map(sectionRef);
	const localOrderChanged = !same(localRefs, baseRefs);
	const remoteOrderChanged = !same(remoteRefs, baseRefs);
	let orderedRefs = remoteRefs;
	if (localOrderChanged) {
		if (remoteOrderChanged && !same(localRefs, remoteRefs)) conflicts.push('columns.order');
		else orderedRefs = localRefs;
	}

	const baseByRef = new Map(base.columns.map((column) => [sectionRef(column), column]));
	const localByRef = new Map(local.columns.map((column) => [sectionRef(column), column]));
	const remoteByRef = new Map(remote.columns.map((column) => [sectionRef(column), column]));
	const refs = [...orderedRefs];
	for (const ref of localRefs) if (!refs.includes(ref) && !baseByRef.has(ref)) refs.push(ref);

	const columns: DashboardColumn[] = [];
	for (const ref of refs) {
		const localColumn = localByRef.get(ref);
		const remoteColumn = remoteByRef.get(ref);
		const baseColumn = baseByRef.get(ref);
		if (!localColumn) {
			if (baseColumn && remoteColumn && localOrderChanged && !remoteOrderChanged) continue;
			if (remoteColumn) columns.push(remoteColumn);
			continue;
		}
		if (!remoteColumn) {
			if (!baseColumn) columns.push(localColumn);
			else if (!same(localColumn, baseColumn)) conflicts.push(`section.${ref}.deleted-remotely`);
			continue;
		}
		if (!baseColumn) {
			columns.push(remoteColumn);
			continue;
		}
		const merged: DashboardColumn = { ...remoteColumn };
		for (const field of COLUMN_FIELDS) {
			(merged as unknown as Record<string, unknown>)[field] = mergeValue(
				`section.${ref}.${field}`,
				baseColumn[field],
				localColumn[field],
				remoteColumn[field],
				conflicts,
			);
		}
		columns.push(merged);
	}

	return {
		data: {
			...remote,
			workbenchSchema: mergeValue('workbenchSchema', base.workbenchSchema, local.workbenchSchema, remote.workbenchSchema, conflicts),
			banner: mergeValue('banner', base.banner, local.banner, remote.banner, conflicts),
			quickActions: mergeValue('quickActions', base.quickActions, local.quickActions, remote.quickActions, conflicts),
			quickActionOrder: mergeValue('quickActionOrder', base.quickActionOrder, local.quickActionOrder, remote.quickActionOrder, conflicts),
			hiddenPresets: mergeValue('hiddenPresets', base.hiddenPresets, local.hiddenPresets, remote.hiddenPresets, conflicts),
			bodyPreamble: mergeValue('bodyPreamble', base.bodyPreamble, local.bodyPreamble, remote.bodyPreamble, conflicts),
			columns,
			sourceFrontmatter: remote.sourceFrontmatter,
		},
		conflicts,
	};
}

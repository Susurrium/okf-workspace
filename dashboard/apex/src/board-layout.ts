import type { DashboardColumn, DashboardLayoutMode, ImmersiveItem } from './types';
import { sectionRef } from './types';
import { readWorkbenchLayout, type WorkbenchLayout } from './workbench-layout';
import { migrateLegacyHeight, pxToRows } from './immersive-grid';

export interface BoardLayoutState { layout?: DashboardLayoutMode; immersive?: ImmersiveItem[] }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export function readLayoutMode(value: unknown): DashboardLayoutMode | undefined {
	if (value === undefined) return undefined;
	if (value !== 'side' && value !== 'stacked' && value !== 'immersive') throw new Error('工作台 layout 必须为 side、stacked 或 immersive');
	return value;
}

export function readImmersiveItems(value: unknown): ImmersiveItem[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error('工作台 immersive 必须为卡片列表');
	const ids = new Set<string>();
	return value.map(raw => {
		if (!record(raw) || typeof raw.id !== 'string' || !raw.id || ids.has(raw.id)) throw new Error('沉浸式卡片 ID 缺失或重复');
		ids.add(raw.id);
		const height = raw.cap !== undefined ? raw.cap : typeof raw.h === 'number' ? migrateLegacyHeight(raw.h) : undefined;
		if (!Number.isInteger(raw.w) || Number(raw.w) < 1 || Number(raw.w) > 12 || !Number.isInteger(height) || Number(height) < 3 || Number(height) > 240) throw new Error(`沉浸式卡片尺寸无效：${raw.id}`);
		if ((raw.x === undefined) !== (raw.y === undefined)) throw new Error(`沉浸式卡片坐标必须同时存在：${raw.id}`);
		if (raw.x !== undefined && (!Number.isInteger(raw.x) || !Number.isInteger(raw.y) || Number(raw.x) < 0 || Number(raw.x) + Number(raw.w) > 12 || Number(raw.y) < 0)) throw new Error(`沉浸式卡片坐标无效：${raw.id}`);
		for (const key of ['fixed', 'hidden']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(`沉浸式卡片 ${key} 必须为布尔值`);
		const item: Record<string, unknown> = { ...raw, h: Number(height) }; delete item.cap;
		return item as unknown as ImmersiveItem;
	});
}

export function serializeImmersiveItems(items: ImmersiveItem[]): Record<string, unknown>[] {
	return items.map(({ h, ...item }) => ({ ...item, cap: h }));
}

export function convertTrialLayout(legacy: WorkbenchLayout): BoardLayoutState {
	return {
		layout: legacy.mode === 'inherit' ? undefined : legacy.mode,
		immersive: Object.entries(legacy.items ?? {}).map(([id, item]) => {
			const { visible, h, y, ...rest } = item;
			return { ...rest, id, w: item.w, h: pxToRows(h * 24 - 12), x: item.x, y: Math.round(y * 24 / 10), fixed: true, ...(visible === false ? { hidden: true } : {}) };
		}),
	};
}

export function readBoardLayout(metadata: Record<string, unknown>, columns: DashboardColumn[]): BoardLayoutState {
	let state: BoardLayoutState;
	if (metadata.layout !== undefined || metadata.immersive !== undefined) state = { layout: readLayoutMode(metadata.layout), immersive: readImmersiveItems(metadata.immersive) };
	else { const legacy = readWorkbenchLayout(metadata.workbench_layout); state = legacy ? convertTrialLayout(legacy) : {}; }
	// 本地分区身份按 ID 绑定；仅在旧名称唯一时进行精确映射。
	if (state.immersive) state.immersive = state.immersive.map(item => {
		if (!item.id.startsWith('section:')) return item;
		const key = item.id.slice('section:'.length);
		if (columns.some(column => sectionRef(column) === key)) return item;
		const matches = columns.filter(column => column.name === key);
		if (matches.length > 1) throw new Error(`沉浸式布局中的同名分区无法唯一定位：${key}`);
		return matches.length === 1 ? { ...item, id: `section:${sectionRef(matches[0]!)}` } : item;
	});
	return state;
}

/** 按卡片检查旧值；列表顺序发生竞争时拒绝覆盖。 */
export function patchBoardLayout(current: BoardLayoutState, previous: BoardLayoutState, next: BoardLayoutState): BoardLayoutState {
	const result = structuredClone(current);
	if (!equal(previous.layout, next.layout)) {
		if (!equal(current.layout, previous.layout) && !equal(current.layout, next.layout)) throw new Error('工作台布局存在保存冲突，请重新读取');
		result.layout = next.layout;
	}
	if (!equal(previous.immersive, next.immersive)) {
		const oldItems = new Map(previous.immersive?.map(item => [item.id, item]));
		const newItems = new Map(next.immersive?.map(item => [item.id, item]));
		const items = new Map(current.immersive?.map(item => [item.id, item]));
		for (const id of new Set([...oldItems.keys(), ...newItems.keys()])) {
			if (equal(oldItems.get(id), newItems.get(id))) continue;
			if (!equal(items.get(id), oldItems.get(id)) && !equal(items.get(id), newItems.get(id))) throw new Error(`沉浸式卡片 ${id} 存在保存冲突，请重新读取`);
			if (newItems.has(id)) items.set(id, newItems.get(id)!); else items.delete(id);
		}
		const order = (entries: ImmersiveItem[] | undefined) => entries?.map(item => item.id) ?? [];
		const reordered = !equal(order(previous.immersive), order(next.immersive));
		if (reordered && !equal(order(current.immersive), order(previous.immersive)) && !equal(order(current.immersive), order(next.immersive))) throw new Error('沉浸式卡片顺序存在保存冲突，请重新读取');
		const keys = reordered ? [...order(next.immersive), ...items.keys()] : [...items.keys()];
		result.immersive = [...new Set(keys)].filter(id => items.has(id)).map(id => items.get(id)!);
	}
	return result;
}

export function writeBoardLayout(metadata: Record<string, unknown>, state: BoardLayoutState): void {
	if (state.layout === undefined) delete metadata.layout; else metadata.layout = readLayoutMode(state.layout);
	if (state.immersive === undefined) delete metadata.immersive;
	else { const encoded = serializeImmersiveItems(state.immersive); readImmersiveItems(encoded); metadata.immersive = encoded; }
	// 完整保留试用配置及未知扩展作兼容存档；已有原生字段时不再参与有效布局。
}

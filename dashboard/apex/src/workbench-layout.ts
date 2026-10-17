import type { DashboardLayoutMode } from './types';


export interface WorkbenchTile {
	x: number;
	y: number;
	w: number;
	h: number;
	visible?: boolean;
	[key: string]: unknown;
}

export interface WorkbenchLayout {
	version: 1;
	mode: DashboardLayoutMode | 'immersive' | 'inherit';
	clock?: boolean;
	background?: boolean;
	items?: Record<string, WorkbenchTile>;
	[key: string]: unknown;
}


function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 这里只校验布局字段；YAML 的读取和写入仍由现有库负责。 */
export function readWorkbenchLayout(value: unknown): WorkbenchLayout | undefined {
	if (value === undefined) return undefined;
	if (!record(value) || value.version !== 1 || !['inherit', 'side', 'stacked', 'immersive'].includes(String(value.mode))) {
		throw new Error('工作台布局配置无效或版本不受支持，请保留原文件并检查 workbench_layout');
	}
	for (const key of ['clock', 'background']) {
		if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`工作台布局 ${key} 必须为布尔值`);
	}
	if (value.items !== undefined) {
		if (!record(value.items)) throw new Error('工作台布局 items 必须为对象');
		for (const [id, tile] of Object.entries(value.items)) {
			if (!id || !record(tile) || !['x', 'y', 'w', 'h'].every(key => Number.isSafeInteger(tile[key]))) throw new Error(`工作台布局卡片无效：${id}`);
			const { x, y, w, h } = tile as unknown as WorkbenchTile;
			if (x < 0 || y < 0 || w < 1 || w > 12 || x + w > 12 || h < 3 || h > 100 || y > 10000) throw new Error(`工作台布局卡片尺寸或位置超出范围：${id}`);
			if (tile.visible !== undefined && typeof tile.visible !== 'boolean') throw new Error(`工作台布局卡片 visible 必须为布尔值：${id}`);
		}
	}
	return structuredClone(value) as WorkbenchLayout;
}

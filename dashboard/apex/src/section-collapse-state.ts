import { normalizeWorkspacePath } from './workspace-registry';

function sectionKeys(value: unknown): Set<string> {
	return new Set(Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: []);
}

/** Collapse state belongs to one pane and one workbench file. */
export class PaneSectionCollapseState {
	private readonly byWorkspace = new Map<string, Set<string>>();

	forWorkspace(path: string): Set<string> {
		const normalized = normalizeWorkspacePath(path);
		let collapsed = this.byWorkspace.get(normalized);
		if (!collapsed) {
			collapsed = new Set<string>();
			this.byWorkspace.set(normalized, collapsed);
		}
		return collapsed;
	}

	replace(path: string, collapsed: Iterable<string>): void {
		this.byWorkspace.set(normalizeWorkspacePath(path), new Set(collapsed));
	}

	restore(saved: unknown, activePath: string, legacyActive: unknown): void {
		this.byWorkspace.clear();
		if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
			for (const [path, value] of Object.entries(saved)) {
				const normalized = normalizeWorkspacePath(path);
				if (normalized && Array.isArray(value)) this.byWorkspace.set(normalized, sectionKeys(value));
			}
		}
		const normalizedActive = normalizeWorkspacePath(activePath);
		if (normalizedActive && !this.byWorkspace.has(normalizedActive) && Array.isArray(legacyActive)) {
			this.byWorkspace.set(normalizedActive, sectionKeys(legacyActive));
		}
	}

	snapshot(): Record<string, string[]> {
		return Object.fromEntries([...this.byWorkspace].map(([path, collapsed]) => [path, [...collapsed]]));
	}

	rename(oldPath: string, newPath: string): void {
		const oldKey = normalizeWorkspacePath(oldPath);
		const newKey = normalizeWorkspacePath(newPath);
		if (!oldKey || !newKey || oldKey === newKey) return;
		const collapsed = this.byWorkspace.get(oldKey);
		if (!collapsed) return;
		this.byWorkspace.set(newKey, collapsed);
		this.byWorkspace.delete(oldKey);
	}

	remove(path: string): void {
		this.byWorkspace.delete(normalizeWorkspacePath(path));
	}
}

/** Bind a row once, but read shared state only when its button is clicked. */
export function createSectionCollapseToggle(
	readCurrent: () => Iterable<string>,
	writeNext: (collapsed: Set<string>) => void,
	reference: string,
	name: string,
): (shouldCollapse: boolean) => void {
	return (shouldCollapse) => {
		const next = new Set(readCurrent());
		if (shouldCollapse) next.add(reference);
		else {
			next.delete(reference);
			next.delete(name);
		}
		writeNext(next);
	};
}

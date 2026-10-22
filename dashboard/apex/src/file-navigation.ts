import { TFile, type App, type PaneType, type WorkspaceLeaf } from 'obsidian';

export interface FileLocation {
	subpath?: string;
	line?: number;
}

export interface FileNavigationOptions extends FileLocation {
	origin?: WorkspaceLeaf;
	newLeaf?: PaneType | boolean;
	isValid?: () => boolean;
}

export interface FileNavigationRequest {
	isCurrent(): boolean;
	open(file: TFile, location?: FileLocation): Promise<boolean>;
}

interface NavigationState {
	intent: number;
	queues: Map<string, Promise<boolean>>;
}

const states = new WeakMap<App, NavigationState>();

function rootLeaves(app: App): WorkspaceLeaf[] {
	const leaves: WorkspaceLeaf[] = [];
	app.workspace.iterateAllLeaves(leaf => {
		const root = leaf.getRoot();
		if (root !== app.workspace.leftSplit && root !== app.workspace.rightSplit) leaves.push(leaf);
	});
	return leaves;
}

/** 在异步准备开始前记录来源和顺序，迟到请求不能覆盖新的导航。 */
export function beginFileNavigation(app: App, options: FileNavigationOptions = {}): FileNavigationRequest {
	let state = states.get(app);
	if (!state) {
		state = { intent: 0, queues: new Map() };
		states.set(app, state);
	}
	const shared = state;
	const intent = ++shared.intent;
	const activeAtStart = app.workspace.getMostRecentLeaf();
	const origin = options.origin ?? activeAtStart;
	const explicit = options.newLeaf !== undefined && options.newLeaf !== false;
	const valid = (): boolean => (explicit || shared.intent === intent) && options.isValid?.() !== false
		&& (!origin || rootLeaves(app).includes(origin));
	return {
		isCurrent: () => shared.intent === intent && valid() && app.workspace.getMostRecentLeaf() === activeAtStart,
		async open(file, location = {}) {
			const path = file.path;
			const previous = shared.queues.get(path) ?? Promise.resolve();
			const operation = previous.catch(() => undefined).then(async () => {
				if (!valid() || (!explicit && app.workspace.getMostRecentLeaf() !== activeAtStart)) return false;
				const indexed = app.vault.getAbstractFileByPath(file.path);
				if (!(indexed instanceof TFile)) throw new Error(`文件已不存在：${file.path}`);
				const candidates = explicit ? [] : rootLeaves(app).filter(leaf => leaf.getViewState().state?.file === file.path);
				const active = app.workspace.getMostRecentLeaf();
				const recent = (items: WorkspaceLeaf[]): WorkspaceLeaf | undefined => items.sort((a, b) =>
					((b as WorkspaceLeaf & { activeTime?: number }).activeTime ?? 0) -
					((a as WorkspaceLeaf & { activeTime?: number }).activeTime ?? 0))[0];
				let leaf = candidates.find(candidate => candidate === active)
					?? recent(candidates.filter(candidate => candidate.parent === origin?.parent))
					?? recent(candidates);
				const target = { ...options, ...location };
				const eState = { ...(target.subpath ? { subpath: target.subpath } : {}),
					...(target.line !== undefined ? { line: target.line } : {}) };
				let activate = !explicit;
				if (!leaf) {
					const before = rootLeaves(app);
					const foreground = app.workspace.getMostRecentLeaf();
					if (explicit && origin && origin !== foreground) app.workspace.setActiveLeaf(origin, { focus: false });
					leaf = explicit ? app.workspace.getLeaf(options.newLeaf)
						: origin ? app.workspace.createLeafInParent(origin.parent, -1) : app.workspace.getLeaf('tab');
					const created = !before.includes(leaf);
					if (explicit) activate = options.newLeaf === 'split' || options.newLeaf === 'window'
						|| app.workspace.getMostRecentLeaf() === leaf;
					if (foreground && app.workspace.getMostRecentLeaf() !== foreground)
						app.workspace.setActiveLeaf(foreground, { focus: false });
					try {
						await leaf.openFile(indexed, { active: false, eState });
					} catch (error) {
						if (created) leaf.detach();
						throw error;
					}
				} else {
					await leaf.loadIfDeferred();
				}
				if (!valid() || !rootLeaves(app).includes(leaf)) return false;
				if (explicit && (!activate || shared.intent !== intent)) return true;
				const current = app.workspace.getMostRecentLeaf();
				if (current !== activeAtStart && current !== leaf) return false;
				await app.workspace.revealLeaf(leaf);
				if (!valid()) return false;
				app.workspace.setActiveLeaf(leaf, { focus: true });
				leaf.setEphemeralState({ ...eState, focus: true });
				return true;
			});
			shared.queues.set(path, operation);
			try { return await operation; }
			finally { if (shared.queues.get(path) === operation) shared.queues.delete(path); }
		},
	};
}

export async function openFileInWorkspace(app: App, file: TFile, options: FileNavigationOptions = {}): Promise<void> {
	await beginFileNavigation(app, options).open(file);
}

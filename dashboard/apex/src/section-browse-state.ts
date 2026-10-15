export interface SectionSearchState { key: string; value: string }

function fields(root: HTMLElement): HTMLInputElement[] {
	return Array.from(root.querySelectorAll<HTMLInputElement>('input')).filter(input => input.type === 'search' || /search/.test(input.className));
}
function key(input: HTMLInputElement): string {
	return `${input.getAttribute('aria-label') ?? ''}|${input.getAttribute('placeholder') ?? ''}|${input.className}`;
}

export function captureSectionSearch(root: HTMLElement): SectionSearchState[] {
	return fields(root).map(input => ({ key: key(input), value: input.value }));
}

/** 查询结果可异步创建搜索框；恢复只触发原有搜索交互。 */
export function restoreSectionSearch(root: HTMLElement, state: readonly SectionSearchState[]): () => void {
	const pending = new Map(state.filter(item => item.value).map(item => [item.key, item.value]));
	if (!pending.size) return () => {};
	const apply = (): void => {
		for (const input of fields(root)) {
			const value = pending.get(key(input));
			if (value === undefined) continue;
			pending.delete(key(input));
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
	};
	apply();
	if (!pending.size) return () => {};
	const observer = new MutationObserver(() => { apply(); if (!pending.size) observer.disconnect(); });
	observer.observe(root, { childList: true, subtree: true });
	const timer = window.setTimeout(() => observer.disconnect(), 5000);
	return () => { observer.disconnect(); window.clearTimeout(timer); };
}

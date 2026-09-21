import type { App } from 'obsidian';

import type { DashboardColumn, RenderCallbacks } from './types';

export interface CustomSectionRenderContext {
	container: HTMLElement;
	column: DashboardColumn;
	app: App;
	callbacks: RenderCallbacks;
	setConfig(config: Record<string, unknown>): void;
}

export interface CustomSectionDefinition {
	type: string;
	icon: string;
	label: string;
	defaultName: string;
	render(context: CustomSectionRenderContext): void | Promise<void>;
}

const DEFINITIONS = new Map<string, CustomSectionDefinition>();

export function registerSectionDefinition(definition: CustomSectionDefinition): () => void {
	DEFINITIONS.set(definition.type, definition);
	return () => {
		if (DEFINITIONS.get(definition.type) === definition) DEFINITIONS.delete(definition.type);
	};
}

export function getSectionDefinition(type: string): CustomSectionDefinition | undefined {
	return DEFINITIONS.get(type);
}

export function registeredSectionDefinitions(): CustomSectionDefinition[] {
	return [...DEFINITIONS.values()];
}

export function isRegisteredSection(type: string): boolean {
	return DEFINITIONS.has(type);
}

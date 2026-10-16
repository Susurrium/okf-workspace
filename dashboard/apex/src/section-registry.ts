import type { App } from 'obsidian';

import type { DashboardColumn, RenderCallbacks } from './types';
import type { SectionActions } from './section-actions';

export interface CustomSectionRenderContext {
	container: HTMLElement;
	headerActions?: HTMLElement;
	sectionActions?: SectionActions;
	column: DashboardColumn;
	app: App;
	callbacks: RenderCallbacks;
	setConfig(config: Record<string, unknown>): void | Promise<void>;
}

export interface CustomSectionDefinition {
	type: string;
	icon: string;
	label: string;
	defaultName: string;
	group?: string;
	description?: string;
	hidden?: boolean;
	configure?(context: CustomSectionRenderContext): void;
	render(context: CustomSectionRenderContext): void | (() => void) | Promise<void | (() => void)>;
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

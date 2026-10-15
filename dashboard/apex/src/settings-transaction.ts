import type { DashboardSettings } from './types';

export interface SettingsWriter {
	settings: DashboardSettings;
	saveSettings(): Promise<void>;
}

/** 保存失败时只恢复本次仍未被后续编辑替换的字段。 */
export async function saveSettingsPatch(host: SettingsWriter, patch: Partial<DashboardSettings>): Promise<void> {
	const previous = host.settings;
	host.settings = { ...host.settings, ...patch };
	try {
		await host.saveSettings();
	} catch (error) {
		const current = host.settings as unknown as Record<string, unknown>;
		const before = previous as unknown as Record<string, unknown>;
		const restored = { ...current };
		for (const [key, value] of Object.entries(patch)) {
			if (current[key] !== value) continue;
			if (Object.hasOwn(before, key)) restored[key] = before[key];
			else delete restored[key];
		}
		host.settings = restored as unknown as DashboardSettings;
		throw error;
	}
}

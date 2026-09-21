import { Setting, type SettingDefinitionItem } from "obsidian";

import type { DashboardSettings as ApexDashboardSettings } from "../../apex/src/types.js";
import { normalizeApexSettings } from "./apex-settings.js";
import {
  createDefaultDashboardUiState,
  type DashboardUiState,
} from "./dashboard-ui-state.js";
import type OkfBrainPlugin from "./main.js";

export interface FeedReadingPosition {
  editionId: string;
  itemId: string;
  updatedAt: string;
}

export interface OkfBrainSettings {
  baseUrl: string;
  tokenFile: string;
  token: string;
  manageLocalService: boolean;
  pythonExecutable: string;
  deploymentConfig: string;
  serviceLogDirectory: string;
  documentParserPolicy: "prefer-mineru" | "mineru-required" | "markitdown-only";
  dashboardUiState: DashboardUiState;
  /** Compatibility mirror for settings written before Dashboard UI state v1. */
  feedReadingPositions: Partial<Record<"ai-daily" | "treehole", FeedReadingPosition>>;
  /** Apex layout, theme, provider, and native-widget settings. */
  apex: ApexDashboardSettings;
}

export const DEFAULT_SETTINGS: OkfBrainSettings = {
  baseUrl: "http://127.0.0.1:8765",
  tokenFile: "",
  token: "",
  manageLocalService: true,
  pythonExecutable: "",
  deploymentConfig: "",
  serviceLogDirectory: "",
  documentParserPolicy: "markitdown-only",
  dashboardUiState: createDefaultDashboardUiState(),
  feedReadingPositions: {},
  apex: normalizeApexSettings(undefined),
};

export function renderOkfServiceSettings(container: HTMLElement, plugin: OkfBrainPlugin): void {
    new Setting(container)
      .setName("随 Obsidian 启动本地服务")
      .setDesc("打开 Obsidian 时启动；关闭或禁用插件时停止。")
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.manageLocalService).onChange(async (value) => {
          plugin.settings.manageLocalService = value;
          await plugin.saveSettings();
        }),
      );
    new Setting(container)
      .setName("文档转换策略")
      .setDesc("默认使用 MarkItDown。当前暂不使用 MinerU；仅在明确恢复该服务后切换高级策略。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("markitdown-only", "MarkItDown（默认）")
          .addOption("prefer-mineru", "高级：优先 MinerU，可降级")
          .addOption("mineru-required", "高级：必须 MinerU")
          .setValue(plugin.settings.documentParserPolicy)
          .onChange(async (value) => {
            plugin.settings.documentParserPolicy = value as OkfBrainSettings["documentParserPolicy"];
            await plugin.saveSettings();
          }),
      );
    new Setting(container)
      .setName("本地服务地址")
      .setDesc("只应使用 127.0.0.1 或 localhost。")
      .addText((text) =>
        text.setValue(plugin.settings.baseUrl).onChange(async (value) => {
          plugin.settings.baseUrl = value.trim();
          await plugin.saveSettings();
        }),
      );
    new Setting(container)
      .setName("Python 可执行文件")
      .setDesc("由安装器写入；用于随 Obsidian 启动本地服务。")
      .addText((text) =>
        text.setValue(plugin.settings.pythonExecutable).onChange(async (value) => {
          plugin.settings.pythonExecutable = value.trim();
          await plugin.saveSettings();
        }),
      );
    new Setting(container)
      .setName("部署配置")
      .setDesc("Vault 外 deployment.json 的完整路径。")
      .addText((text) =>
        text.setValue(plugin.settings.deploymentConfig).onChange(async (value) => {
          plugin.settings.deploymentConfig = value.trim();
          await plugin.saveSettings();
        }),
      );
    new Setting(container)
      .setName("配对 token 文件")
      .setDesc("由本机安装器创建在 Vault 外；这里只保存文件路径，不保存 token。")
      .addText((text) =>
        text
          .setPlaceholder("E:\\ObsidianData\\OKF-Brain-State\\secrets\\local-api-token")
          .setValue(plugin.settings.tokenFile)
          .onChange(async (value) => {
            plugin.settings.tokenFile = value.trim();
            await plugin.reloadLocalToken();
            await plugin.saveSettings();
          }),
      );
}

export function okfServiceSettingDefinitions(plugin: OkfBrainPlugin): SettingDefinitionItem[] {
  return [{
    type: "group",
    heading: "OKF / Engine",
    items: [{
      name: "OKF 与本地服务",
      desc: "配置 Engine、本地文档转换和 Vault 外凭据路径。",
      aliases: ["Engine", "MarkItDown", "Python", "token"],
      render: (setting) => {
        setting.settingEl.addClass("dashboard-settings-section");
        setting.settingEl.empty();
        renderOkfServiceSettings(setting.settingEl, plugin);
      },
    }],
  }];
}

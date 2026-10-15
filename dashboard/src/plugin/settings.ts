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
  dashboardUiState: DashboardUiState;
  /** Compatibility mirror for settings written before Dashboard UI state v1. */
  feedReadingPositions: Partial<Record<"ai-daily" | "treehole", FeedReadingPosition>>;
  /** Apex layout, theme, provider, and native-widget settings. */
  apex: ApexDashboardSettings;
  tasks: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: OkfBrainSettings = {
  baseUrl: "http://127.0.0.1:8765",
  tokenFile: "",
  token: "",
  manageLocalService: true,
  pythonExecutable: "",
  deploymentConfig: "",
  serviceLogDirectory: "",
  dashboardUiState: createDefaultDashboardUiState(),
  feedReadingPositions: {},
  apex: normalizeApexSettings(undefined),
  tasks: {},
};

export function renderOkfServiceSettings(container: HTMLElement, plugin: OkfBrainPlugin): void {
    renderOriginalFileSettings(container);
    if (plugin.isMobile) {
      container.createDiv({ text: "保持 LiveSync 开启。原件随笔记全量同步；仅保存不会自动转换，明确选择转换后才由电脑处理。" });
      return;
    }
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
      .setName("本地服务地址")
      .setDesc("只应使用 127.0.0.1 或 localhost。")
      .addText((text) =>
        text.setValue(plugin.settings.baseUrl).onChange(async (value) => {
          plugin.settings.baseUrl = value.trim();
          await plugin.saveSettings();
        }),
      );
    const advanced = container.createEl("details");
    advanced.createEl("summary", { text: "高级启动设置" });
    new Setting(advanced)
      .setName("Python 可执行文件")
      .setDesc("由安装器写入；用于随 Obsidian 启动本地服务。")
      .addText((text) =>
        text.setValue(plugin.settings.pythonExecutable).onChange(async (value) => {
          plugin.settings.pythonExecutable = value.trim();
          await plugin.saveSettings();
        }),
      );
    new Setting(advanced)
      .setName("服务配置文件")
      .setDesc("安装器创建的 deployment.json 路径，通常无需修改。")
      .addText((text) =>
        text.setValue(plugin.settings.deploymentConfig).onChange(async (value) => {
          plugin.settings.deploymentConfig = value.trim();
          await plugin.saveSettings();
        }),
      );
    new Setting(advanced)
      .setName("认证凭据文件")
      .setDesc("由安装器创建，保存在笔记库外。这里只设置凭据文件的位置。")
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

function renderOriginalFileSettings(container: HTMLElement): void {
  new Setting(container).setName("原件全量同步")
    .setDesc("原件保存在 sources/originals，与笔记统一通过 LiveSync 同步。PDF 和图片直接在 Obsidian 中阅读；无需配置独立文件服务或离线缓存。");
}

export function okfServiceSettingDefinitions(plugin: OkfBrainPlugin): SettingDefinitionItem[] {
  return [{
    type: "group",
    heading: "连接与导入",
    items: [{
      name: "连接与导入",
      desc: "设置文档转换、服务连接与高级启动选项。",
      aliases: ["Engine", "MarkItDown", "Python", "token"],
      render: (setting) => {
        setting.settingEl.addClass("dashboard-settings-section");
        setting.settingEl.empty();
        renderOkfServiceSettings(setting.settingEl, plugin);
      },
    }],
  }];
}

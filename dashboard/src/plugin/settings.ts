import { App, PluginSettingTab, Setting } from "obsidian";

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
};

export class OkfBrainSettingTab extends PluginSettingTab {
  public constructor(
    app: App,
    private readonly plugin: OkfBrainPlugin,
  ) {
    super(app, plugin);
  }

  public display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("随 Obsidian 启动本地服务")
      .setDesc("打开 Obsidian 时启动；关闭或禁用插件时停止。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.manageLocalService).onChange(async (value) => {
          this.plugin.settings.manageLocalService = value;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(this.containerEl)
      .setName("文档转换策略")
      .setDesc("默认使用 MarkItDown。当前暂不使用 MinerU；仅在明确恢复该服务后切换高级策略。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("markitdown-only", "MarkItDown（默认）")
          .addOption("prefer-mineru", "高级：优先 MinerU，可降级")
          .addOption("mineru-required", "高级：必须 MinerU")
          .setValue(this.plugin.settings.documentParserPolicy)
          .onChange(async (value) => {
            this.plugin.settings.documentParserPolicy = value as OkfBrainSettings["documentParserPolicy"];
            await this.plugin.saveSettings();
          }),
      );
    new Setting(this.containerEl)
      .setName("本地服务地址")
      .setDesc("只应使用 127.0.0.1 或 localhost。")
      .addText((text) =>
        text.setValue(this.plugin.settings.baseUrl).onChange(async (value) => {
          this.plugin.settings.baseUrl = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(this.containerEl)
      .setName("Python 可执行文件")
      .setDesc("由安装器写入；用于随 Obsidian 启动本地服务。")
      .addText((text) =>
        text.setValue(this.plugin.settings.pythonExecutable).onChange(async (value) => {
          this.plugin.settings.pythonExecutable = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(this.containerEl)
      .setName("部署配置")
      .setDesc("Vault 外 deployment.json 的完整路径。")
      .addText((text) =>
        text.setValue(this.plugin.settings.deploymentConfig).onChange(async (value) => {
          this.plugin.settings.deploymentConfig = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(this.containerEl)
      .setName("配对 token 文件")
      .setDesc("由本机安装器创建在 Vault 外；这里只保存文件路径，不保存 token。")
      .addText((text) =>
        text
          .setPlaceholder("E:\\ObsidianData\\OKF-Brain-State\\secrets\\local-api-token")
          .setValue(this.plugin.settings.tokenFile)
          .onChange(async (value) => {
            this.plugin.settings.tokenFile = value.trim();
            await this.plugin.reloadLocalToken();
            await this.plugin.saveSettings();
          }),
      );
  }
}

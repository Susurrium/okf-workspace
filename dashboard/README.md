# OKF Workspace Dashboard

Obsidian 工作台插件。入口为 `src/plugin/main.ts`；Apex 提供工作台框架，OKF Section 经 `features/workbench/okf-surface-sections.ts` 挂载共享视图。Dashboard 直接读取 Vault，执行简单人工等价编辑，并通过 Engine API 请求领域操作、通过 Claudian Bridge 交接对话。

## 开发

在此目录执行 `npm ci`、`npm run check`、`npm test`、`npm run build`。根脚本可统一安装与检查；完整环境和验收规则见[开发指南](../docs/DEVELOPMENT.md)。

构建生成 `dist/main.js` 与合并后的 `dist/styles.css`，插件 manifest 位于本目录。
实机环境、更新和退出遵循[开发指南](../docs/DEVELOPMENT.md#正式发布后的继续开发)；
单独安装插件和正式版本包升级见[部署运维](../docs/DEPLOYMENT.md#plugin-deployment)。

## 边界与来源

- [架构与写入边界](../docs/architecture/README.md)、[API/Bridge/命令协议](../docs/INTERFACES.md)。
- [上游基线与更新流程](UPSTREAM.md)、[验收台账](ACCEPTANCE.md)。
- `apex/` 是上游源码 subtree；保留许可、工具链和验证脚本。仅本目录的构建产生 OKF 插件，CI 由仓库根工作流负责。
- Apex-native 组件保留各自数据模型；工作台 Markdown 是用户数据，不是 Engine Artifact 或可丢弃缓存。

日常操作见[使用指南](../docs/USER-GUIDE.md)。

# OKF Workspace Dashboard

Obsidian 工作台插件。构建入口为 `src/plugin/main.ts`；Apex 提供外框与原生组件，
`features/workbench/okf-surface-sections.ts` 挂载共享业务视图。工作台和独立页面复用同一组服务与操作。

在本目录执行 `npm ci`、`npm run check`、`npm test`、`npm run build`。
构建生成 `dist/main.js`、`dist/styles.css`，manifest 位于本目录；测试和部署入口见[开发指南](../docs/DEVELOPMENT.md)。
Tasks 源码位于 `vendor/tasks/`，适配层位于 `tasks-integration/`，生成文件不手工修改。

- [使用指南](../docs/USER-GUIDE.md#分区与工作台)：分区、任务、快速记录与项目操作。
- [架构与数据](../docs/architecture/README.md)：领域归属、人工编辑与原生组件数据边界。
- [接口](../docs/INTERFACES.md)：Engine API、插件命令和 Claudian Bridge。
- [上游来源与采用策略](UPSTREAM.md)、[验收证据](ACCEPTANCE.md)。

`apex/` 保留上游许可、工具链和验证脚本；统一构建与 CI 由仓库根管理。

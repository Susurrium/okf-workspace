# OKF Workspace Dashboard

Obsidian 工作台插件。入口为 `src/plugin/main.ts`；Apex 提供工作台框架，OKF Section 经 `features/workbench/okf-surface-sections.ts` 挂载共享视图。Dashboard 直接读取 Vault，执行简单人工等价编辑，并通过 Engine API 请求领域操作、通过 Claudian Bridge 交接对话。

业务功能在工作台和独立页面共用视图与操作；今天和每日更新按场景组织内容。分区范围、就地操作、分页、导航和兼容行为见[使用指南](../docs/USER-GUIDE.md#分区与工作台)。新预设只用于新建工作台。

工作台沿用 Apex 的切换按钮、侧栏组件与分区操作。标题和外框由 Apex 负责，独立打开、刷新及关联范围显示在分区标题栏；内部保留内容分组。对象操作、任务表单和用途判断共用服务，课程和项目可以同时关联。

仅有原件的 Source 可以先保存学习或知识用途；明确转换后再生成。资料页支持打开原件、转换正文，以及使用已知转换记录重新转换。配置保存等待文件写入完成，失败保留输入并恢复本次未提交的配置字段；后续编辑与未知字段继续保留。

`domain/note-identity.ts` 定义资料用途身份；`domain/operation-presentation.ts` 定义恢复动作展示；`features/workbench/section-config.ts` 负责声明式范围。基础笔记行和任务完成控件位于 Apex 的 `note-row.ts`、`task-checkbox.ts`，支持上游默认宿主。用途判断共用 `ui/material-decision.ts`；异步按钮共用 `ui/async-action.ts`。这些展示规则不替代 Engine 状态机。

## 开发

Tasks 与工作台清单的范围、操作、任务格式和接管方式见[任务与工作台清单](TASKS.md)。

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

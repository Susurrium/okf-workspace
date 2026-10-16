# OKF Workspace

以 Obsidian Vault 为中心的个人工作空间。Markdown/YAML 保存长期内容，Engine 负责领域操作与后台任务，
Dashboard 提供工作台，Claudian 提供内嵌 Codex 会话。

## 文档入口

| 文档 | 阅读目的 |
| --- | --- |
| [使用指南](docs/USER-GUIDE.md) | 日常记录、任务、资料、学习、项目与插件操作 |
| [开发与验收](docs/DEVELOPMENT.md) | 开发环境、固定测试环境、构建、检查与文档维护 |
| [部署运维](docs/DEPLOYMENT.md) | 安装升级、转换配置、同步备份、迁移与恢复 |
| [架构与数据模型](docs/architecture/README.md) | 模块边界、数据归属、Artifact 语义与工作台格式 |
| [接口与集成](docs/INTERFACES.md) | API、CLI、Feed、插件命令和 Claudian Bridge |

[交互式信息流与架构图](docs/architecture/visualizations/index.html)可离线查看完整信息流与模块关系。

[![系统总览](docs/architecture/visualizations/overview.svg)](docs/architecture/visualizations/index.html#overview)

## 仓库与运行

| 目录 | 职责 |
| --- | --- |
| `engine/` | 领域模型、导入、Feed、检索、API、CLI、后台任务及可部署 Vault 资源 |
| `dashboard/` | Obsidian 工作台、Apex 源码与集成层 |
| `claudian/` | 助手界面、会话与 Provider runtime |
| `services/`、`integrations/` | 可选转换服务及历史恢复资源 |
| `deploy/`、`scripts/`、`tests/` | 安装运维、构建检查与跨组件验证 |
| `docs/` | 上述五份指南及架构图 |

生产 Vault、原件、Runtime State、索引、会话和密钥均位于仓库外。
正式程序从已验收版本包安装到独立目录；开发在本仓库进行，日常实机验收使用固定 `OKF-Test`。
多设备通过 LiveSync 与 CouchDB 同步 Vault 和完整原件，本机 State 与凭据按设备保留。
安装目标、运行状态和恢复依据以部署配置及实际回执确认。

## 组件维护

- Engine：[开发规则](engine/AGENTS.md)、[Vault Contracts](engine/workspace/vault/system/contracts/README.md)。
- Dashboard：[构建与接缝](dashboard/README.md)、[上游采用策略](dashboard/UPSTREAM.md)、[验收证据](dashboard/ACCEPTANCE.md)。
- Claudian：[组件说明](claudian/README.md)、[上游与 OKF 适配](claudian/UPSTREAM.md)。

历史版本、开发过程和旧发布说明通过 Git 历史查阅。Contracts 是格式权威，组件验收台账记录具名产物的实际验证范围。

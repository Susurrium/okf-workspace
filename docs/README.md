# 文档索引

根 [README](../README.md) 加上以下七份指南构成现行主文档。每项内容只维护一个正文位置。

| 文档 | 内容 |
| --- | --- |
| [架构](architecture/README.md) | 系统概览、模块边界、数据归属 |
| [数据模型](DATA-MODEL.md) | Artifact 字段、用途、受管正文 |
| [开发与验收](DEVELOPMENT.md) | 固定测试环境、临时夹具、检查矩阵、验收证据与退出 |
| [使用指南](USER-GUIDE.md) | 工作台、导入、剪藏、学习、项目与多设备阅读 |
| [部署运维](DEPLOYMENT.md) | 首次启用、升级、测试环境恢复、同步、备份与退役 |
| [接口与集成](INTERFACES.md) | API、CLI、资源同步与迁移、Feed、插件命令与 Bridge |
| [当前计划](DEVELOPMENT-PLAN.md) | 后续事项和完成依据 |

## 组件说明与证据

- [交互式信息流与架构图](architecture/visualizations/index.html)：离线查看完整分支与模块关系；规范仍以架构文档和 Contracts 为准。
- Engine：[组件说明](../engine/README.md)、[Vault Contracts](../engine/workspace/vault/system/contracts/)。
- Dashboard：[组件说明](../dashboard/README.md)、[上游基线](../dashboard/UPSTREAM.md)、[验收台账](../dashboard/ACCEPTANCE.md)。
- Claudian：[组件说明](../claudian/README.md)、[上游版本](../claudian/UPSTREAM.md)、[OKF 补丁与 Bridge 类型](../claudian/OKF-PATCHES.md)。
- 可选服务：[MarkItDown](../services/markitdown/README.md)、[自建 MinerU](../integrations/mineru/README.md)。
- 历史恢复：[Originals 恢复服务](../services/originals/README.md)。
- [当前发布记录](releases/0.9.2.md)。历史发布说明、路线图、访谈和阶段报告通过 Git 历史查阅。

2026-10-06 将分散的转换、原件、移动端、同步、API、Feed 和插件说明合并到上述指南，移除旧跳转入口；2026-10-07 清理历史过程文档与旧发布说明，历史内容保留在 Git 中。维护规则见[开发与验收](DEVELOPMENT.md#文档维护)。

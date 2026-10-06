# 历史记录

这些文件保留其编写时的目标、状态和验证证据，不是当前开发规范。
当前文档从[文档索引](../README.md)进入，架构以 [architecture/](../architecture/README.md#system-overview) 为准。

| 归档 | 内容 | 当前对应依据 |
| --- | --- | --- |
| [2026-09-apex](2026-09-apex/APEX-DASHBOARD-DEVELOPMENT-PLAN-2026-09-21.md) | Apex 集成提案、功能审计、共享 Surface 实施与当时的实机、回滚记录 | [验收台账](../../dashboard/ACCEPTANCE.md)、[上游基线](../../dashboard/UPSTREAM.md) |
| [2026-08-ai-papers](2026-08-ai-papers/specs/2026-08-24-ai-papers-reading-integration-design.md) | AI Papers 原始设计与任务计划；其中待复核和未勾选状态是历史快照 | [Feed 工作流](../INTERFACES.md#feeds)、现行 Feed 实现和测试 |
| [2026-08-personalization](2026-08-personalization/PERSONALIZATION-INTERVIEW.md) | 个性化访谈、审计和学习原型 | 归档决策与访谈、生产 Vault 中用户确认的偏好 |
| [2026-09-reliability](2026-09-reliability/RELIABILITY-IMPLEMENTATION-2026-09-08.md) | 当时的可靠性实施与测试结果 | [测试计划](../DEVELOPMENT.md)、现行实现和回归测试 |

2026-10-06 整理时已更新移动文件的链接和引用。归档中的旧源码路径和外部仓库路径仍表示当时的实现，
不能据此重新引入已删除的模块、状态机或部署流程。

新增归档：

- [原 monorepo 分阶段路线图](2026-08-workspace/DEVELOPMENT-PLAN.md)。
- [个性化决策与设计假设](2026-08-personalization/PERSONALIZATION-DECISIONS.md)，不作为部署后的用户偏好。
- [Apex 3.6.5 同步与验收过程](2026-09-apex/apex-sync-3.6.5-plan.md)、[3.6.0 升级演练](2026-09-apex/apex-update-exercise-2026-09-21.md)。

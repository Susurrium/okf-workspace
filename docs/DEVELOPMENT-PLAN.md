# 当前开发与维护计划

[文档索引](README.md) · [架构](architecture/README.md) · [验收方法](DEVELOPMENT.md)

更新：2026-10-06。本文件记录后续事项，不替代当前架构、Contracts 或实现。原 monorepo 分阶段路线图保留在[历史计划](archive/2026-08-workspace/DEVELOPMENT-PLAN.md)。组件上线状态以实际部署回执与验收台账为准，不以这里的任务列表推断。

## 当前基线

- Engine、Dashboard、Claudian 使用同一仓库与根检查入口，保持各自依赖树。
- 原件位于生产 Vault 并通过 LiveSync 全量同步；工作台默认仅保存，明确选择才转换或生成。
- Dashboard 沿用 Apex 共享 Surface，Engine 拥有状态机与 Artifact 发布，Claudian 通过 Bridge 交接。
- 当前 Dashboard 上游版本与接受状态见[上游基线](../dashboard/UPSTREAM.md)及[验收台账](../dashboard/ACCEPTANCE.md)；Claudian 见[组件上游记录](../claudian/UPSTREAM.md)。

## 后续维护事项

| 事项 | 后续动作 | 完成依据 |
| --- | --- | --- |
| Dashboard 大文件 | 在后续功能修改时继续按职责提取 `dashboard-view.ts` 与入口组合逻辑；优先共享实际 Surface，避免重建旧页面实现 | 相关视图回归通过，接口与状态归属不变 |
| 旧 Originals 退役 | 核对旧服务 blobs、旧设备待上传数据、Vault 哈希和回退备份，完成后退役恢复服务与独立部署资产 | 迁移清单、恢复验证与明确的退役记录；不能仅凭源码测试删除旧数据 |
| 多设备上线 | 按实际使用设备验证原件、请求、回执和插件版本同步；核对设备本地配置与容量 | 空测试 Vault 同步、离线保存、乱序到达、重复请求和原生打开的验收证据 |
| 上游升级 | 仅在有明确收益时选择 Apex/Claudian 候选，固定版本与 commit，检查接缝后验收 | 组件检查、根检查、独立 Obsidian 验收与更新后的基线记录 |
| 文档维护 | 功能、接口或部署改变时同步修改对应主文档；完成阶段的过程记录归档 | 本地链接、命令与实际配置一致，无重复正文或过时入口 |

以上是维护方向，不新增已承诺的产品功能，也不宣称生产迁移、备份或多设备验收已经完成。

## 每次变更的交付要求

先在合成 Vault 验证当前 Contracts 和写入边界，再按[开发与验收](DEVELOPMENT.md)完成相关检查。涉及安装、同步、转换服务或恢复时使用[部署运维](DEPLOYMENT.md)；上线后记录实际文件哈希与运行证据。

兴趣、长期价值和学习完成由用户明确判断。生产笔记、原件、State、索引与秘密继续留在仓库外。未部署的访谈决策只作[历史参考](archive/2026-08-personalization/PERSONALIZATION-DECISIONS.md)，不自动成为用户偏好。

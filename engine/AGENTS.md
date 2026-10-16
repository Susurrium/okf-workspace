# Engine 开发规则

## 规范入口

- 继承[仓库规则](../AGENTS.md)；模块与依赖遵循[架构](../docs/architecture/README.md)。
- Artifact 以 [Contracts](workspace/vault/system/contracts/README.md) 为准；
  外部 OKF 兼容读取与 Workspace 严格写入的边界见[架构与数据模型](../docs/architecture/README.md#artifact-与公共字段)。
- 笔记整理、检索和 Skill 路由维护在[Vault 使用规则](workspace/vault/AGENTS.md)。
  该文件是部署资源，处理源码开发任务时不自动触发个人笔记工作流。

## Engine 约束

- API 与 CLI 组合现有应用流程；领域状态、Source 发布和持久化归属不得分散到客户端。
- Markdown 保存长期语义；索引、队列和执行记录是派生或运行数据，
  不建立替代正文的 Registry、重复正文链或额外的通用 Broker、Lease、审批发布层。
- 人类导航只使用 Bundle 根 index.md；log.md 用于连续日志，不承担目录导航。
- 空内容目录由初始化或首次写入创建，不使用 .gitkeep 占位。
- 更新用户内容遵循 Contract 的身份与区域保护；重试和恢复不得覆盖并发人工修改。

## 验证

- Python 修改完成相关 pytest、Ruff 和 Pyright；命令见[开发指南](../docs/DEVELOPMENT.md#检查与构建)。
- 流程变化验证实际数据与异常路径；跨组件变更遵循根规则的集成与整体检查要求。

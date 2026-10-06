---
type: Agent Policy
title: Workspace 开发约定
created_at: 2026-08-20
---

# Workspace 开发约定

## 权威顺序

1. 用户当前明确要求；
2. `workspace/vault/system/contracts/*.yaml`（数据格式与写入边界）；
3. `../docs/architecture/`（当前模块边界与数据归属）；
4. 当前测试与代码；
5. `../docs/DEVELOPMENT-PLAN.md`（开发计划，不覆盖当前架构与实现）；
6. 历史文档和旧项目只用于理解背景，不产生规范约束。

## 不可重新引入

- V2 Core Authority/Broker/Session/Protocol；
- Client/Activity Lease；
- Registry 作为知识正文权威；
- 普通 Job/Proposal/approve；
- Candidate/Reservation/Publication Saga；
- Study Pack、Wiki、Registry 的重复正文链。

## 数据原则

- OKF Markdown 是唯一权威语义层。
- 外部 OKF Concept 按 v0.2 宽容读取；Workspace 自产 Artifact 必须通过本地 OKF Profile。
- 只有 Bundle 根目录的 `index.md` 是保留导航页；任何子目录都不创建 `index.md`。
- `log.md` 是项目等需要连续追加记录时的保留文件，不承担目录导航。
- 空目录不使用 `.gitkeep` 占位，由首次写入自动创建。
- 未知 frontmatter 字段必须保留。
- AI 不得推断或自动写入 `studied_at`。
- 无人值守后台只允许原子创建目标或替换命名 `ai:auto` 区域；交互式 Codex 按用户明确授权写入。
- Original 保存在生产 Vault 的 sources/originals/，与笔记全量同步；密钥、运行状态、Feed cache 和向量索引不进入 Vault。
- 兴趣与长期价值只由用户判断；AI 不得为 Feed 生成这两个结论。
- 长期知识只使用 `type: Wiki`；不创建 Knowledge Concept 或 Reference。
- 未学习但长期有价值的资料可以直接生成 Wiki；只有用户明确确认完成时才写 `studied_at`。
- 只有无人审阅的自主 AI 长期输出需要 `generated`；普通格式整理和用户监督的人机协作不做细碎来源分类。
- 不建立 Item Record/Registry；用户语义直接保存在权威 Markdown YAML 中。
- `learning/queue.md` 不再是权威状态，学习视图从真实文件动态生成。
- AI 检索不依赖 `index.md`；先用检索索引找候选，再读取实际 Markdown。根 `index.md` 只服务人类导航。

## Codex 与 Skill 路由

- 生成第一版 Study Guide 使用 `prepare-study-guide`。
- 从当前对话增量完善既有 Study Guide 使用 `update-study-guide`。
- 从 Source 或完成的学习成果沉淀长期知识统一使用 `distill-wiki`。
- 整理、追加或局部润色 Daily 使用 `organize-daily`。
- 整理当前 Lesson 使用 `organize-lesson`；从 Lesson 另行生成 Study Guide 才使用 `prepare-study-guide`。
- 从当前对话更新项目日志与当前状态使用 `capture-project-progress`。
- 继续课程/项目、生成或更新 Wiki/学习材料、查找历史决定以及用户要求结合已有笔记时，先运行 `okf context "<问题>" --scope auto --json`。
- 检索结果只是候选；必须重新读取真实 Markdown，最终答复列出实际读取路径。

## 开发流程

- 每个功能必须对应开发规格中的用户流程和验收证据。
- 修改 Python 后运行相关 pytest、Ruff 和 Pyright。
- 修改 Dashboard 后运行 Vitest、TypeScript 检查和 production build。
- 不把窄单元测试冒充端到端完成。
- 只在统一仓库内修改当前任务所属模块；生产 Vault、State、Originals 和旧仓库不是测试夹具。

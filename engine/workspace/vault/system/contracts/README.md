---
type: System Contract
title: Workspace Artifact Contracts
---

# Workspace Artifact Contracts

本目录是 Workspace 笔记结构的唯一规范来源。每种权威 Markdown 只对应一个 YAML
Contract；Dashboard、Templater、Codex Skills、后台服务和验证器共同读取或遵守它。

- `base.yaml` 定义所有笔记共有的字段、类型和不可复用的状态含义。
- 每个 `<artifact>.yaml` 只定义该类型额外的路径、字段、状态和区域。
- `status` 只表示内容成熟度，不表示学习进度、项目进度或后台任务进度；缺失时按 OKF 规则视为 `stable`。
- `regions.required_ai` 必须使用成对的 `ai:auto` 标记；`regions.optional_ai` 允许旧笔记或纯人工笔记没有标记，但一旦出现就必须完整成对。自动 AI 只能写这些区域。
- `regions.required_human` 中的标记区域由用户拥有，自动 AI 不覆盖。
- 后台排队、运行、重试和错误详情只保存在 Vault 外的 State；Markdown 只保存长期有意义的内容状态。
- `generated` 只在内容真正生成成功后写入，不能表示排队或占位。
- 未知 YAML 字段必须保留；新增状态必须先修改 Contract 和验证器，再写入笔记。
- 临时扩展字段可以被保留，但只要 Dashboard、Skill 或程序开始读取某个字段，它就必须进入对应 Contract 并声明类型；不能让隐藏的代码约定长期游离在规范之外。

## Embedded task format

Task 是权威 Markdown 中的嵌入内容，不是独立 Artifact，也不新增第二份状态文件。

- 正式任务使用 `- [ ] #task <text>`；普通清单只有在界面明确选择“全部清单”时才参与聚合。
- 新建正式任务在行尾附加唯一 block ID，例如 `^task-abc123`。修改时优先按 block ID 定位；旧行只能在原行或唯一全文匹配成功时修改，歧义必须拒绝写入。
- `[scheduled:: YYYY-MM-DD HH:MM]` 表示计划执行时间，`[due:: YYYY-MM-DD HH:MM]` 表示截止时间，`⏰ YYYY-MM-DD HH:MM` 表示提醒时间。三者是独立事实，任何一个都不能覆盖另一个。
- YAML frontmatter、代码围栏、`Source` 和 `Digest` 正文中的清单不构成正式任务；普通清单过滤仍可显式显示其中的清单。
- 任务完成只修改同一原文 checkbox，不自动改变 Project 状态、兴趣判断或 `studied_at`。
- TypeScript 与 Python 消费者共同使用仓库根目录的 `tests/fixtures/tasks/task-cases.json` 验证筛选语义。

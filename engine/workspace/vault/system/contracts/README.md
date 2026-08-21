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

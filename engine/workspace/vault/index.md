---
okf_version: "0.2"
---

# Workspace 总目录

这是供人查看的稳定目录。日常操作从 Dashboard 进入；AI 检索会定位并读取真实 Markdown，不依赖本页内容。

## 1. 日常入口

| 入口 | 位置 | 用途 |
|---|---|---|
| Dashboard | Obsidian 左侧 Workspace 图标 | 快速创建、导入、筛选、查看进度和跳转 |
| Today | `life/daily/YYYY/MM/YYYY-MM-DD.md` | 今日日记、随手记录和明确任务 |
| Inbox | `inbox/captures/YYYY/MM/` | 尚未确定去向的输入 |
| Tasks | [正式任务视图](system/views/Tasks.md) | 汇总带 `#task` 的未完成任务 |

## 2. 内容结构

### Learning

- [学习视图](system/views/Learning.md)
- `learning/courses/<course>/course.md`：Course 主页
- `learning/courses/<course>/lessons/`：Lesson 原始记录与整理
- `learning/courses/<course>/guides/`：课程内 Study Guide
- `learning/guides/`：不属于某个课程的 Study Guide

### Projects

- [项目视图](system/views/Projects.md)
- `projects/<project>/project.md`：Project 目标和当前状态
- `projects/<project>/log.md`：无 YAML 的连续进展日志
- `projects/<project>/decisions/`：需要独立追溯的 Decision
- `projects/<project>/outputs/`：项目产物

### Knowledge

- `knowledge/wiki/`：长期复用的 Wiki 正文
- `knowledge/maps/`：组织 Wiki 关系和阅读路径的 Wiki Map

### Life & Self

- `life/daily/`：Daily
- `life/reflections/`：Reflection
- `life/reviews/`：Review
- `self/`：Profile 类型的方向、约束、能力、偏好和当前重点

## 3. 外部输入链路

```text
本地文件 → Original → Source → Source Text ┐
网页剪藏 → Capture  → Source → Source Text ├→ Study Guide → Wiki → Wiki Map
Feed     → Digest   → Source → Source Text ┘
```

- `feeds/ai-daily/`、`feeds/treehole/`：可快速浏览、再由人决定去向的 Digest
- `sources/records/<kind>/`：Source 身份、原件资源和持久用途列表 `uses[]`
- `sources/text/<kind>/`：转换、Feed 或 Web Clipper 得到的完整 Source Text
- `system/integrations/web-clipper/`：每个浏览器一次性导入的官方 Web Clipper 模板
- Original、运行状态、Feed cache、检索数据库和密钥保存在 Vault 外

## 4. 系统与协作

- [Agent Policy](AGENTS.md)
- [OKF Profile Contracts](system/contracts/README.md)
- `system/templates/canonical/`：Dashboard 和程序使用的正文模板
- `system/templates/core/`：Obsidian Core 插件模板
- `system/templates/interactive/`：供人手动调用的模板
- `system/views/`：Dataview、Tasks 等原生插件视图
- `system/reports/`：可读治理报告

## 5. 最短工作流

1. 随手内容写入 Daily 或 Capture；外部文档从 Dashboard 导入。
2. 由你决定：现在学习、稍后学习、直接生成 Wiki 或只保留 Source；Feed 暂时不判断时直接离开。
3. 第一版 Study Guide 使用 `$prepare-study-guide`；讨论后使用 `$update-study-guide`。
4. 长期沉淀使用 `$distill-wiki`；需要主题导航时使用 `$maintain-wiki-map`。
5. Project 进展写入 `log.md`，当前状态同步回 `project.md`。

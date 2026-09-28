---
okf_version: "0.2"
---

# 笔记导航

日常操作从 Obsidian 左侧的“工作台”进入，也可以通过这里浏览笔记。

| 想做什么 | 入口 |
|---|---|
| 记录今天、继续学习或推进项目 | 工作台 → 今天 |
| 整理随手记录和导入资料 | 工作台 → 待处理 |
| 阅读订阅与每日更新 | 工作台 → 订阅阅读 |
| 查看课程和学习笔记 | [学习目录](system/views/Learning.md) |
| 查看项目进度 | [项目目录](system/views/Projects.md) |
| 查找知识笔记和主题导航 | [知识目录](system/views/Knowledge.md) |
| 查看未完成任务 | [任务](system/views/Tasks.md) |
| 写日记、反思和复盘 | 工作台 → 生活 |
| 查看后台任务或解决连接问题 | 工作台 → 系统状态 |

## 保存与整理资料

导入文档、剪藏网页或阅读订阅后，可以选择：

- **现在学习**：保存资料，并生成辅助学习材料。
- **稍后学习**：保存资料，之后从学习页继续。
- **整理为知识笔记**：直接提炼可长期查用的内容，无需先完成学习。
- **只保存资料**：保留已获取的正文或摘要，供以后参考。

是否学习、是否值得保留由你决定。生成完成不会自动标记为已学完。

## 文件位置参考

| 内容 | 位置 |
|---|---|
| 待整理的随手记录 | `inbox/captures/` |
| 课程主页、课堂笔记和课程学习笔记 | `learning/courses/` |
| 独立学习笔记 | `learning/guides/` |
| 项目主页 | `projects/<project>/project.md` |`r`n| 项目日志 | `projects/<project>/log.md` |`r`n| 项目决策与产物 | `projects/<project>/decisions/`、`projects/<project>/outputs/` |
| 知识笔记与知识导航 | `knowledge/wiki/`、`knowledge/maps/` |
| 日记、反思与复盘 | `life/daily/`、`life/reflections/`、`life/reviews/` |
| 个人方向、偏好和当前重点 | `self/` |
| 资料的来源信息与正文 | `sources/records/`、`sources/text/` |
| 已打开的订阅汇总 | `feeds/` |

## 系统资源

- [助手工作规则](AGENTS.md)
- [笔记格式规范](system/contracts/README.md)
- `system/templates/core/`：日记模板
- `system/templates/interactive/`：手动创建反思、复盘等内容的模板
- `system/templates/canonical/`：程序新建笔记时使用的模板
- `system/integrations/web-clipper/`：浏览器网页剪藏模板
- `system/reports/`：笔记与链接检查报告

原文件、运行状态、订阅缓存、检索数据库和密钥保存在笔记库外。此页仅用于导航，不参与检索或决定笔记状态。

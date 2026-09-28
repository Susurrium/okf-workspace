---
type: System View
title: 知识目录
created_at: 2026-08-21T00:00:00+08:00
---

# 知识目录

在工作台中快速搜索和筛选，或使用下方目录浏览全部知识笔记。

```dataview
TABLE choice(type = "Wiki", "知识笔记", "知识导航") AS "类型", choice(status = "draft", "草稿", choice(status = "deprecated", "已弃用", "")) AS "状态", choice(generated AND (!verified OR max(verified.at) < generated.at), "待核验", choice(generated, "已核验", "")) AS "来源核验", file.mtime AS "更新"
FROM "knowledge"
WHERE type = "Wiki" OR type = "Wiki Map"
SORT file.mtime DESC
```

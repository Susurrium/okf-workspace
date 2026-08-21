---
type: System View
title: 知识目录
created_at: 2026-08-21T00:00:00+08:00
---

# 知识目录

Dashboard 负责快速搜索和筛选；本页提供可排序的完整原生目录。

```dataview
TABLE type AS "类型", status AS "状态", choice(generated AND (!verified OR max(verified.at) < generated.at), "待核验", choice(generated, "已核验", "")) AS "AI", file.mtime AS "更新"
FROM "knowledge"
WHERE type = "Wiki" OR type = "Wiki Map"
SORT file.mtime DESC
```

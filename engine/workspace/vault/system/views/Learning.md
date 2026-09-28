---
type: System View
title: 学习视图
created_at: 2026-08-20T00:00:00+08:00
---

# 学习视图

```dataview
TABLE choice(studied_at, "已完成", "未标记完成") AS "学习", file.mtime AS "更新"
FROM "learning"
WHERE type = "Study Guide"
SORT file.mtime DESC
```

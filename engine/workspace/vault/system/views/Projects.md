---
type: System View
title: 项目视图
created_at: 2026-08-20T00:00:00+08:00
---

# 项目视图

```dataview
TABLE default(project_category, "未分类") AS "类别", choice(project_status = "active", "进行中", choice(project_status = "paused", "已暂停", choice(project_status = "completed", "已完成", project_status))) AS "状态", file.mtime AS "更新"
FROM "projects"
WHERE type = "Project"
SORT project_status ASC, file.mtime DESC
```

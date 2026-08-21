---
name: organize-daily
description: Append, organize, or lightly polish one Workspace Daily while preserving the user's raw words. Use when the user says to record something today, organize today, optimize a diary entry, or extract explicit tasks. Do not infer personality or create a Wiki.
---

# Organize Daily

Work on the canonical note at `life/daily/YYYY/MM/YYYY-MM-DD.md`.

- **Append:** add the user's words to the raw capture area without paraphrasing them.
- **Organize:** summarize themes, events, and open loops inside the managed organized-daily region. Separately add deduplicated formal tasks under `## 任务` when the raw text contains the user's explicit actionable commitment.
- **Polish:** rewrite only the section the user names; keep the original meaning and retain raw text unless replacement is explicit.

Read the full target note plus `system/contracts/base.yaml` and `system/contracts/daily.yaml` before a structural change. These YAML Contracts are the only format authority. Preserve raw entries, existing tasks, unknown frontmatter, and user-authored sections. The managed summary belongs only in `organized-daily`; formal tasks are the one deliberate exception and belong under `## 任务`. Create one only when the user stated an actionable commitment, deduplicate it against existing tasks, and preserve any due date or recurrence supplied. Link a Project, Course, or Wiki only after resolving and reading the real target note. This ordinary user-directed organization does not receive a `generated` marker.

Do not invent mood, preference, personal facts, or completed actions. Do not create a Reflection or Wiki unless separately requested. Report the written Daily path.

---
name: organize-lesson
description: Organize one existing Workspace Lesson while preserving the student's raw classroom notes. Use when the user asks to整理、总结或结构化当前课堂笔记. Do not create a separate Study Guide unless separately requested.
---

# Organize Lesson

Improve the current Lesson without replacing the student's original record.

1. Identify and read exactly one Lesson, then read `system/contracts/base.yaml` and `system/contracts/lesson.yaml`. These YAML Contracts are the only format authority.
2. Preserve the complete `human:notes` region, questions, tasks, unknown frontmatter, and unrelated user sections.
3. Write a structured account of the class only inside `organized-lesson`: topic flow, central explanations, examples, unresolved points, and useful follow-up. Distinguish the student's wording from AI clarification in the prose when that distinction matters; do not add authorship taxonomy to YAML.
4. Add a formal task outside the managed region only when the user explicitly committed to it; deduplicate existing tasks.
5. Do not create a Study Guide, Wiki, Course, or Project unless separately requested.

Report the updated Lesson path. If the user also wants auxiliary learning material, finish this task first and use `prepare-study-guide` as a separate operation.

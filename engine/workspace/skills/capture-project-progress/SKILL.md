---
name: capture-project-progress
description: Record durable progress, decisions, blockers, and next actions in one existing Workspace Project. Use only when the user explicitly asks to record or organize project progress. Do not trigger merely because project work is being discussed.
---

# Capture Project Progress

Capture what changed without turning the project log into a transcript.

1. Identify exactly one Project and read its `project.md` and `log.md`. Read related Decisions, outputs, Sources, or Study Guides only when the update depends on them.
2. Separate user-reported events, tool-verified results, user decisions, AI proposals, blockers, and possible next steps. Do not promote a suggestion into a decision.
3. Read `system/contracts/base.yaml` and `system/contracts/project.yaml` before creating files or changing project structure. These YAML Contracts are the only format authority.
4. Append a dated log entry describing what happened, why it matters, confirmed decisions, blockers, and the immediate next action. Preserve all earlier log entries.
5. Update only the managed current-state region in `project.md` so it reflects the log. Use the file modification time for recency; do not maintain an `updated_at` field.
6. Create a separate `Decision` only for a consequential choice whose alternatives, rationale, and consequences deserve durable treatment.
7. Create formal tasks only from explicit commitments. Link detailed learning material or Wiki notes instead of duplicating them in the log.

Do not silently change scope, completion criteria, project status, or user-authored sections. Mark completion only when the user explicitly confirms it. Report all written paths and the resulting next action.

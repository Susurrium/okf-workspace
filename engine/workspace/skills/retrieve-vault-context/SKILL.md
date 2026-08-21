---
name: retrieve-vault-context
description: Find and read the minimum real Workspace Vault notes needed to answer a question or continue a Course, Project, or knowledge task. Use when the answer depends on existing notes and the relevant file is not already unambiguous. Do not use for ordinary chat, a fully specified single-file edit, or whole-Vault loading.
---

# Retrieve Vault Context

Return a small set of actual Markdown evidence, not search snippets or index metadata.

1. Start with files explicitly named by the user, attached by the UI, or already established as the active course/project/note. If one file is clearly sufficient, read it directly and stop.
2. Otherwise run `okf context "<question and useful alternate terms>" --scope auto --json`. Choose a narrower scope when the task is clearly learning, projects, knowledge, life, or self.
3. Treat retrieval results only as candidate paths. Open and read the Markdown files that support the answer. Never treat a title, embedding match, cache row, Dashboard preview, or root `index.md` as the note contents.
4. Use `type`, `title`, `description`, `aliases`, `tags`, `course`, `project`, and source links only to rank or expand candidates. `status` describes document maturity; `studied_at` is only a user-confirmed completion time. Neither field proves correctness or relevance.
5. Expand through links or a second retrieval only when the first evidence set leaves a concrete gap. Do not scan the entire Vault for reassurance.
6. For technical tasks, do not read `life/` or `self/` unless the request actually depends on personal context. For personal questions, use only the relevant self or life notes rather than loading the whole profile.

Do not write while using this Skill. In the answer, name the key Vault-relative paths actually used when local notes materially influenced the result. If evidence is missing or conflicting, say so without inventing a personal fact or prior decision.

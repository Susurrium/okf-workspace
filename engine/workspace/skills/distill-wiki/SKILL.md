---
name: distill-wiki
description: Create, update, merge, or split durable Workspace Wiki notes from Sources, Study Guides, or completed learning. Use when the user asks to generate a Wiki, preserve useful but unstudied material, or reconcile overlapping Wiki notes. Do not use for Study Guide preparation.
---

# Distill Wiki

Produce concept-centered long-term knowledge, not a source summary or transcript.

## Human-owned learning completion

- Omit `studied_at` by default, including when useful material is preserved without studying it.
- Write `studied_at` only after explicit confirmation that this learning has been completed.
- Never infer mastery, interest, value, agreement, or verification.

## Reconcile before writing

1. Read the explicit Source, Source Text, Study Guide, and relevant Course or Project context.
2. Use Vault retrieval to find related Wiki notes and read the strongest candidates.
3. Choose the smallest durable operation: update the note that already owns the concept; merge overlap that has no useful boundary; create a note for a distinct reusable concept; split only when the parts have independent uses and link neighborhoods.
4. Read `system/contracts/base.yaml` and `system/contracts/wiki.yaml` before creating or structurally changing a Wiki. These YAML Contracts are the only format authority.

Write a concise definition or conclusion, why and when it matters, mechanisms and relationships, constraints and tradeoffs, useful examples, uncertainty or conflicting evidence, provenance, and links to genuinely related notes. Preserve unknown fields and human-authored text. Do not create one Wiki per source by default or copy the source body.

There are no failed or pending Markdown drafts. Background task state belongs outside the Vault. If an unattended background worker creates a Wiki, write `generated: {by: process:codex-background, at: <timestamp>}` only after useful content exists and keep `sources`; an interactive user-directed Wiki does not need a `generated` marker merely because AI helped write it.

When multiple existing Wiki notes will be merged or split, state that operation before writing. Report whether the result was created, updated, merged, or split and list the written paths.

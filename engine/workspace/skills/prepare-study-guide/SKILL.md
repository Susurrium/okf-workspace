---
name: prepare-study-guide
description: Create the first useful Workspace Study Guide from Source Text, course material, Feed sources, or a Source. Use when the user asks to generate auxiliary material before learning. Do not use to update a guide from a later discussion or to generate a Wiki.
---

# Prepare Study Guide

Create a learning workspace that helps the user understand and work with the source.

## Inputs and target

1. Read every explicit source path. When given a Source, follow its `text` or source links and read the Source Text containing the actual content.
2. Read a course or project home note only when the source is assigned to it. Retrieve related Wiki context only when it materially clarifies prerequisites or terminology.
3. Update the existing Study Guide for the source when one exists. Otherwise create one at a path allowed by `system/contracts/study-guide.yaml`.
4. Read `system/contracts/base.yaml` and `system/contracts/study-guide.yaml` before creating or structurally changing the note. These YAML Contracts are the only format authority.

## Content

Build material in dependency order. Use only sections that help with this source, such as:

- goals, scope, and prerequisites;
- a map of the source's argument or structure;
- clear explanations of central concepts and mechanisms;
- derivations, procedures, examples, comparisons, or evidence;
- difficult points and common confusions;
- source anchors such as headings, pages, slides, or sections;
- active-recall and application questions;
- uncertainties, missing information, and a concrete next learning action.

Distinguish source-supported statements from clarifying synthesis. Do not fabricate page anchors, external facts, exam importance, user agreement, or user mastery.

For an existing note, update only its managed `study-material` region and preserve human notes, tasks, unknown frontmatter, and unrelated sections. Useful content in that region is the readiness signal; do not write runtime status fields. Write `studied_at` only when the user separately and explicitly confirms completion.

This is an interactive, user-directed operation. Do not add `generated` merely because AI drafted or formatted the material. A background worker may add `generated` only when it creates an unattended result that the user has not reviewed.

Report the Study Guide path and the source notes actually read.

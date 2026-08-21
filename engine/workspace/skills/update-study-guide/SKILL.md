---
name: update-study-guide
description: Integrate durable conclusions, explanations, corrections, examples, and important open questions from the current discussion into one existing Workspace Study Guide. Use when the user asks to organize the discussion or update the guide. Do not use for first-pass source preparation or Wiki generation.
---

# Update Study Guide

Update one existing Study Guide as a coherent learning workspace rather than appending a chat transcript.

1. Identify exactly one target note and read it completely. If more than one note is plausible, resolve the target from explicit paths, attachments, or the named course/topic before writing.
2. Read linked source material only where it is needed to verify or place the new conclusion. Retrieve other notes only when the discussion introduces an existing concept that should be reconciled or linked.
3. Extract durable value from the conversation: corrected misconceptions, explanations that unlocked understanding, decisive examples, experiment results, resolved questions, and important remaining questions.
4. Read `system/contracts/base.yaml` and `system/contracts/study-guide.yaml` before a structural change. These YAML Contracts are the only format authority.
5. Merge each point into the relevant section of the managed study-material region. Add a dated discussion increment only when chronology itself matters, such as an experiment or a decision sequence.

Preserve all human-authored regions, tasks, annotations, unknown frontmatter, uncertainty, and unrelated sections. Do not change `studied_at`, create a Wiki, add a `generated` marker, or infer preferences. Report the updated path and the main changes.

---
name: maintain-wiki-map
description: Create or update a Workspace Wiki Map that helps people navigate a real cluster of related Wiki notes. Use when the user asks for a knowledge map, topic overview, or durable navigation page. Do not use for a single concept or source summary.
---

# Maintain Wiki Map

Build navigation from the actual Wiki collection, not from titles alone.

1. Resolve the intended subject and read the relevant Wiki notes. Use `retrieve-vault-context` when the set is not already explicit.
2. Read `system/contracts/base.yaml` and `system/contracts/wiki-map.yaml`. Create the note only under `knowledge/maps/` with type `Wiki Map` and a useful `description`.
3. Organize links by concepts, dependencies, choices, or usage paths. Add a short explanation for each group so the map is more useful than a flat backlink list.
4. Link only notes that were actually inspected. Identify important gaps explicitly; do not create placeholder Wiki notes or infer that a title proves relevance.
5. Preserve unknown frontmatter, user sections, and manual ordering when updating an existing map. Use the `wiki-content` managed region when the note has one.

Do not duplicate Wiki content inside the map, record study completion, or add `generated` for an interactive user-directed update. Report the Wiki Map path and the principal Wiki notes read.

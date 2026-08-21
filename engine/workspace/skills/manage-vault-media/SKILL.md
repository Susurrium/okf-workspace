---
name: manage-vault-media
description: Import, save, rename, move, or embed images and other attachments in the Workspace Vault while preserving Obsidian links. Use when the user explicitly asks to keep media in the Vault or reorganize attachments. Do not trigger merely because an image is visible or needs analysis.
---

# Manage Vault Media

Manage durable files and their references; image understanding itself does not require this Skill.

1. Resolve the attachment folder from Obsidian settings or the current OKF media convention. Use a user-specified target when provided.
2. Create a descriptive, filesystem-safe filename, keep the real extension, and avoid overwriting an existing file.
3. Save or move the asset, then insert or update the note using the Vault's existing link style. Prefer Obsidian embeds such as `![[path/image.png]]` when the surrounding note uses wiki links.
4. When moving an existing asset, find and update the affected Markdown references. Do not mass-move a folder without an explicit request.
5. Keep binary data out of Markdown; never insert base64 payloads.
6. When a durable note needs provenance for the asset, use an OKF `resource` or `sources[].resource` link as allowed by its Contract; do not invent attachment-status fields.

Do not download an external image solely because it appears in a note or chat. Ask for or use explicit authorization to persist external media. Report the asset path and any notes whose links changed.

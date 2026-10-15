# Obsidian Tasks

Source: https://github.com/obsidian-tasks-group/obsidian-tasks

Release: 8.5.0, commit 84704d3 (release archive).

`LICENSE` and `package.json` retain their upstream contents. Integration code lives
in `dashboard/tasks-integration/`; generated bundles live in ignored
`dashboard/tasks-generated/`. Run `npm run build:tasks` to rebuild them.

The integration uses the upstream Vault cache, settings, status transitions, query
engine and editor. `src/TaskHost.ts` adds optional source, serializer-extension and
recurrence-extension callbacks, all inactive for the default upstream host.
Source guards cover indexing, parsing, editor commands, Live Preview and suggestions.
`Cache.refresh()` / `TasksPlugin.refreshTasks()` expose explicit cache refresh.
`EditTask.svelte` supports an optional pre-save check, explicit cancellation and
awaited submission with visible errors. The build routes file writes and the modal
through the workbench adapters; the modal embeds the upstream editor.

Retain the upstream license and source provenance when updating this dependency.

# OKF Apex Workbench release and rollback

> 历史记录（2026-10-06 归档）。下文保留当时的方案、状态和验证证据，不作为当前实现要求；当前边界见[系统架构](../../architecture/README.md#system-overview)，有效文档见[文档索引](../../README.md)。

> **Status update (2026-09-29):** gates P01–P08 and the isolated rollback comparison passed, then release
> v0.8.0 was installed and loaded in the production Vault. The backup, installer acceptance, and runtime
> checks are recorded in [Dashboard acceptance ledger](../../../dashboard/ACCEPTANCE.md). The cutover steps below describe the completed
> procedure and remain the rollback reference.

## Release identity

The only installed plugin is `okf-workspace-dashboard`, displayed as **OKF Apex Workbench**. The package is
the three files emitted under `dashboard/dist/`: `manifest.json`, `main.js`, and `styles.css`. The imported
`dashboard/apex/` tree is source and independent validation material; `apex-dashboard` must remain disabled
after cutover so only one plugin writes Dashboard files and Apex native JSON.

The release minimum is Obsidian 1.8.7 and the current package is desktop-only. The real acceptance run used
Obsidian 1.13.7.

## Cutover

1. Run `scripts/check.ps1` and `scripts/build.ps1` from a clean release commit.
2. Close or disable the legacy `apex-dashboard` plugin. Do not delete its directory yet.
3. Back up the target Vault and these plugin directories:
   `.obsidian/plugins/apex-dashboard/` and `.obsidian/plugins/okf-workspace-dashboard/`.
4. Run `deploy/windows/install.ps1`. Its staged replacement installs the unified bundle without using the
   repository as runtime storage.
5. Enable `okf-workspace-dashboard`, open each registered workbench once, and inspect any newer-schema
   compatibility warning before saving it.
6. Verify Project/Today/Calendar on one anchored task, exact-date Daily creation, one Engine workflow when
   Engine is enabled, and one Claudian handoff when Claudian is enabled.
7. Keep the legacy plugin disabled. Its data is a rollback source, not a concurrent writer.

On first load, the unified plugin copies existing `habits.json`, `expense.json`, `pomodoro.json`,
`reading.json`, and `weread-progress.json` byte-for-byte when the target file is absent. Existing target
files always win. The receipt is
`.obsidian/plugins/okf-workspace-dashboard/apex-native-data-takeover.json`. These files remain Apex JSON;
the cutover does not create Vault artifacts for habits, expenses, manual reading, or focus sessions.

## Rollback

1. Disable `okf-workspace-dashboard` and close its panes.
2. Preserve a copy of the unified plugin directory and every Vault note created after cutover. Do not
   restore the whole Vault over newer Project, Daily, Capture, Source, or learning notes.
3. Restore the previous `okf-workspace-dashboard` bundle atomically from the release backup. This is the
   preferred rollback when the Vault has already used `workbench_schema: 1` extensions.
4. If returning to standalone Apex, restore the pre-cutover Dashboard Markdown copy before enabling it.
   Standalone Apex 2.5.4 is not allowed to save a board that contains unverified newer OKF fields or custom
   sections.
5. Restore an Apex JSON file only when its unified target did not receive newer user changes. Compare the
   takeover receipt and file bytes first; never overwrite a changed target just because a legacy source
   exists.
6. Re-enable exactly one writer and verify the workbench, native widgets, and reading position.

Engine state, Originals, secrets, and Claudian runtime state live outside the plugin package and are not
rolled back with a Dashboard bundle. A Dashboard rollback must not replace those directories.

## Recovery checks

- A failed staged install leaves the previous plugin directory available to restore.
- Re-running native-data takeover is safe: equal files report `already-copied`; different targets report
  `target-kept`.
- A failed sticky-to-Capture conversion retains the card. A retry finds the durable source marker and does
  not create a second Capture.
- Engine or Claudian can remain unavailable during rollback; Vault reads and allowed light edits continue.

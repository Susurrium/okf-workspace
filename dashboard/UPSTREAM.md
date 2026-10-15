# Apex upstream baseline

The unified workbench imports PandoraReads/apex-dashboard as a source subtree at `dashboard/apex/`.
The current accepted source baseline is Apex 3.6.5. Its upstream validation and the 2026-09-29 production
cutover are recorded in the [acceptance ledger](ACCEPTANCE.md).

| Field | Locked value |
| --- | --- |
| Upstream | `https://github.com/PandoraReads/apex-dashboard.git` |
| Imported commit | `e8d99517c3e76a52a9bfe3ed75251a0d652d4a34` |
| Upstream release | `3.6.5` |
| Import prefix | `dashboard/apex/` |
| Unified plugin ID | `okf-workspace-dashboard` |
| Upstream plugin ID | `apex-dashboard` (source validation only) |
| License | Upstream `LICENSE` retained with the subtree |

The subtree is source provenance, not a second installed Obsidian plugin. The root `dashboard/` build is the
only release entry point. Generic integration patches inside the subtree must remain usable with default
upstream implementations and must not import OKF domain modules directly.

The imported `main.js` bundle and nested GitHub release/build workflows are not
retained in this monorepo. Build outputs are generated locally; CI and releases
are owned by the root workflow. Upstream source, styles, license, package metadata,
and validation scripts remain available for deliberate upgrades.

## Accepted 3.6.5 validation

The 3.6.5 subtree candidate passed Apex lint, TypeScript/esbuild production build, and all 44 Apex
`test:*` scripts. The unified Dashboard checks and root `scripts/check.ps1` passed. P01–P08, including
isolated Obsidian acceptance and upgrade/rollback comparison, are recorded in the acceptance ledger.
This promotes the source baseline for integration/release review. Production cutover completed on
2026-09-29; see the acceptance ledger for that installed-runtime evidence.

The original 2.5.4 import and 3.6.0 rehearsal remain historical provenance. Their exercise reports are
retained in Git history; the acceptance ledger records the accepted 3.6.5 outcome.

## Update procedure

1. Fetch the upstream repository and record the candidate commit and release.
2. Merge it into `dashboard/apex/` with `git subtree` on an isolated candidate branch.
3. Review changes to the parser/serializer, section types and menus, task/date parsing, Daily routing,
   database edits, plugin data paths, settings, and service lifetimes.
4. Run the upstream build/scripts, the unified Dashboard checks, shared fixture tests, and the acceptance
   scenarios in `dashboard/ACCEPTANCE.md`.
5. Exercise critical flows in the persistent test Vault using the [development acceptance rules](../docs/DEVELOPMENT.md#合成-vault-完整流程). Use a temporary fixture only when the upgrade scenario requires independent initial state; complete its cleanup and record the accepted commit here.
6. After acceptance or production cutover, update this baseline and the acceptance ledger with the resulting
   status. Retain completed audit and exercise reports in Git history, and keep the current outcome in
   this baseline and the acceptance ledger.

Passing a Git merge or TypeScript compilation alone is not an accepted upstream update.

## Workspace registry integration behavior

The local registry helper preserves Unicode letters in new filenames (`工作台 2` becomes
`工作台-2.md`) and uses the first registered path when the active-path setting is absent.
The OKF startup adapter additionally recovers a missing registry from existing workbench Markdown
before opening a view. Existing filenames are not automatically renamed or deleted. Preserve these
behaviors during subtree updates; regression coverage is in
`dashboard/tests/workspace-recovery.test.ts`.

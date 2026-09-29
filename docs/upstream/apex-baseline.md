# Apex upstream baseline

The unified workbench imports PandoraReads/apex-dashboard as a source subtree at `dashboard/apex/`.
The current accepted source baseline is Apex 3.6.5. Its upstream acceptance and production cutover
status are tracked in [the 3.6.5 update record](apex-sync-3.6.5-plan.md).

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

## Accepted 3.6.5 validation

The 3.6.5 subtree candidate passed Apex lint, TypeScript/esbuild production build, and all 44 Apex
`test:*` scripts. The unified Dashboard checks and root `scripts/check.ps1` passed. P01–P08, including
isolated Obsidian acceptance and upgrade/rollback comparison, are recorded in the update record and
acceptance ledger. This promotes the source baseline for integration/release review. Production cutover
completed on 2026-09-29; see the update record and acceptance ledger for installed-runtime evidence.

The original 2.5.4 import and 3.6.0 rehearsal remain historical provenance. The 3.6.0 rehearsal is
documented in `apex-update-exercise-2026-09-21.md`.

## Update procedure

1. Fetch the upstream repository and record the candidate commit and release.
2. Merge it into `dashboard/apex/` with `git subtree` on an isolated candidate branch.
3. Review changes to the parser/serializer, section types and menus, task/date parsing, Daily routing,
   database edits, plugin data paths, settings, and service lifetimes.
4. Run the upstream build/scripts, the unified Dashboard checks, shared fixture tests, and the acceptance
   scenarios in `docs/APEX-OKF-ACCEPTANCE-LEDGER.md`.
5. Exercise the critical flows in a disposable Obsidian Vault and update this file with the accepted commit.
6. After acceptance or production cutover, update this baseline and the acceptance ledger with the resulting
   status. Keep dated audit and test reports as historical evidence, and add a pointer to their later outcome
   when their original status is no longer current.

Passing a Git merge or TypeScript compilation alone is not an accepted upstream update.

# Apex upstream baseline

The unified workbench imports PandoraReads/apex-dashboard as a source subtree at `dashboard/apex/`.

| Field | Locked value |
| --- | --- |
| Upstream | `https://github.com/PandoraReads/apex-dashboard.git` |
| Imported commit | `dc7a7098689485f51a8b6195a691f8acc453b79a` |
| Upstream release | `2.5.4` |
| Import prefix | `dashboard/apex/` |
| Unified plugin ID | `okf-workspace-dashboard` |
| Upstream plugin ID | `apex-dashboard` (source validation only) |
| License | Upstream `LICENSE` retained with the subtree |

The subtree is source provenance, not a second installed Obsidian plugin. The root `dashboard/` build is the
only release entry point. Generic integration patches inside the subtree must remain usable with default
upstream implementations and must not import OKF domain modules directly.

## Baseline validation

Before integration, the locked checkout passed its TypeScript/esbuild production build. After subtree
import, all 28 `test:*` scripts in the locked package passed, including layout, calendar, web, media,
music, expense, WeRead, card movement, kanban, and mobile-stability checks. The outer OKF build also emits
one `dist/` package containing the OKF manifest, combined Apex/OKF stylesheet, and unified JavaScript entry.
These checks establish the imported and composed baseline; they do not prove real Obsidian behavior.

## Update procedure

1. Fetch the upstream repository and record the candidate commit and release.
2. Merge it into `dashboard/apex/` with `git subtree` on an isolated candidate branch.
3. Review changes to the parser/serializer, section types and menus, task/date parsing, Daily routing,
   database edits, plugin data paths, settings, and service lifetimes.
4. Run the upstream build/scripts, the unified Dashboard checks, shared fixture tests, and the acceptance
   scenarios in `docs/APEX-OKF-ACCEPTANCE-LEDGER.md`.
5. Exercise the critical flows in a disposable Obsidian Vault and update this file with the accepted commit.

Passing a Git merge or TypeScript compilation alone is not an accepted upstream update.

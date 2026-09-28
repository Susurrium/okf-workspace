# Apex upstream sync candidate: 3.6.5

Date: 2026-09-28
Status: **P01–P08 acceptance passed in the isolated Vault; branch is ready for integration/release review. Production cutover has not been performed.**

## Baseline and upstream commits

The previously exercised subtree baseline is Apex 3.6.0 (`f5d6f73e80435d4a5df81966d1ae2683f9220a92`).
The candidate is 3.6.5 (`e8d99517c3e76a52a9bfe3ed75251a0d652d4a34`). The intervening upstream commits are:

| Commit/change | Upstream change | Decision | Handling and reason |
| --- | --- | --- | --- |
| `36934d81` (3.6.1) | Section toolbar dropdowns, scoped media display, new-note templates, calendar task destination, per-theme glass buttons, theme studio and Pomodoro background behavior | **Adapt** | Adopt the UI/lifecycle changes; keep stable section IDs and route OKF managed-artifact writes through host policy. |
| `0dc25954` | First-install theme, widget backgrounds, countdown/anniversary presets and quote font | **Adapt** | Apply defaults only on first install; upgrades must preserve saved user choices. |
| `0be8e33c` (3.6.2) | Theme color presets, notes-section new-note settings and memo Markdown rendering | **Direct adopt** | These are generic Apex features; retain OKF ownership of project/task semantics and target-path policy. |
| `bf8ebf9b` (3.6.3) | Library grouping, memo templates, music `-110` recovery, refresh/scroll and widget sizing hardening | **Adapt** | Adopt upstream behavior while composing pane-local persisted positions with full-root scroll restoration. |
| `e8d99517` (3.6.5) | Card deletion, multiple templates, table-column controls, lunar anniversaries, focal points, calendar task times and progressive group rendering | **Adapt** | Adopt generic features; preserve identity-aware operations, unknown frontmatter, duplicate section names, Apex-native formats, and host-mediated OKF writes. |
| Release identity | Upstream `apex-dashboard` identity and independent release packaging | **Defer** | Keep only `okf-workspace-dashboard` enabled; a second plugin identity would create competing writers and violate the unified release boundary. |

Keep the installed plugin ID `okf-workspace-dashboard`. The upstream ID `apex-dashboard` is source provenance
only; do not enable or install a second plugin.

## Merge decisions and regression fixes

- Preserve OKF section anchors and lossless frontmatter/body serialization when combining upstream parser,
  library and section behavior.
- Preserve settings written by existing installations; first-install defaults must not reset an upgrade.
- Keep task `due`, `scheduled` and reminder date/time as separate values. Corrected the calendar scan so a
  same-day reminder time remains the end time when no due date exists.
- Treat `imagePos`, `showCover`, library grouping, table-column and template settings as managed serialized
  fields, so a later save updates or removes them instead of resurrecting stale raw values.
- Retain Apex native reading, music, Pomodoro and other data formats. OKF `studied_at` remains a human-only
  judgment and must never be inferred by AI or imported Apex behavior.
- Use native Obsidian dropdown menus for library controls. Tests now exercise the menu model and assert
  serialized YAML semantically rather than relying on optional quote formatting.

## Automated evidence

Completed in the candidate worktree:

- Apex ESLint: passed.
- Apex production TypeScript/esbuild build: passed.
- All 44 Apex `test:*` scripts: passed.
- The follow-up fixes to the five initially failing Apex checks were verified individually, then included in
  the 44-script rerun.
- Focused P07 Reading and identity regressions: 76 Dashboard tests passed. P08 mixed operation/conversion
  task-center scenario: passed in `dashboard-view.test.ts`, including cancel, retry and conversion-recovery
  callbacks.
- Reading-section cursor-pagination UI component test now traverses source and edition pages, checks cursor
  forwarding, deduplicates an overlapping source, and verifies the load-more controls disappear at exhaustion.
- Native takeover receipt regression confirms that raw receipt bytes change on each startup because
  `completedAt` and `copied`/`already-copied` status evolve, while normalized entries and copied target data
  remain stable.
- Atomic upgrade/rollback fixture restores the prior plugin artifacts while preserving `data.json`; the
  deployment migration test passes.
- Apex `npm audit --omit=dev` reports zero production dependency advisories. The full development tree reports
  7 advisories (5 high, 2 moderate) across `@humanfs/node`, `ajv`, `brace-expansion`, `fast-uri`, `flatted`,
  `js-yaml` and `minimatch`; assess these separately before publishing build tooling changes.
- Root `scripts/check.ps1`: passed. This includes plugin migration/rollback safety, Engine pytest (450), Ruff, Pyright,
  cross-component E2E (7 passed, 1 skipped), Dashboard typecheck/tests (241)/build, and Claudian
  typecheck/lint/tests (6,587)/architecture/build.

The first root-check attempts stopped because the isolated worktree lacked Engine dev tools and JavaScript
dependencies; those dependencies were installed from the checked-in lock/configuration. The subsequent
complete root-script run passed.

## Final acceptance gates

1. `scripts/check.ps1` completes successfully, including Engine, cross-component fixtures, Dashboard and
   Claudian checks.
2. In a disposable real Obsidian Vault, load and save a board with duplicate section headings, unknown YAML,
   newer `workbench_schema`, and free prose. Verify IDs, configuration and prose survive save, restart and
   reload, and verify two panes share writes without duplicate state.
3. Exercise new-note templates, table-column edits, card deletion, focal points, calendar task start/end
   times, same-day reminder-only tasks, and progressive rendering in Obsidian. Templates, columns, card
   deletion, focal points, calendar times, and progressive rendering passed in the isolated run.
4. Verify the unified plugin remains the only enabled Dashboard plugin. Immediately before rollback, capture
   the settings JSON semantic snapshot and SHA-256 for the five native Apex JSON files. After loading the prior
   package, compare settings after excluding only the transient `token` field, compare native JSON hashes, and
   compare the takeover receipt after normalizing `completedAt` and `copied`/`already-copied` status. Retest
   the settings comparison if any semantic fields differ. `scripts/dashboard-rollback-snapshot.ps1` implements
   this comparison and writes a redacted report outside the Vault; see the acceptance ledger for commands.
5. Confirm managed Project/Source operations still obey OKF artifact edit rules, native Apex data remains
   readable, and no path creates or infers `studied_at`.

Real Obsidian acceptance is recorded in `docs/APEX-OKF-ACCEPTANCE-LEDGER.md`.
On 2026-09-28, the disposable `OKF-Apex-Manual-Test` Vault loaded the candidate in an isolated profile.
Schema-99 preservation, duplicate sections, two-pane updates, plugin hot reload, the single plugin identity,
and unavailable-Engine behavior were exercised. A temporary Engine with a generated local token synced the
checked-in synthetic Feed fixtures before and after an Obsidian process restart. That run found and fixed a
missing AI Papers scroll-state initialization; the rebuilt plugin restored its scroll offset across workbench
switches. Calendar week view rendered scheduled, reminder, and due-only task times as expected. The UI also
verified multiple note templates and variable replacement, table-column hide/restore, card deletion, and
50-item progressive rendering. The banner editor persisted and cleared a 30%,70% focal point in the synthetic
board. P08 passed. A Reading-section component regression now traverses source and edition cursor pages through
the visible load-more controls, checking cursor arguments, overlapping-source deduplication, and exhaustion;
Engine pagination integration tests cover the backend pages. Follow-up acceptance in the isolated test Vault
completed live Producer and TreeHole sync, traversed all 39 editions of a registry-managed source across 10
cursor pages, and exercised UI load-more from 4 to 8 editions. The prior 3.6.0 package loaded under the unified
plugin identity; a fresh pre-swap snapshot compared after rollback passed identity, enabled state, semantic
settings, native-data bytes, and normalized takeover receipt. The 3.6.5 candidate was restored and reloaded,
and a second comparison against the baseline also passed. P07 and M9 are accepted for this isolated Vault;
the evidence and exact limits are recorded in `docs/APEX-OKF-ACCEPTANCE-LEDGER.md`.

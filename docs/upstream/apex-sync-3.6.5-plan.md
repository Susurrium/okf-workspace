# Apex upstream sync candidate: 3.6.5

Date: 2026-09-28
Status: **candidate; automated Apex and full root verification passed, real Obsidian acceptance is pending**.

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
  task-center scenario: passed in `dashboard-view.test.ts`.
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
   times, same-day reminder-only tasks, and progressive rendering in Obsidian.
4. Verify the unified plugin remains the only enabled Dashboard plugin. Upgrade, restart, rollback to the
   prior package, and verify plugin settings plus native Apex JSON remain intact.
5. Confirm managed Project/Source operations still obey OKF artifact edit rules, native Apex data remains
   readable, and no path creates or infers `studied_at`.

Real Obsidian acceptance is not recorded as passed. The runtime's execution policy rejected launching
`D:\Obsidian\Obsidian.exe` with an isolated profile, so the UI gates above must be run in an authorized
Obsidian acceptance environment before changing the candidate status or advancing the locked baseline.

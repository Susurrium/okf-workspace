# Apex × OKF acceptance ledger

This ledger is the implementation authority for the staged work described in
`APEX-DASHBOARD-DEVELOPMENT-PLAN-2026-09-21.md`. A row is complete only when its named automated evidence
passes and, where required, its disposable-Vault interaction has been recorded. Production user data is
never a test fixture.

## Product capability inventory

| Capability | Baseline owner | Integration decision | Planned evidence |
| --- | --- | --- | --- |
| Multi-workbench layout, theme, banner, drag/resize/collapse | Apex | Preserve and expose through the unified host | Upstream layout tests plus two-pane Obsidian scenario |
| Web, image, video, gallery, music, weather, countdown, lunar calendar | Apex | Preserve with explicit capability and lifecycle ownership | Upstream scripts plus lifecycle scenario |
| Notes collection, folder, database, DQL | Apex | Preserve; route managed-artifact mutations through edit policy | Contract-aware edit tests and Vault scenario |
| Habits, expenses, reading, focus | Apex native services | Preserve original formats and services; path takeover only | Byte/shape-preserving migration tests |
| Project | OKF Vault contract | Replace Apex project label with `workspace-projects`; keep old `projects` as notes collection | Project action and multi-section tests |
| Task, calendar, Daily, Capture | Shared Vault projection/actions | Unify identity, date fields, routing, and writes | Cross-language fixtures and end-to-end scenario |
| Learning, Knowledge, Inbox, Import | OKF/Engine | Add native sections and detail routes; reuse current services | Existing workflow tests plus section scenarios |
| Feed and Digest reading | OKF/Engine | Add native section while retaining history, pagination, and reading position | Feed workflow and lifecycle tests |
| Claudian | Existing bridge | Keep global and contextual entry points with graceful absence | Bridge tests and disabled-plugin scenario |
| Engine operations | Existing Engine API/monitor | Plugin-level ownership; local Vault reading/editing remains available offline | Service/lifecycle and unavailable-Engine scenarios |

## Existing OKF entry-point inventory

The unified plugin must retain the current Dashboard commands and ribbon entry, quick Capture and Daily
creation, project creation/status/log/Decision actions, explicit study completion and reversal, Feed source
and item workflows, document import, operation monitoring, Digest reading controls, semantic search, and the
Claudian v1 handoff. Each entry may move in the interface, but none may require the retired Dashboard View.

## Staged gates

| Stage | Deliverable | Gate status |
| --- | --- | --- |
| M0 | Scope, ownership, baseline, capability and acceptance ledgers | Complete: architecture ownership, this ledger, and `docs/upstream/apex-baseline.md`; local links and `git diff --check` passed |
| M1 | Apex subtree and one outer plugin build/identity | In progress: subtree imported at locked SHA; 28 upstream scripts, independent build, outer Vitest/typecheck/build, and single `dist/` package pass; disposable-Vault interaction remains |
| M2 | Existing OKF services, settings, commands, and plugin lifecycle exposed to new host | In progress: one outer plugin owns Apex native services plus existing OKF commands, Engine/operation lifecycle, Digest integration, Claudian bridge, and a single combined settings entry; multi-pane/disposable-Vault lifecycle run remains |
| M3 | Stable section IDs, lossless board repository, registry, pane-local state | In progress: stable IDs/anchors, duplicate-name routing, unknown YAML/body preservation, section registry, per-board shared state/write queues, three-way pre-write merge, and persisted pane-local workspace/collapse/scroll state implemented; real Obsidian interaction remains |
| M4 | Full Project experience and managed-artifact edit policy | In progress: registered `workspace-projects` Vault projection, independent persisted status filters, and existing create/open/log/Decision/status actions are connected; detail routing, related-content actions, and managed database/drag policy remain |
| M5 | Unified task/calendar/Daily/Capture loop | In progress: shared formal-task scanner/fixture, stable block identity, independent reminder/scheduled/due fields, exact-date OKF Daily creation, and Project/Today/Calendar projections and toggles implemented; full edit/move/archive and sticky-to-Capture recovery remain |
| M6 | Learning/Knowledge/Inbox/Import sections and details | Pending |
| M7 | Feed/Reading and default workbench presets | Pending |
| M8 | Native-data takeover, UX, capability, and performance work | Pending |
| M9 | Full release, rollback, real Obsidian, and upstream-update exercise | Pending |

## Final acceptance matrix

| ID | Scenario | Required evidence | Status |
| --- | --- | --- | --- |
| A01 | Create a dated Project action | One task body appears through Project, Today, and Calendar; completion from any view updates all | Automated shared-source projection/toggle coverage: `dashboard/tests/apex-task-identity.test.ts`, `dashboard/tests/project-section.test.ts`, and `dashboard/tests/vault-dashboard.test.ts`; disposable-Vault three-view run pending |
| A02 | Put one Project in two workbenches | Status synchronizes; removing one reference keeps the Project; filters remain independent | Automated filter/config and reference-only section coverage: `dashboard/tests/project-section.test.ts` and `dashboard/tests/apex-board-format.test.ts`; multi-workbench disposable-Vault run pending |
| A03 | Rename/reorder same-named sections | Stable IDs retain config, collapse, scroll, and body association | Automated format/identity coverage: `dashboard/tests/apex-board-format.test.ts`; DOM scroll and disposable-Vault run pending |
| A04 | Complete a board checklist from Calendar, then save layout | Completion remains after layout save/reload | Automated three-way merge coverage: `dashboard/tests/apex-board-merge.test.ts`; calendar UI run pending |
| A05 | Checkboxes in fences/YAML/Source Text/Digest | Formal-task query excludes them; explicit ordinary-checklist filter can still expose ordinary lists | Shared TS/Python fixture and scanner coverage: `tests/fixtures/tasks/task-cases.json`, `dashboard/tests/apex-task-identity.test.ts`, `engine/tests/integration/test_projections.py`; UI filter run pending |
| A06 | Reminder before due and scheduled distinct from due | All values render and edit independently; reminder never overwrites due | Parser/index coverage proves three independent fields in `dashboard/tests/apex-task-identity.test.ts`; edit UI coverage pending |
| A07 | Duplicate text, file rename, and line movement | Mutation finds the same anchored task or requests reread; never changes its twin | Stable block-ID relocation and concurrent-text preservation covered by `dashboard/tests/apex-task-identity.test.ts`; file-rename/disposable-Vault run pending |
| A08 | Database edits or drags a Project/Source | Legal action is used; identity, pair, managed regions, and path contract remain valid | Pending |
| A09 | Calendar creates task for a missing Daily | A valid Daily for the clicked date is created; no fallback to today or a board list | Integrated Calendar delegates to exact-date `VaultNoteService.appendDailyTask`; creation/contract path covered in `dashboard/tests/vault-note-service.test.ts`; disposable-Vault run pending |
| A10 | Feed to study/wiki/reference with one Source in several Projects | One Source, independent idempotent uses, correct context, no inferred interest | Pending |
| A11 | Finish a book/timer or generate Study Guide | `studied_at` is unchanged until explicit human confirmation | Pending |
| A12 | Convert sticky note to Capture with interruption/repeated click | Text is recoverable and idempotent; no long-lived duplicate body | Pending |
| A13 | Close section or last workbench pane | Background work continues, notification occurs once, reopened UI shows real result | Pending |
| A14 | Engine unavailable | Vault read/light edits work; import/generation reports the exact unavailable capability | Pending |
| A15 | Claudian unavailable | Other workbench features work; AI action offers clear context/prompt fallback | Pending |
| A16 | Feed return, note update, or theme switch | Unrelated web/music/timer state survives; reading page and position survive | Pending |
| A17 | Unknown field/section/free prose/newer board version | Data is retained and compatibility limit is visible; save never silently drops it | Automated preservation coverage and unknown-section compatibility UI implemented; disposable-Vault run pending |
| A18 | Re-run interrupted legacy Apex-data takeover | Original format remains, manual changes are not overwritten, no Vault notes are created, one writer remains | Pending |
| A19 | Apply an upstream update | Native Apex and integrated OKF scenarios pass after a real subtree update exercise | Pending |

## Synthetic Vault scenarios

Automated integration fixtures will create only synthetic data and cover: two same-named sections with
unknown YAML/prose; two same-text tasks with different anchors; fenced and YAML block checkboxes; a missing
historical Daily; one Source with study/wiki/reference uses in two Projects; a managed Project and Source
opened through database/kanban views; a pending Engine operation observed across pane closure; and two
conflicting native-data directories for takeover recovery.

For each completed row, replace `Pending` with the test/fixture path and the recorded disposable-Vault run.
No status may be inferred from a nearby unit test that does not execute the complete scenario.

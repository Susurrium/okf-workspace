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
| M1 | Apex subtree and one outer plugin build/identity | Complete: locked subtree, all 28 baseline scripts, independent/outer builds, one installed identity, and real Obsidian load passed |
| M2 | Existing OKF services, settings, commands, and plugin lifecycle exposed to new host | Complete: one outer plugin owns native services and OKF workflows; 22 commands, reload, two-pane, pane-close timer, Engine-offline, and Claudian-absent runs passed |
| M3 | Stable section IDs, lossless board repository, registry, pane-local state | Complete: stable IDs, lossless schema/body round-trip, shared write coordination, and real two-pane save/reload passed |
| M4 | Full Project experience and managed-artifact edit policy | Complete: Project summary/actions, expandable related content, two-workbench synchronization, typed status mutation, and Source mutation denial passed |
| M5 | Unified task/calendar/Daily/Capture loop | Complete: shared task identity, three independent editable dates, exact-date Daily routing, cross-view completion, and idempotent sticky conversion passed |
| M6 | Learning/Knowledge/Inbox/Import sections and details | Complete: native projections expose their underlying Vault details and existing create/complete/route/generate/import actions; offline and workflow tests passed |
| M7 | Feed/Reading and default workbench presets | Complete: Digest/source history, pagination, decision receipts, position, presets, and global search are reachable; position survived a real theme/reload cycle |
| M8 | Native-data takeover, UX, capability, and performance work | Complete for the declared desktop release: original JSON formats, plugin-lifetime services, per-pane UI, guarded writes, and real takeover/reload passed; no mobile-support claim is made |
| M9 | Full release, rollback, real Obsidian, and upstream-update exercise | Complete: release/rollback guide, 19-row real acceptance report, root validation, and isolated Apex 3.6.0 subtree exercise recorded |

## Final acceptance matrix

| ID | Scenario | Required evidence | Status |
| --- | --- | --- | --- |
| A01 | Create a dated Project action | One task body appears through Project, Today, and Calendar; completion from any view updates all | Passed: real three-view projection and completion plus task/project/Vault tests |
| A02 | Put one Project in two workbenches | Status synchronizes; removing one reference keeps the Project; filters remain independent | Passed: real `dashboard` and `Acceptanceprojectworkspace` panes synchronized status while retaining the Project |
| A03 | Rename/reorder same-named sections | Stable IDs retain config, collapse, scroll, and body association | Passed: lossless stable-ID tests and real rename/save/reload |
| A04 | Complete a board checklist from Calendar, then save layout | Completion remains after layout save/reload | Passed: completed source survived later layout writes and reload; merge tests passed |
| A05 | Checkboxes in fences/YAML/Source Text/Digest | Formal-task query excludes them; explicit ordinary-checklist filter can still expose ordinary lists | Passed: shared TS/Python fixtures and scanner/projection tests |
| A06 | Reminder before due and scheduled distinct from due | All values render and edit independently; reminder never overwrites due | Passed: real three-field editor write plus independent parser/write tests |
| A07 | Duplicate text, file rename, and line movement | Mutation finds the same anchored task or requests reread; never changes its twin | Passed: real rename/line-shift/twin task run and block-ID tests |
| A08 | Database edits or drags a Project/Source | Legal action is used; identity, pair, managed regions, and path contract remain valid | Passed: real typed Project status and denied Source edit/move; policy tests passed |
| A09 | Calendar creates task for a missing Daily | A valid Daily for the clicked date is created; no fallback to today or a board list | Passed: real `2031-04-05` Daily creation and service tests |
| A10 | Feed to study/wiki/reference with one Source in several Projects | One Source, independent idempotent uses, correct context, no inferred interest | Passed: Engine and Dashboard workflow integration tests |
| A11 | Finish a book/timer or generate Study Guide | `studied_at` is unchanged until explicit human confirmation | Passed: real timer run, Vault-wide check, and explicit completion tests |
| A12 | Convert sticky note to Capture with interruption/repeated click | Text is recoverable and idempotent; no long-lived duplicate body | Passed: real conversion/repeat retained one durable marker; failure tests passed |
| A13 | Close section or last workbench pane | Background work continues, notification occurs once, reopened UI shows real result | Passed: real last-pane Pomodoro completion/reopen plus lifecycle tests |
| A14 | Engine unavailable | Vault read/light edits work; import/generation reports the exact unavailable capability | Passed: real disconnected UI and continued Vault actions plus API tests |
| A15 | Claudian unavailable | Other workbench features work; AI action offers clear context/prompt fallback | Passed: real absent-Claudian fallback and bridge tests |
| A16 | Feed return, note update, or theme switch | Unrelated web/music/timer state survives; reading page and position survive | Passed: real theme cycle preserved exact Feed position and Pomodoro bytes; UI-state tests passed |
| A17 | Unknown field/section/free prose/newer board version | Data is retained and compatibility limit is visible; save never silently drops it | Passed: real schema-99 warning and repeated save preservation plus format tests |
| A18 | Re-run interrupted legacy Apex-data takeover | Original format remains, manual changes are not overwritten, no Vault notes are created, one writer remains | Passed: real disabled-legacy copy/rerun/conflict run plus takeover tests |
| A19 | Apply an upstream update | Native Apex and integrated OKF scenarios pass after a real subtree update exercise | Passed: isolated 2.5.4 → 3.6.0 subtree merge, 29 upstream scripts/lint/build, and 208 unified tests/check/build |

## Synthetic Vault scenarios

Automated integration fixtures will create only synthetic data and cover: two same-named sections with
unknown YAML/prose; two same-text tasks with different anchors; fenced and YAML block checkboxes; a missing
historical Daily; one Source with study/wiki/reference uses in two Projects; a managed Project and Source
opened through database/kanban views; a pending Engine operation observed across pane closure; and two
conflicting native-data directories for takeover recovery.

For each completed row, replace `Pending` with the test/fixture path and the recorded disposable-Vault run.
No status may be inferred from a nearby unit test that does not execute the complete scenario.

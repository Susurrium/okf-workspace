# Apex × OKF acceptance ledger

> **2026-09-21 functional-parity correction:** the original completion statement was too broad. The
> recorded data-safety and lifecycle scenarios remain valid, but the new Apex sections do not yet preserve
> the full reachable behavior of the former OKF Dashboard. The subsequent shared-Surface implementation
> restored M4–M6 and the desktop runtime portion of M8. M7 awaits one authenticated real-Feed rerun, and
> M9/P08 remain open. See `APEX-OKF-FUNCTIONAL-PARITY-IMPLEMENTATION-2026-09-21.md`.

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
| M4 | Full Project experience and managed-artifact edit policy | **Complete after parity repair:** shared Project Surface restores contextual Capture/import, Claudian, catalog, metrics and state-aware actions, while retaining formal tasks, dates and Decision creation; nonempty real Obsidian run passed |
| M5 | Unified task/calendar/Daily/Capture loop | **Complete after parity repair:** shared Today and Life Surfaces restore continuation, attention, Feed, reflection/review and global entry points; anchored task/date regression and nonempty real run passed |
| M6 | Learning/Knowledge/Inbox/Import sections and details | **Complete after parity repair:** registered Apex types mount the complete shared Surfaces; scope/context, operation states, filters, verification, decisions, recovery and Claudian paths are reachable; nonempty real run passed |
| M7 | Feed/Reading and default workbench presets | **Conditional:** complete Reading controller, presets, cache/scroll/request lifecycle and sync UI are mounted and automated tests pass; authenticated real-Feed rerun remains required |
| M8 | Native-data takeover, UX, capability, and performance work | **Complete for desktop implementation:** native takeover remains intact; eight shared Surfaces, Life/System access, custom-section cleanup and 9-to-9 rerender stability passed in real Obsidian |
| M9 | Full release, rollback, real Obsidian, and upstream-update exercise | **Reopened:** the recorded 19 scenarios and upstream exercise are valid but insufficient; release remains blocked until the functional-parity gate passes |

## Final acceptance matrix

The A01–A19 statuses below report only the named scenario. They are necessary regression evidence, not a
claim of complete Dashboard replacement. The following additional release gate is currently open:

| ID | Scenario | Required evidence | Status |
| --- | --- | --- | --- |
| P01 | Learning feature parity | Registered Apex section exposes the former scope, context, workflow states, recovery, Claudian, completion, and Wiki actions | **Passed:** 49 shared-Surface behavior tests plus nonempty Course/ready/pending/completed real run |
| P02 | Inbox/import feature parity | Registered Apex section exposes decisions, bulk handling, conversion progress, fallback, retry, cancel, and recovery | **Passed:** registered shared Surface, workflow tests and real Web Clip two-stage decision run |
| P03 | Knowledge feature parity | Registered Apex section exposes catalog, search, filters, verification, lifecycle badges, and operation states | **Passed:** registered shared Surface and real AI-unverified Wiki run |
| P04 | Project feature parity | Registered Apex section exposes contextual capture/import, Claudian, catalog, status-aware action, and precise related navigation | **Passed:** full action panel, formal task/date and nonempty real Project run |
| P05 | Today/Life feature parity | Registered Apex sections expose continuation, attention, Feed, reflection/review, calendar, and capture organization | **Passed:** nonempty Today task/continuation run and real Life navigation |
| P06 | System/global controls | Registered surface exposes diagnostics, task center, failed-operation recovery, settings, search, quick create, and Ask Notes | **Passed:** registered System Surface, embedded navigation and existing recovery tests |
| P07 | Reading controller parity | Registered Apex section passes full-load, pagination, cache, stale-response, scroll, refresh-failure, and sync scenarios | **Conditional:** all automated scenarios pass and real offline/401 behavior is correct; authenticated sync rerun pending |
| P08 | Reachable-surface acceptance | Nonempty real Obsidian run verifies every inventory action through the registered Apex surfaces | **Partial:** synthetic task-center walkthrough now covers queued, generating, publishing, failed, cancelled, conversion fallback, cancel/retry/continue actions; live Feed and real Obsidian walkthrough remain |

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

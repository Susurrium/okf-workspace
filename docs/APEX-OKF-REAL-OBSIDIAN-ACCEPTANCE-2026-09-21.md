# OKF Apex Workbench real-Obsidian acceptance

## Environment

Acceptance ran against an isolated disposable Vault, an isolated Obsidian profile, Obsidian 1.13.7, and
the production `dashboard/dist/` package. The profile had Engine autostart disabled and Claudian absent.
No production Vault was opened or modified. CDP automation used `scripts/obsidian-cdp.mjs`; assertions read
the real Obsidian DOM and Vault adapter results rather than a browser mock.

## Results

| ID | Result and recorded evidence |
| --- | --- |
| A01 | Passed. One anchored Project task appeared in Project, Today, and Calendar. Checking it in Today changed the source to `[x]`; Project and Today removed the completed projection while Calendar retained the completed event. |
| A02 | Passed. `Acceptance Project` appeared in `dashboard.md` and `Acceptanceprojectworkspace.md`. Pausing it removed it from both independently filtered panes; reactivating restored both, and the Project file remained. |
| A03 | Passed. Duplicate-name/stable-ID serialization tests passed; in the real app a section rename/save/reload retained IDs, schema, body association, and pane state. |
| A04 | Passed. After the task completion, later section rename/layout writes and plugin reload did not restore the unchecked source line. The three-way merge tests also passed. |
| A05 | Passed. The shared Python/TypeScript fixture excludes YAML, fenced code, Source, and Digest examples from formal-task projections while keeping the explicit ordinary-checklist mode. |
| A06 | Passed. The visible date editor changed reminder to `2026-09-22 09:30`, scheduled to `2026-09-24`, and due to `2026-09-26`; the task body and `^task-date-edit` identity remained unchanged. |
| A07 | Passed. A file containing two identical task texts was renamed and had a line inserted before both tasks. The real Today checkbox changed only `^task-dup-a`; `^task-dup-b` remained open. |
| A08 | Passed. Real Project status actions used the typed status service. Attempts to generically edit `uses` or move a Source returned `deny`; its bytes and path remained unchanged. |
| A09 | Passed. A Calendar-routed action for `2031-04-05` created `life/daily/2031/04/2031-04-05.md` with a formal anchored task. It did not fall back to the current date. |
| A10 | Passed. The integration test resolves one Feed item into one Source and independent idempotent uses in two Projects, without inferred `interest` or `long_term_value`. |
| A11 | Passed. Pomodoro completed after the last Dashboard pane closed, then reopened in its real state. A Vault-wide check found no nonempty `studied_at`; only explicit human completion writes it. |
| A12 | Passed. A real memo became one Capture with a durable `dashboard#card-mub95aov` marker and the source card disappeared only after success. Repeating conversion returned the same path with `created: false`; the marker count remained one. |
| A13 | Passed. Two panes shared services. A 0.02-minute Pomodoro completed with every Dashboard pane detached, the plugin stayed loaded, and reopening showed short-break state from `pomodoro.json`. |
| A14 | Passed. Reading displayed the exact Engine-unavailable state while Vault Project, task, Capture, and workbench edits continued. Import/generation remained explicitly unavailable. |
| A15 | Passed. With Claudian absent, the action copied prompt/mode/skill/context, opened the first context file, and showed the explicit fallback notice; other sections stayed usable. |
| A16 | Passed. Cycling the real theme from Island to Tundra preserved the exact Feed edition/item/timestamp and byte-identical Pomodoro state. |
| A17 | Passed. A board with `workbench_schema: 99`, unknown root YAML, and free prose displayed the compatibility warning. Two real section rename/flush writes retained the schema, unknown YAML, and prose. |
| A18 | Passed. With legacy Apex disabled, `weread-progress.json` copied byte-for-byte. After manually changing the target, plugin reload kept the target, left the source unchanged, and recorded `target-kept`. No Vault note was created. |
| A19 | Passed. A real 2.5.4 → 3.6.0 subtree update was resolved on `codex/apex-upstream-exercise`; 29 upstream scripts, upstream lint/build, and the unified 208-test/typecheck/build suite passed. See `docs/upstream/apex-update-exercise-2026-09-21.md`. |

The run also confirmed 22 unified plugin commands, one installed plugin identity, six default Daily preset
sections, three sidebar widgets, plugin reload, two simultaneous panes, and preservation of Apex native JSON.
The release stays desktop-only, so this run does not claim phone support.

## Synthetic Vault performance

Cold task projection was measured after restarting the isolated Obsidian profile with a non-task Project
workspace active, then switching to the Daily workspace. Every 100th synthetic note contained one formal
task scheduled for the test date; the remaining notes exercised the metadata-cache prefilter.

| Markdown notes | Projected tasks | Switch-to-render time | JavaScript heap delta |
| ---: | ---: | ---: | ---: |
| 1,000 | 10 | 614 ms | 7,005,941 bytes |
| 10,000 | 100 | 20,815 ms | 6,310,636 bytes |

Both runs completed without a frozen renderer, duplicate projection, or plugin reload. The 10k result is a
recorded desktop baseline rather than a release latency promise; future task-scanner changes should compare
against the same synthetic distribution and investigate material regressions.

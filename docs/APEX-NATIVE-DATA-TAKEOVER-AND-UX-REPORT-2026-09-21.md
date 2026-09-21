# Apex native data takeover and workbench UX report

Date: 2026-09-21

Unified plugin ID: `okf-workspace-dashboard`

Legacy Apex plugin ID: `apex-dashboard`

## Storage decision

Habit check-ins, expenses, Pomodoro sessions, manual book reading records, and WeRead progress remain Apex
native data. They are not converted into Vault notes and are not interpreted as OKF tasks, Sources, learning
completion, or `studied_at` evidence.

The unified plugin writes these files under its own Obsidian plugin data directory, with their original JSON
contents and schemas:

| File | Owner after takeover | Format change |
| --- | --- | --- |
| `habits.json` | Apex `HabitService` | None |
| `expense.json` | Apex `ExpenseService` | None |
| `pomodoro.json` | Apex `PomodoroService` | None |
| `reading.json` | Apex `ReadingService` | None |
| `weread-progress.json` | Apex `WereadProgressStore` | None |

The legacy `data.json` is read only when the unified settings do not yet contain an `apex` namespace. Its
known and future Apex settings are then normalized into that namespace and saved by the unified plugin. An
existing unified `apex` namespace always wins.

## Takeover algorithm

`dashboard/src/adapters/apex-native-data.ts` performs file-by-file takeover before any Apex native service is
created:

1. Read the source file without modifying it.
2. If the target exists, preserve it. Record `already-copied` for identical content or `target-kept` for a
   conflict.
3. If the target is absent, write the exact source text to a temporary file and read it back for verification.
4. Rename the verified temporary file to the target path.
5. Read the target back and verify it again.
6. Write `apex-native-data-takeover.json` in the unified plugin directory as a diagnostic receipt.

The operation is idempotent. A restart can reuse a matching temporary file. A mismatching temporary file is
discarded and rebuilt from the unchanged source. The process never deletes a legacy file and never overwrites
an existing target. After takeover, all unified services resolve paths from `manifest.id`; WeRead no longer
hard-codes the legacy directory.

## Lifecycle and state isolation

Habit, expense, music, Pomodoro, and manual reading services now have plugin lifetime in the unified host.
Closing one section or the last workbench pane only removes view subscriptions and DOM. A running timer and
music playback continue until the plugin unloads or the user stops them. Pomodoro completion notices originate
from the single shared service, so multiple panes do not duplicate notifications.

Timer UI uses per-widget tick subscriptions. Disconnected widgets unsubscribe themselves, while every open pane
continues to receive ticks. Floating Pomodoro and reading controls are created once by the host. Board renders
reuse the existing sidebar widget subtree when its signature is unchanged, so Feed updates, note changes, layout
edits, and theme changes do not recreate music, timers, or embedded web views.

The existing Apex local-storage keys and Electron partitions are intentionally stable compatibility identifiers.
Keeping them preserves device-local collapse state, floating-control positions, web sessions, TickTick sessions,
and NetEase login state across the plugin-ID change. Runtime plugin lookup now prefers the registered host;
`apex-dashboard` remains only a standalone fallback. Session migration cannot be guaranteed across Electron or
OS changes and remains a manual real-device acceptance item.

## Automated evidence

- `dashboard/tests/apex-native-data.test.ts`: byte-preserving copy, target conflict protection, interrupted
  takeover restart, idempotent rerun, legacy settings read, and unified WeRead path.
- Dashboard Vitest, TypeScript check, and production build.
- Apex lint, independent build, and native feature scripts.
- Existing board-format, pane-state, SyncEngine pool, Feed request-generation, music, mobile-stability, expense,
  WeRead, web-section, and calendar scripts cover the unchanged native capabilities.

## Real-device acceptance still required

- Open desktop Obsidian with a disposable legacy Apex plugin directory, run takeover twice, and compare all five
  source/target files byte-for-byte before making a new native record.
- Put different content at one target before the second run and confirm it is retained with a `target-kept`
  receipt.
- Start Pomodoro, reading, music, and a web session; close all workbench panes; reopen and confirm the shared
  runtime state.
- Repeat keyboard, focus, dark-theme, zoom, touch, and mobile layout checks on the devices claimed by the release.
- Disable the legacy plugin before production cutover so only the unified plugin remains an active writer.

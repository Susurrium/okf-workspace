# Claudian upstream and OKF adapter

| Field | Pinned value |
| --- | --- |
| Upstream | `https://github.com/YishenTu/claudian` |
| Imported release | `2.3.6` |
| Imported commit | `14a6abcc2f1628ad99122dbe6ad5f56033331ac3` |

The monorepo owns installation, npm lockfiles, builds and CI. `claudian-upstream` is
fetch-only; upstream Bun files, nested workflows and the separate Collab product are excluded.

## Adapter boundary

Claudian owns chat, sessions, authentication and provider runtimes. Workspace business rules
come from deployed Vault resources; the [architecture](../docs/architecture/README.md#claudian-接入)
defines ownership and context composition, and [interfaces](../docs/INTERFACES.md#bridge)
defines the public protocol and prompt modes.

OKF-specific code stays in `src/integrations/okf/`: `OkfBridge.ts` and `OkfPromptPolicy.ts`.
Production imports are confined to the main composition root, settings defaults/UI and
Codex `execution/CodexExecutionSession.ts`. Shared chat and core modules have no OKF imports.

| Adaptation | Required behavior |
| --- | --- |
| Handoff | Preserve task, relative attachments and action mode; show removable attachments; report unavailable Codex/model or target creation failures. |
| Codex runtime | Preserve Codex-owned CLI paths, environment, login, sessions and transcript bytes; keep Claude authentication separate. |
| Prompt policy | Persist mode/version with the native session; map action mode to its sandbox; change modes only for new sessions. |
| Windows files | Restore directory links as junctions and check existing ancestors when validating containment. |
| Tests and packaging | Keep npm authority, SDK history-path encoding, native lifecycle fixtures and bounded cleanup; preserve real hard-link/concurrency assertions, capability gates and valid file URLs. |
| Translations | Maintain prompt-mode strings in upstream locale files. |

## Updates

Pin the candidate commit, compare it with the imported baseline, preserve these boundaries,
and update source/tests together. Run the component rules, cross-component/root checks and
affected real Obsidian flows from the [development guide](../docs/DEVELOPMENT.md).
Record the accepted source, plugin/release metadata and tested/installed artifact hashes.
Updates are explicit. Earlier imports and per-file changes remain in Git history.

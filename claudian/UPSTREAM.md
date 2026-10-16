# Claudian upstream and OKF adapter

## Pinned source

| Field | Value |
| --- | --- |
| Upstream | `https://github.com/YishenTu/claudian` |
| Imported release | `2.3.6` |
| Imported commit | `14a6abcc2f1628ad99122dbe6ad5f56033331ac3` |
| Previous import | `2.1.4` / `40880cabec40d61766c84f2da9f403ed36016f08` |
| Import date | 2026-09-28; 243 upstream commits |

The monorepo owns installation, npm lockfiles, builds and CI. A fetch-only
`claudian-upstream` remote supports deliberate updates. Upstream `bun.lock`, nested
GitHub workflows and the separate Collab product are outside this fork.

## Ownership and bridge

Claudian owns chat UI, conversations, provider runtimes, native history, CLI
resolution and authentication. Workspace rules come from the deployed Vault's
`AGENTS.md`, `.agents/skills/` and `system/contracts/`.

OKF code is confined to `src/integrations/okf/`:

- `OkfBridge.ts` publishes the frozen `okfBridge v1`, validates Vault-relative
  attachments, composes Skill and prompt mentions, and targets Codex.
- `OkfPromptPolicy.ts` defines `okf-native`, `claudian-full` and `custom-replace`
  prompt modes. A mode change applies to new sessions.

Generic handoff and attachment handling stay under `src/features/chat/`, without
OKF imports. The public request, result, action modes and sending behavior are
defined in [Workspace interfaces](../docs/INTERFACES.md#bridge).

Only four production locations import the OKF adapter:

1. `src/main.ts`: constructs and exposes the bridge.
2. `src/app/settings/defaultSettings.ts`: selects the default prompt mode.
3. `src/features/settings/ClaudianSettings.ts`: renders its setting.
4. `src/providers/codex/execution/CodexExecutionSession.ts`: resolves the policy
   at native `thread/start`.

Architecture tests enforce this boundary. Dashboard uses the public bridge;
core, chat and other providers do not contain Workspace business policies.

## Local adaptations

| Area | Preserved behavior |
| --- | --- |
| Handoff | Keep prompt, Vault context paths and read/write/plan mode until the next turn; validate existing attachments and display removable chips. Disabled Codex, missing model or target creation failures are explicit. |
| Codex runtime | Use Codex-owned CLI paths, environment, login and `codex app-server`; keep authentication, sessions and transcripts separate from Claude. History hydration preserves transcript bytes. |
| Prompt modes | Persist mode/version with native session state and map action mode to the Codex sandbox. Business instructions remain in Vault resources. |
| Windows file safety | Restore directory links as junctions; resolve existing ancestors for containment checks on not-yet-created targets. |
| Tests and packaging | Use npm authority, SDK history-path encoding, native Windows lifecycle fixtures and bounded cleanup retries. Preserve real hard-link/concurrent-write assertions; gate only unavailable symlink capabilities and use valid file URLs. |
| Translations | Translate prompt-mode controls in the upstream locale structure. |

Exact file changes and formatting differences remain traceable against the pinned
upstream commit in Git. Repository-level environment and acceptance rules live in
the [development guide](../docs/DEVELOPMENT.md).

## Update procedure

1. Pin the candidate release and full commit, then compare with the imported base.
2. Update source and tests together, preserving the adapter boundary and generic
   handoff behavior above.
3. Run the checks required by `AGENTS.md`, including the bridge/prompt, Codex,
   architecture and relevant platform tests. Complete Dashboard, cross-component
   and root checks plus the affected real Obsidian scenarios.
4. Update this record, plugin identity/version metadata and the release manifest.
   Record tested and installed artifact hashes separately from source provenance.

Updates are explicit and are never pulled automatically.

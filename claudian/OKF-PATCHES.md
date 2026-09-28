# OKF integration inventory

The OKF customization is a narrow product adapter over Claudian. Claudian keeps
ownership of chat UI, conversations, provider runtimes, native history, CLI
resolution, and authentication. Workspace business rules remain in the Vault.

## Integration-owned code

All OKF-specific behavior is defined under `src/integrations/okf/`:

- `OkfBridge.ts` owns the public Dashboard contract, input normalization, skill
  mention composition, Vault-relative path validation, and the fixed Codex
  target.
- `OkfPromptPolicy.ts` owns the three OKF prompt modes and their versioned base
  instructions.

Generic chat handoff mechanics live in `src/features/chat/ExternalChatHandoff.ts`.
They are provider-neutral and do not know about OKF or Codex.

## Stable `okfBridge` v1

The plugin exposes one frozen object at `plugin.okfBridge`:

```ts
interface OkfBridgeV1 {
  version: 1;
  open(): Promise<void>;
  handoff(request: {
    prompt?: string;
    contextPaths?: readonly string[];
    actionMode?: 'read' | 'write' | 'plan';
    skill?: string;
    autoSend?: boolean;
    newSession?: boolean;
  }): Promise<{
    accepted: true;
    sent: boolean;
    contextCount: number;
    actionMode: 'read' | 'write' | 'plan';
    skill: string | null;
  }>;
}
```

Version 1 always targets the `codex` provider. If the active tab belongs to
Claude or another provider, the generic handoff layer creates a Codex draft
instead of mutating or sending through that tab. A disabled Codex provider,
missing Codex model catalog, invalid Vault path, or unavailable view fails with
an explicit error; there is no Claude fallback.

Changing the request or result shape requires a new bridge version. Additive
internal implementation changes that preserve the shape and semantics remain
version 1.

## Codex CLI and authentication boundary

- Codex CLI resolution reads only Codex-owned paths and Codex-scoped environment
  settings.
- Codex starts `codex app-server` and uses the Codex CLI's native login state.
- Claudian does not translate a Codex handoff into a Claude SDK request and does
  not require Claude authentication.
- Claude and Codex may both be configured, but their CLI paths, environment
  variables, sessions, transcripts, and authentication remain independent.

The architecture test enforces that `src/providers/codex/` does not import the
Claude provider or Anthropic SDK/authentication variables.

## Workspace authority

Learning, Wiki, Project, Daily, path, YAML, and write-boundary rules are loaded
from the deployed Vault's `AGENTS.md`, `.agents/skills`, and
`system/contracts`. Do not copy those rules into this plugin or expand the
minimal OKF base instructions into another Workspace policy.

## Deliberate upstream touch points

Only these Claudian locations may import the OKF adapter:

1. `src/main.ts` constructs and exposes `okfBridge`.
2. `src/app/settings/defaultSettings.ts` selects the OKF prompt default.
3. `src/features/settings/ClaudianSettings.ts` renders the prompt-mode setting.
4. `src/providers/codex/execution/CodexExecutionSession.ts` resolves the selected
   prompt policy at the native `thread/start` boundary.

`ClaudianView` exposes only the provider-neutral external handoff method. Core,
chat, and other provider code must not contain OKF-specific policy. The
architecture suite checks this list so upstream merges cannot silently spread
the integration.

## Upstream update procedure

After bringing in an upstream Claudian change:

1. Resolve changes without moving Workspace rules into upstream provider code.
2. Keep the four imports above as the complete adapter surface.
3. Run `npm run typecheck`, `npm run lint`, `npm run test:architecture`, the OKF
   bridge/prompt and Codex runtime tests, then `npm run build`.
4. Update this file only if the adapter boundary or bridge contract actually
   changes.

## Synced upstream base

The current vendored Claudian source is based on upstream
`14a6abcc2f1628ad99122dbe6ad5f56033331ac3` (2.3.6), replacing the former
`40880cabec40d61766c84f2da9f403ed36016f08` (2.1.4) import. Upstream-owned
source and tests follow the pinned snapshot, including provider runtime,
conversation/history, UI, and lifecycle changes. The local delta is accounted
for by this adapter inventory, plugin identity/version metadata, and the
monorepo build/dependency configuration described in `UPSTREAM.md`.

The adapter also uses generic chat handoff and composer attachment components
under `src/features/chat/`; these contain no OKF imports. `ClaudianView` adapts
the bridge request to those generic components and creates a Codex draft while
leaving other provider sessions untouched. Dashboard-side protocol behavior is
implemented and tested in `dashboard/src/plugin/claudian-bridge.ts`.

## Local source delta register

The following paths are the complete intentional source delta from the pinned
upstream snapshot. All other upstream `src/` and `tests/` files match the pinned
tree; vendoring and repository packaging files are accounted for by
`UPSTREAM.md`.

| Paths | Reason |
| --- | --- |
| `src/main.ts`; `src/integrations/okf/OkfBridge.ts`; `src/features/chat/ExternalChatHandoff.ts`; `tests/unit/integrations/okf/OkfBridge.test.ts`; `tests/unit/features/chat/ExternalChatHandoff.test.ts` | Publish bridge v1 and provider-neutral handoff. The bridge validates and deduplicates requests, composes Skill and prompt text, targets Codex, and reports the handoff result. |
| `src/app/settings/defaultSettings.ts`; `src/core/types/settings.ts`; `src/features/settings/ClaudianSettings.ts`; `src/providers/codex/types/index.ts`; `src/providers/codex/execution/CodexExecutionSession.ts`; `src/integrations/okf/OkfPromptPolicy.ts`; `tests/unit/integrations/okf/OkfPromptPolicy.test.ts`; `tests/unit/providers/codex/execution/CodexExecutionBackend.test.ts` | Persist the three prompt modes and resolve them for new Codex sessions. Keep prompt mode/version with native session state; apply action mode to the Codex sandbox. |
| `src/core/execution/ProviderExecutionRequest.ts`; `src/features/chat/state/types.ts`; `src/features/chat/tabs/types.ts`; `src/features/chat/controllers/InputController.ts`; `src/features/chat/tabs/runtime/TabRuntimeControllers.ts`; `src/features/chat/tabs/runtime/TabRuntimeUI.ts`; `src/features/chat/ClaudianView.ts`; `src/features/chat/ui/ComposerContextTray.ts`; `src/features/chat/composer/ExternalContextAttachments.ts`; `tests/unit/features/chat/composer/ExternalContextAttachments.test.ts` | Carry Vault context paths and read/write/plan mode from handoff to the next turn, validate existing Vault files, render removable attachment chips, and keep read/plan turns read-only. The new attachment and handoff mechanics are provider-neutral. |
| `src/i18n/locales/{de,en,es,fr,ja,ko,pt,ru,zh-CN,zh-TW}.json` | Translate the OKF prompt-mode controls while retaining the pinned upstream locale structure. |
| `src/providers/claude/runtime/ClaudeRewindService.ts` | Cross-platform correctness fix: restore Windows directory links as junctions so rewind rollback preserves the original Vault state. This is not OKF policy. |
| `tests/integration/build/build.test.ts`; `tests/integration/providers/claude/history/ClaudeTurnStats.test.ts`; `tests/unit/providers/claude/execution/ClaudeExecutionBackend.test.ts`; `tests/unit/providers/opencode/execution/OpencodeACPSessionKernel.test.ts`; `tests/unit/core/storage/VaultFileAdapter.test.ts` | Monorepo/platform test adaptations: use npm lockfiles, derive Claude history paths through the SDK encoder, use Windows junctions for directory-link fixtures, and capability-gate only file-symlink tests when the host denies symlink creation. |

OKF-specific production imports remain limited to the four locations listed
above. Generic turn request types and chat wiring carry opaque action/context
values without importing the OKF adapter or copying Workspace rules into
Claudian.

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

import type { ProviderId } from '../../core/providers/types';
import type {
  ExternalChatHandoffRequest,
  ExternalChatHandoffResult,
} from '../../features/chat/ExternalChatHandoff';
import type { ChatActionMode } from '../../features/chat/state/types';

export const OKF_BRIDGE_VERSION = 1 as const;

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface OkfHandoffRequestV1 {
  prompt?: string;
  contextPaths?: readonly string[];
  actionMode?: ChatActionMode;
  skill?: string;
  autoSend?: boolean;
  newSession?: boolean;
}

export interface OkfHandoffResultV1 {
  accepted: true;
  sent: boolean;
  contextCount: number;
  actionMode: ChatActionMode;
  skill: string | null;
}

export interface OkfBridgeV1 {
  readonly version: typeof OKF_BRIDGE_VERSION;
  open(): Promise<void>;
  handoff(request: OkfHandoffRequestV1): Promise<OkfHandoffResultV1>;
}

interface NormalizedOkfHandoffV1 {
  prompt: string;
  contextPaths: string[];
  actionMode: ChatActionMode;
  skill: string | null;
  autoSend: boolean;
  newSession: boolean;
}

export interface OkfBridgeHost {
  openProvider(providerId: ProviderId): Promise<void>;
  handoff(request: ExternalChatHandoffRequest): Promise<ExternalChatHandoffResult>;
}

/**
 * Creates the stable Dashboard-facing OKF bridge.
 *
 * The adapter deliberately targets Codex. It never falls back to the active
 * provider, so a Claude tab or missing Claude authentication cannot capture an
 * OKF handoff.
 */
export function createOkfBridge(host: OkfBridgeHost): OkfBridgeV1 {
  return Object.freeze({
    version: OKF_BRIDGE_VERSION,
    open: async (): Promise<void> => host.openProvider('codex'),
    handoff: async (request: OkfHandoffRequestV1): Promise<OkfHandoffResultV1> => {
      const handoff = normalizeOkfHandoff(request);
      const result = await host.handoff({
        providerId: 'codex',
        composerText: buildOkfComposerText(handoff),
        contextPaths: handoff.contextPaths,
        actionMode: handoff.actionMode,
        autoSend: handoff.autoSend,
        newSession: handoff.newSession,
      });
      return {
        accepted: true,
        sent: result.sent,
        contextCount: result.contextCount,
        actionMode: result.actionMode,
        skill: handoff.skill,
      };
    },
  });
}

export function normalizeOkfHandoff(
  request: OkfHandoffRequestV1,
): NormalizedOkfHandoffV1 {
  const skill = request.skill?.trim() || null;
  if (skill && !SKILL_NAME_PATTERN.test(skill)) {
    throw new Error('Invalid OKF skill name.');
  }

  const contextPaths = [...new Set((request.contextPaths ?? []).map(normalizeVaultPath))];
  return {
    prompt: request.prompt?.trim() ?? '',
    contextPaths,
    actionMode: request.actionMode ?? 'read',
    skill,
    autoSend: request.autoSend === true,
    newSession: request.newSession !== false,
  };
}

function buildOkfComposerText(handoff: NormalizedOkfHandoffV1): string {
  const skillMention = handoff.skill ? `$${handoff.skill}` : '';
  return [skillMention, handoff.prompt].filter(Boolean).join('\n\n');
}

function normalizeVaultPath(value: string): string {
  const path = value.replaceAll('\\', '/').replace(/^\.\//u, '').trim();
  if (
    !path
    || path.startsWith('/')
    || /^[a-z]:/iu.test(path)
    || path.split('/').includes('..')
  ) {
    throw new Error(`Invalid Vault context path: ${value}`);
  }
  return path;
}

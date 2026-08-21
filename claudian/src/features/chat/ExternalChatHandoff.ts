import type { ProviderId } from '../../core/providers/types';
import type { ChatActionMode } from './state/types';

export interface ExternalChatHandoffRequest {
  readonly providerId: ProviderId;
  readonly composerText: string;
  readonly contextPaths: readonly string[];
  readonly actionMode: ChatActionMode;
  readonly autoSend: boolean;
  readonly newSession: boolean;
}

export interface ExternalChatHandoffResult {
  accepted: true;
  sent: boolean;
  contextCount: number;
  actionMode: ChatActionMode;
}

export interface ExternalChatHandoffTarget {
  readonly providerId: ProviderId;
  setAttachedFiles(paths: readonly string[]): void;
  setActionMode(mode: ChatActionMode): void;
  setComposerText(text: string): void;
  focusComposer(): void;
  sendComposer(): Promise<void>;
}

export interface ExternalChatHandoffHost {
  getActiveTarget(): ExternalChatHandoffTarget | null;
  createTarget(providerId: ProviderId): Promise<ExternalChatHandoffTarget | null>;
}

/**
 * Applies one provider-targeted handoff without allowing the active tab to
 * silently change provider ownership.
 */
export async function applyExternalChatHandoff(
  host: ExternalChatHandoffHost,
  request: ExternalChatHandoffRequest,
): Promise<ExternalChatHandoffResult> {
  const activeTarget = host.getActiveTarget();
  const target = !request.newSession && activeTarget?.providerId === request.providerId
    ? activeTarget
    : await host.createTarget(request.providerId);

  if (!target) {
    throw new Error(`Could not create a ${request.providerId} chat target.`);
  }
  if (target.providerId !== request.providerId) {
    throw new Error(
      `External handoff provider mismatch: expected ${request.providerId}, got ${target.providerId}.`,
    );
  }

  target.setAttachedFiles(request.contextPaths);
  target.setActionMode(request.actionMode);
  if (request.composerText) {
    target.setComposerText(request.composerText);
  }
  target.focusComposer();

  const shouldSend = request.autoSend && request.composerText.length > 0;
  if (shouldSend) {
    await target.sendComposer();
  }

  return {
    accepted: true,
    sent: shouldSend,
    contextCount: request.contextPaths.length,
    actionMode: request.actionMode,
  };
}

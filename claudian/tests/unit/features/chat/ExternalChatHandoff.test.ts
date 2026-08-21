import {
  applyExternalChatHandoff,
  type ExternalChatHandoffHost,
  type ExternalChatHandoffTarget,
} from '@/features/chat/ExternalChatHandoff';

describe('applyExternalChatHandoff', () => {
  function createTarget(providerId: string): jest.Mocked<ExternalChatHandoffTarget> {
    return {
      providerId,
      setAttachedFiles: jest.fn(),
      setActionMode: jest.fn(),
      setComposerText: jest.fn(),
      focusComposer: jest.fn(),
      sendComposer: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('creates the requested provider target instead of using an active provider of another type', async () => {
    const activeClaude = createTarget('claude');
    const codex = createTarget('codex');
    const host: jest.Mocked<ExternalChatHandoffHost> = {
      getActiveTarget: jest.fn(() => activeClaude),
      createTarget: jest.fn().mockResolvedValue(codex),
    };

    const result = await applyExternalChatHandoff(host, {
      providerId: 'codex',
      composerText: 'read this note',
      contextPaths: ['knowledge/wiki/topic.md'],
      actionMode: 'read',
      autoSend: false,
      newSession: false,
    });

    expect(host.createTarget).toHaveBeenCalledWith('codex');
    expect(activeClaude.setAttachedFiles).not.toHaveBeenCalled();
    expect(activeClaude.setComposerText).not.toHaveBeenCalled();
    expect(codex.setAttachedFiles).toHaveBeenCalledWith(['knowledge/wiki/topic.md']);
    expect(codex.setComposerText).toHaveBeenCalledWith('read this note');
    expect(result.sent).toBe(false);
  });

  it('reuses a matching provider and sends only when requested with non-empty text', async () => {
    const codex = createTarget('codex');
    const host: jest.Mocked<ExternalChatHandoffHost> = {
      getActiveTarget: jest.fn(() => codex),
      createTarget: jest.fn(),
    };

    const result = await applyExternalChatHandoff(host, {
      providerId: 'codex',
      composerText: '$retrieve-vault-context\n\nanswer this',
      contextPaths: [],
      actionMode: 'read',
      autoSend: true,
      newSession: false,
    });

    expect(host.createTarget).not.toHaveBeenCalled();
    expect(codex.sendComposer).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(true);
  });

  it('fails before mutating a target returned for the wrong provider', async () => {
    const claude = createTarget('claude');
    const host: jest.Mocked<ExternalChatHandoffHost> = {
      getActiveTarget: jest.fn(() => null),
      createTarget: jest.fn().mockResolvedValue(claude),
    };

    await expect(applyExternalChatHandoff(host, {
      providerId: 'codex',
      composerText: 'task',
      contextPaths: [],
      actionMode: 'write',
      autoSend: true,
      newSession: true,
    })).rejects.toThrow('expected codex, got claude');

    expect(claude.setComposerText).not.toHaveBeenCalled();
    expect(claude.sendComposer).not.toHaveBeenCalled();
  });
});

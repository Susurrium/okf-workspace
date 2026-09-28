import { applyExternalChatHandoff } from '@/features/chat/ExternalChatHandoff';
import {
  createOkfBridge,
  OKF_BRIDGE_VERSION,
  type OkfBridgeHost,
} from '@/integrations/okf/OkfBridge';

describe('OKF bridge v1', () => {
  function createHost(): jest.Mocked<OkfBridgeHost> {
    return {
      openProvider: jest.fn().mockResolvedValue(undefined),
      handoff: jest.fn().mockImplementation(async request => ({
        accepted: true,
        sent: request.autoSend && request.composerText.length > 0,
        contextCount: request.contextPaths.length,
        actionMode: request.actionMode,
      })),
    };
  }

  it('exposes a stable versioned contract and delegates opening', async () => {
    const host = createHost();
    const bridge = createOkfBridge(host);

    expect(bridge.version).toBe(OKF_BRIDGE_VERSION);
    expect(bridge.version).toBe(1);

    await bridge.open();

    expect(host.openProvider).toHaveBeenCalledWith('codex');
  });

  it('normalizes a Dashboard handoff and always targets Codex', async () => {
    const host = createHost();
    const bridge = createOkfBridge(host);

    const result = await bridge.handoff({
      prompt: '  整理这份学习材料  ',
      contextPaths: ['learning/topic.md', '.\\learning\\topic.md'],
      actionMode: 'write',
      skill: 'prepare-study-guide',
    });

    expect(host.handoff).toHaveBeenCalledWith({
      providerId: 'codex',
      composerText: '$prepare-study-guide\n\n整理这份学习材料',
      contextPaths: ['learning/topic.md'],
      actionMode: 'write',
      autoSend: false,
      newSession: true,
    });
    expect(result).toEqual({
      accepted: true,
      sent: false,
      contextCount: 1,
      actionMode: 'write',
      skill: 'prepare-study-guide',
    });
  });

  it('returns counts and mode matching the actual Codex draft it creates', async () => {
    const target = {
      providerId: 'codex',
      setAttachedFiles: jest.fn(),
      setActionMode: jest.fn(),
      setComposerText: jest.fn(),
      focusComposer: jest.fn(),
      sendComposer: jest.fn().mockResolvedValue(undefined),
    };
    const host: OkfBridgeHost = {
      openProvider: jest.fn().mockResolvedValue(undefined),
      handoff: request => applyExternalChatHandoff({
        getActiveTarget: () => null,
        createTarget: async providerId => providerId === 'codex' ? target : null,
      }, request),
    };
    const bridge = createOkfBridge(host);

    const result = await bridge.handoff({
      prompt: 'Review the source',
      contextPaths: ['sources/example.md', '.\\sources\\example.md'],
      actionMode: 'read',
      skill: 'source-review',
      autoSend: false,
      newSession: true,
    });

    expect(target.setComposerText).toHaveBeenCalledWith('$source-review\n\nReview the source');
    expect(target.setAttachedFiles).toHaveBeenCalledWith(['sources/example.md']);
    expect(target.setActionMode).toHaveBeenCalledWith('read');
    expect(target.sendComposer).not.toHaveBeenCalled();
    expect(result).toEqual({
      accepted: true,
      sent: false,
      contextCount: target.setAttachedFiles.mock.calls[0][0].length,
      actionMode: target.setActionMode.mock.calls[0][0],
      skill: 'source-review',
    });
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])('preserves autoSend=%s and newSession=%s', async (autoSend, newSession) => {
    const host = createHost();
    const bridge = createOkfBridge(host);

    const result = await bridge.handoff({
      prompt: 'Review this source',
      contextPaths: ['sources/example.md'],
      actionMode: 'read',
      autoSend,
      newSession,
    });

    expect(host.handoff).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      contextPaths: ['sources/example.md'],
      autoSend,
      newSession,
    }));
    expect(result.sent).toBe(autoSend);
    expect(result.contextCount).toBe(1);
  });

  it('rejects unknown action modes before handing off', async () => {
    const host = createHost();
    const bridge = createOkfBridge(host);

    await expect(bridge.handoff({ actionMode: 'delete' as never })).rejects.toThrow(
      'Invalid OKF action mode',
    );
    expect(host.handoff).not.toHaveBeenCalled();
  });

  it.each(['../secret.md', 'C:\\secret.md', '/secret.md'])(
    'rejects context outside the Vault: %s',
    async (path) => {
      const host = createHost();
      const bridge = createOkfBridge(host);

      await expect(bridge.handoff({ contextPaths: [path] })).rejects.toThrow(
        'Invalid Vault context path',
      );
      expect(host.handoff).not.toHaveBeenCalled();
    },
  );

  it('rejects empty context paths instead of accepting an unresolvable attachment', async () => {
    const host = createHost();
    const bridge = createOkfBridge(host);

    await expect(bridge.handoff({ contextPaths: ['  '] })).rejects.toThrow(
      'Invalid Vault context path',
    );
    expect(host.handoff).not.toHaveBeenCalled();
  });
});

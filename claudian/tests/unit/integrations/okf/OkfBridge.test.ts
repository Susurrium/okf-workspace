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
});

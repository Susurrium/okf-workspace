import { ExternalContextAttachments } from '@/features/chat/composer/ExternalContextAttachments';
import type { ComposerContextTray } from '@/features/chat/ui/ComposerContextTray';

describe('ExternalContextAttachments', () => {
  it('deduplicates paths and exposes one removable tray item per path', () => {
    const setItems = jest.fn();
    const tray = { setItems, clearItems: jest.fn() } as unknown as ComposerContextTray;
    const attachments = new ExternalContextAttachments(tray);

    attachments.setPaths(['Wiki/Alpha.md', 'Wiki/Beta.md', 'Wiki/Alpha.md']);

    expect(attachments.getPaths()).toEqual(['Wiki/Alpha.md', 'Wiki/Beta.md']);
    const [slot, chips] = setItems.mock.calls.at(-1) ?? [];
    expect(slot).toBe('external-context');
    expect(chips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'Wiki/Alpha.md',
        label: 'Alpha.md',
        ariaLabel: 'Wiki/Alpha.md',
        onRemove: expect.any(Function),
      }),
      expect.objectContaining({
        id: 'Wiki/Beta.md',
        label: 'Beta.md',
        ariaLabel: 'Wiki/Beta.md',
        onRemove: expect.any(Function),
      }),
    ]));

    chips[0].onRemove?.();
    expect(attachments.getPaths()).toEqual(['Wiki/Beta.md']);

    attachments.destroy();
    expect(tray.clearItems).toHaveBeenCalledWith('external-context');
  });
});

/** @jest-environment jsdom */

import { testDate } from '@test/helpers/testClock';
import { waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { MarkdownRenderer } from 'obsidian';

import type { ChatMessage } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

it('keeps the full transcript readable while batching historical Markdown and cancelling stale work', async () => {
  const host = document.body.createDiv();
  const renderer = new MessageRenderer(
    { app: {}, settings: { mediaFolder: '' } } as any,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any,
    host,
  );
  const messages: ChatMessage[] = Array.from({ length: 120 }, (_, index) => ({
    id: `history-${index}`, role: 'user', content: `Historical note ${index}`,
    timestamp: testDate().getTime(),
  }));
  let renderedBlocks = 0;
  let scrollTop = 0;
  // jsdom supplies no layout; this port models height changes from Obsidian Markdown.
  Object.defineProperties(host, {
    clientHeight: { value: 100 },
    scrollHeight: { get: () => 500 + renderedBlocks * 20 },
    scrollTop: { get: () => scrollTop, set: value => { scrollTop = Math.min(value, host.scrollHeight - host.clientHeight); } },
  });
  jest.mocked(MarkdownRenderer.render).mockImplementation(async (_app, markdown, target) => {
    (target as HTMLElement).textContent = markdown;
    renderedBlocks++;
  });
  jest.mocked(MarkdownRenderer.render).mockClear();
  try {
    renderer.renderMessages(messages, () => 'Welcome');
    expect(within(host).getByText('Historical note 0')).toBeDefined();
    expect(within(host).getByText('Historical note 119')).toBeDefined();
    expect(jest.mocked(MarkdownRenderer.render).mock.calls.length).toBeLessThan(120);
    await waitFor(() => expect(jest.mocked(MarkdownRenderer.render)).toHaveBeenCalledTimes(120));
    await waitFor(() => expect(host.scrollTop).toBe(host.scrollHeight - host.clientHeight));
    expect((await axe(host)).violations).toEqual([]);
    renderedBlocks = 0;
    renderer.renderMessages(messages, () => 'Welcome');
    host.scrollTop = 0;
    host.dispatchEvent(new Event('scroll'));
    await waitFor(() => expect(renderedBlocks).toBe(120));
    expect(host.scrollTop).toBe(0);
    jest.mocked(MarkdownRenderer.render).mockClear();
    renderer.renderMessages(messages, () => 'Welcome');
    renderer.renderMessages([{ ...messages[0], id: 'current', content: 'Current conversation' }], () => 'Welcome');
    await new Promise(resolve => window.setTimeout(resolve, 30));
    expect(jest.mocked(MarkdownRenderer.render)).toHaveBeenCalledTimes(1);
    expect(within(host).getByText('Current conversation')).toBeDefined();
    expect(within(host).queryByText('Historical note 119')).toBeNull();
  } finally {
    renderer.dispose();
    host.remove();
  }
});

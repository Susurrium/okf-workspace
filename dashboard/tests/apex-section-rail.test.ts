import { afterEach, expect, it, vi } from 'vitest';
import { El, findByClass } from '../apex/scripts/mini-dom.js';
import { mountSectionRail } from '../apex/src/section-rail.js';
import { startGuardedDrag } from '../apex/src/drag-guard.js';

afterEach(() => { vi.useRealTimers(); });

it('同名分区通过稳定 ID 定位，局部替换后重新查找，退出取消监听', () => {
  vi.useFakeTimers();
  const win = new EventTarget();
  Object.assign(win, {
    getComputedStyle: () => ({ overflowY: 'auto' }), matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 1), cancelAnimationFrame: clearTimeout,
  });
  const root = new El('div');
  Object.defineProperty(root, 'ownerDocument', { value: { defaultView: win, activeElement: null } });
  Object.assign(root, { scrollHeight: 1200, clientHeight: 300, scrollBy: vi.fn() });
  root.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 });
  const makeRow = (id: string, top: number) => {
    const row = root.createDiv({ cls: 'dashboard-section-row' });
    row.dataset.column = id;
    row.getBoundingClientRect = () => ({ top, bottom: top + 250, left: 0, right: 700, width: 700, height: 250 });
    return row;
  };
  makeRow('one', 0);
  const second = makeRow('two', 600);
  const dispose = mountSectionRail(root as unknown as HTMLElement, [{ id: 'one', name: '同名' }, { id: 'two', name: '同名' }]);
  const buttons = findByClass(root, 'dashboard-section-rail-item');
  buttons[1]!.click();
  expect((root as unknown as { scrollBy: ReturnType<typeof vi.fn> }).scrollBy).toHaveBeenLastCalledWith({ top: 588, behavior: 'smooth' });
  second.remove();
  makeRow('two', 900);
  buttons[1]!.click();
  expect((root as unknown as { scrollBy: ReturnType<typeof vi.fn> }).scrollBy).toHaveBeenLastCalledWith({ top: 888, behavior: 'smooth' });
  root.dispatchEvent({ type: 'scroll' });
  expect(vi.getTimerCount()).toBe(1);
  dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(findByClass(root, 'dashboard-section-rail')).toHaveLength(0);
  root.dispatchEvent({ type: 'scroll' });
  expect(vi.getTimerCount()).toBe(0);
});

it('拖动失焦执行取消清理，不提交尺寸且可再次开始', () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { body: new El('body'), defaultView: win });
  const onCancel = vi.fn();
  const onMove = vi.fn();
  const onUp = vi.fn();
  const event = { pointerId: 7, view: { document: doc }, preventDefault() {}, stopPropagation() {} } as unknown as PointerEvent;
  startGuardedDrag(event, { onMove, onUp, onCancel });
  const shield = findByClass(doc.body, 'dashboard-drag-shield')[0]!;
  shield.dispatchEvent({ type: 'pointermove', pointerId: 8 });
  expect(onMove).not.toHaveBeenCalled();
  shield.dispatchEvent({ type: 'pointermove', pointerId: 7 });
  expect(onMove).toHaveBeenCalledTimes(1);
  win.dispatchEvent(new Event('blur'));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onUp).not.toHaveBeenCalled();
  expect(doc.body.children).toHaveLength(0);
  startGuardedDrag(event, { onMove, onUp, onCancel });
  findByClass(doc.body, 'dashboard-drag-shield')[0]!.dispatchEvent({ type: 'pointerup', pointerId: 7 });
  expect(onUp).toHaveBeenCalledOnce();
  expect(doc.body.children).toHaveLength(0);
});

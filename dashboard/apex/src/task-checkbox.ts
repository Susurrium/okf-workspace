export function renderTaskCheckbox(parent: HTMLElement, options: {
  text: string;
  checked: boolean;
  className?: string;
  notifyConflict?: boolean;
  toggle(checked: boolean): Promise<boolean | void>;
  notify(message: string): void;
}): HTMLInputElement {
  const checkbox = parent.createEl('input', { cls: options.className,
    attr: { type: 'checkbox', 'aria-label': `完成 ${options.text}` } });
  checkbox.checked = options.checked;
  checkbox.addEventListener('change', () => {
    if (checkbox.disabled) return;
    const next = checkbox.checked;
    checkbox.disabled = true;
    void options.toggle(next).then((wrote) => {
      if (wrote === false) { checkbox.checked = options.checked;
        if (options.notifyConflict !== false) options.notify('任务已变化，请刷新后重试。'); }
    }).catch((error: unknown) => {
      checkbox.checked = options.checked;
      options.notify(error instanceof Error ? error.message : '任务更新失败');
    }).finally(() => { checkbox.disabled = false; });
  });
  return checkbox;
}

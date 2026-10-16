export async function runUiAction(button: HTMLButtonElement, action: () => Promise<unknown>,
  notify: (message: string) => void, success?: string): Promise<void> {
  if (button.disabled) return;
  const label = button.textContent ?? "";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "正在处理…";
  try {
    await action();
    if (success) notify(success);
  } catch (error) {
    notify(error instanceof Error ? error.message : "操作失败");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
  }
}

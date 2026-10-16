export type MaterialChoice = "learn-now" | "learn-later" | "wiki-now" | "source-only" | "ignore";

export function renderMaterialDecision(controls: HTMLElement, status: HTMLElement, options: {
  choose(action: MaterialChoice, button: HTMLButtonElement): void;
  yesLabel?: string;
  noLabel?: string;
}): void {
  const button = (label: string, click: (button: HTMLButtonElement) => void): void => {
    const item = controls.createEl("button", { text: label, attr: { type: "button" } });
    item.addEventListener("click", () => click(item));
  };
  const learning = (): void => {
    controls.replaceChildren();
    status.setText("现在生成辅助学习材料，或保存用途后稍后学习。");
    button("现在生成辅助学习材料", item => options.choose("learn-now", item));
    button("稍后学习", item => options.choose("learn-later", item));
    button("返回", primary);
  };
  const reference = (): void => {
    controls.replaceChildren();
    status.setText("不准备学习时，再判断它是否值得长期保留。");
    button("整理为知识笔记", item => options.choose("wiki-now", item));
    button("只保存资料", item => options.choose("source-only", item));
    button("不保留", item => options.choose("ignore", item));
    button("返回", primary);
  };
  function primary(): void {
    controls.replaceChildren();
    status.setText("先判断是否想学习；暂时不处理时直接离开即可。");
    button(options.yesLabel ?? "想学习", learning);
    button(options.noLabel ?? "不打算学习", reference);
  }
  primary();
}

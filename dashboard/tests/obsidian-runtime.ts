import { StateField } from "@codemirror/state";

export const editorInfoField = StateField.define<{ file: TFile | null }>({
  create: () => ({ file: null }), update: (value) => value,
});
export const editorLivePreviewField = StateField.define<boolean>({ create: () => true, update: (value) => value });

export class TFile {
  public readonly name: string;
  public readonly basename: string;

  public constructor(public readonly path: string) {
    this.name = path.split("/").at(-1) ?? path;
    this.basename = this.name.replace(/\.[^.]+$/u, "");
  }
}

export class WorkspaceLeaf {
  public constructor(public readonly app: unknown = {}) {}
}

interface TestElementOptions {
  text?: string;
  cls?: string;
  attr?: Record<string, string>;
}

export class TestElement {
  public readonly children: TestElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly classes = new Set<string>();
  public readonly listeners = new Map<string, ((event: Event) => void)[]>();
  public readonly dataset: Record<string, string> = {};
  public parentElement: TestElement | null = null;
  public textContent = "";
  public value = "";
  public selectionStart: number | null = 0;
  public selectionEnd: number | null = 0;
  public focusCount = 0;
  public rows = 0;
  public disabled = false;
  public scrollTop = 0;
  public isConnected = true;

  public constructor(public readonly tagName = "div", options: TestElementOptions = {}) {
    this.textContent = options.text ?? "";
    for (const name of options.cls?.split(/\s+/u).filter(Boolean) ?? []) this.classes.add(name);
    for (const [name, value] of Object.entries(options.attr ?? {})) this.setAttr(name, value);
  }

  public createEl(tagName: string, options: TestElementOptions = {}): TestElement {
    const child = new TestElement(tagName, options);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  public createDiv(options: TestElementOptions = {}): TestElement {
    return this.createEl("div", options);
  }

  public createSpan(options: TestElementOptions = {}): TestElement {
    return this.createEl("span", options);
  }

  public addClass(...names: string[]): void {
    for (const name of names) this.classes.add(name);
  }

  public removeClass(name: string): void { this.classes.delete(name); }
  public hasClass(name: string): boolean { return this.classes.has(name); }
  public toggleClass(name: string, enabled: boolean): void {
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
  }

  public setAttr(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith("data-")) this.dataset[dataAttributeKey(name)] = value;
  }
  public removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name.startsWith("data-")) delete this.dataset[dataAttributeKey(name)];
  }
  public setText(value: string): void { this.textContent = value; }
  public setAttribute(name: string, value: string): void { this.setAttr(name, value); }
  public replaceChildren(): void { this.empty(); }
  public empty(): void { this.children.length = 0; this.textContent = ""; }
  public remove(): void {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
    }
    this.parentElement = null;
    this.isConnected = false;
  }

  public addEventListener(type: string, callback: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, callback: (event: Event) => void): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    this.listeners.set(type, listeners.filter((candidate) => candidate !== callback));
  }

  public dispatch(type: string, event: Partial<Event> = {}): void {
    for (const callback of this.listeners.get(type) ?? []) callback(event as Event);
  }

  public click(): void {
    this.dispatch("click");
  }

  public focus(): void { this.focusCount += 1; }

  public setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  public descendants(className?: string): TestElement[] {
    const nested = this.children.flatMap((child) => [child, ...child.descendants()]);
    return className ? nested.filter((child) => child.classes.has(className)) : nested;
  }

  public querySelectorAll(selector: string): TestElement[] {
    const classes = [...selector.matchAll(/\.([a-z0-9_-]+)/giu)].map((match) => match[1]!);
    const data = /\[data-([a-z0-9_-]+)="([^"]*)"\]/iu.exec(selector);
    return this.descendants().filter((child) =>
      classes.every((className) => child.classes.has(className)) &&
      (!data || child.dataset[dataAttributeKey(`data-${data[1]}`)] === data[2]));
  }

  public closest(selector: string): TestElement | null {
    const className = /^\.([a-z0-9_-]+)$/iu.exec(selector)?.[1];
    let current: TestElement | null = this;
    while (current) {
      if (className && current.classes.has(className)) return current;
      current = current.parentElement;
    }
    return null;
  }
}

function dataAttributeKey(name: string): string {
  return name.slice(5).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

export class ItemView {
  public static constructorCount = 0;
  public readonly app: unknown;
  public readonly contentEl = new TestElement() as unknown as HTMLElement;

  public constructor(leaf: WorkspaceLeaf) {
    ItemView.constructorCount += 1;
    this.app = leaf.app;
  }
}

export class Notice {
  public static readonly messages: string[] = [];
  public readonly noticeEl = {} as HTMLElement;

  public constructor(message = "", _timeout = 0) {
    if (message) Notice.messages.push(message);
  }

  public hide(): void {}
}

export class Modal {
  public readonly modalEl = new TestElement();
  public readonly titleEl = new TestElement();
  public readonly contentEl = new TestElement();

  public constructor(public readonly app: unknown) {}

  public open(): void { (this as { onOpen?: () => void }).onOpen?.(); }
  public close(): void { (this as { onClose?: () => void }).onClose?.(); }
}

class TextAreaComponent {
  public readonly inputEl = new TestElement("textarea") as unknown as HTMLTextAreaElement;

  public setPlaceholder(value: string): this {
    this.inputEl.setAttribute?.("placeholder", value);
    return this;
  }

  public onChange(callback: (value: string) => void): this {
    (this.inputEl as unknown as TestElement).addEventListener("input", () => callback(this.inputEl.value));
    return this;
  }
}

export class Setting {
  public readonly settingEl: TestElement;

  public constructor(container: HTMLElement) {
    this.settingEl = (container as unknown as TestElement).createDiv();
  }

  public setName(_value: string): this { return this; }
  public setDesc(_value: string): this { return this; }

  public addTextArea(builder: (component: TextAreaComponent) => void): this {
    const component = new TextAreaComponent();
    this.settingEl.children.push(component.inputEl as unknown as TestElement);
    builder(component);
    return this;
  }
}

class MenuItem {
  public title = "";
  public setTitle(title: string): this { this.title = title; return this; }
  public setIcon(_icon: string): this { return this; }
  public onClick(_callback: () => void): this { return this; }
}

export class Menu {
  public static lastShownTitles: string[] = [];
  private readonly items: MenuItem[] = [];

  public addItem(builder: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    builder(item);
    this.items.push(item);
    return this;
  }

  public addSeparator(): this { return this; }
  public showAtMouseEvent(_event: MouseEvent): void {
    Menu.lastShownTitles = this.items.map((item) => item.title);
  }
}

export function parseYaml(source: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  let uses: Record<string, string | null>[] | undefined;
  let currentUse: Record<string, string | null> | undefined;
  const clean = (value: string): string => value.trim().replace(/^['"]|['"]$/gu, "");
  for (const line of source.split(/\r?\n/u)) {
    if (/^uses:\s*$/u.test(line)) {
      uses = [];
      parsed.uses = uses;
      currentUse = undefined;
      continue;
    }
    const useStart = /^\s+-\s+purpose:\s*(.*?)\s*$/u.exec(line);
    if (uses && useStart?.[1] !== undefined) {
      currentUse = { purpose: clean(useStart[1]) };
      uses.push(currentUse);
      continue;
    }
    const useField = /^\s+(course|project):\s*(.*?)\s*$/u.exec(line);
    if (currentUse && useField?.[1] && useField[2] !== undefined) {
      currentUse[useField[1]] = clean(useField[2]) || null;
      continue;
    }
    const match = /^([^\s:#][^:#]*):\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      parsed[match[1].trim()] = clean(match[2]);
      currentUse = undefined;
    }
  }
  return parsed;
}

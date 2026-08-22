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
  public textContent = "";
  public disabled = false;
  public scrollTop = 0;
  public isConnected = true;

  public constructor(public readonly tagName = "div", options: TestElementOptions = {}) {
    this.textContent = options.text ?? "";
    for (const name of options.cls?.split(/\s+/u).filter(Boolean) ?? []) this.classes.add(name);
    for (const [name, value] of Object.entries(options.attr ?? {})) this.attributes.set(name, value);
  }

  public createEl(tagName: string, options: TestElementOptions = {}): TestElement {
    const child = new TestElement(tagName, options);
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

  public setAttr(name: string, value: string): void { this.attributes.set(name, value); }
  public removeAttribute(name: string): void { this.attributes.delete(name); }
  public setText(value: string): void { this.textContent = value; }
  public empty(): void { this.children.length = 0; this.textContent = ""; }

  public addEventListener(type: string, callback: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  public click(): void {
    for (const callback of this.listeners.get("click") ?? []) callback({} as Event);
  }

  public descendants(className?: string): TestElement[] {
    const nested = this.children.flatMap((child) => [child, ...child.descendants()]);
    return className ? nested.filter((child) => child.classes.has(className)) : nested;
  }
}

export class ItemView {
  public readonly app: unknown;
  public readonly contentEl = new TestElement() as unknown as HTMLElement;

  public constructor(leaf: WorkspaceLeaf) {
    this.app = leaf.app;
  }
}

export class Notice {
  public readonly noticeEl = {} as HTMLElement;

  public constructor(_message = "", _timeout = 0) {}

  public hide(): void {}
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

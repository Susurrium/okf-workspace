import { describe, expect, it, vi } from "vitest";

import { AnchoredActionPanel } from "../src/ui/anchored-action-panel.js";

type Listener = EventListenerOrEventListenerObject;

class FakeEventTarget {
  public readonly listeners = new Map<string, Set<Listener>>();

  public addEventListener(type: string, listener: Listener | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: Listener | null): void {
    if (listener) this.listeners.get(type)?.delete(listener);
  }

  public fire(type: string, event: Record<string, unknown> = {}): void {
    const value = event as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener.call(this, value);
      else listener.handleEvent(value);
    }
  }

  public listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeClassList {
  private readonly names = new Set<string>();

  public set(value: string): void {
    this.names.clear();
    for (const name of value.split(/\s+/u).filter(Boolean)) this.names.add(name);
  }

  public toString(): string { return [...this.names].join(" "); }
  public add(...names: string[]): void { for (const name of names) this.names.add(name); }
  public contains(name: string): boolean { return this.names.has(name); }
  public toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.names.has(name);
    if (enabled) this.names.add(name);
    else this.names.delete(name);
    return enabled;
  }
}

interface FakeRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

class FakeElement extends FakeEventTarget {
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly classList = new FakeClassList();
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = {};
  public parentElement: FakeElement | null = null;
  public id = "";
  public tabIndex = 0;
  public type = "";
  public disabled = false;
  public textContent = "";
  public isConnected = false;
  public rect: FakeRect = {
    top: 0,
    right: 390,
    bottom: 260,
    left: 0,
    width: 390,
    height: 260,
  };

  public constructor(
    public readonly tagName: string,
    public readonly ownerDocument: FakeDocument,
  ) {
    super();
  }

  public get className(): string { return this.classList.toString(); }
  public set className(value: string) { this.classList.set(value); }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    child.setConnected(this.isConnected);
    this.children.push(child);
    return child;
  }

  public remove(): void {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
    }
    this.parentElement = null;
    this.setConnected(false);
  }

  public contains(target: unknown): boolean {
    return target === this || this.children.some((child) => child.contains(target));
  }

  public querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const descendants = this.descendants();
    if (!selector.startsWith(".")) return [];
    const className = selector.slice(1);
    return descendants.filter((child) => child.classList.contains(className)) as T[];
  }

  public focus(): void {
    this.ownerDocument.activeElement = this;
  }

  public getBoundingClientRect(): DOMRect {
    const rect = this.rect;
    return {
      ...rect,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({ ...rect }),
    } as DOMRect;
  }

  public click(): void {
    this.fire("click", eventFor(this));
  }

  private descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  private setConnected(connected: boolean): void {
    this.isConnected = connected;
    for (const child of this.children) child.setConnected(connected);
  }
}

class FakeWindow extends FakeEventTarget {
  public innerWidth = 1200;
  public innerHeight = 800;
}

class FakeDocument extends FakeEventTarget {
  public readonly defaultView = new FakeWindow();
  public readonly body = new FakeElement("body", this);
  public activeElement: FakeElement | null = null;

  public constructor() {
    super();
    this.body.isConnected = true;
  }

  public createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function eventFor(target: FakeElement, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...extra,
  };
}

function button(document: FakeDocument, rect?: Partial<FakeRect>): HTMLButtonElement {
  const trigger = document.createElement("button");
  trigger.rect = { ...trigger.rect, width: 80, height: 32, ...rect };
  document.body.appendChild(trigger);
  return trigger as unknown as HTMLButtonElement;
}

function bodyPanels(document: FakeDocument): FakeElement[] {
  return document.body.children.filter((child) => child.classList.contains("okf-action-panel"));
}

describe("AnchoredActionPanel", () => {
  it("renders one-level descriptive actions, a single footer separator, and ARIA state", () => {
    const document = new FakeDocument();
    const trigger = button(document);
    const selected = vi.fn();
    const renderedIcon = vi.fn();
    const panel = new AnchoredActionPanel(trigger, {
      label: "其他操作 · UAT 测试项目",
      renderHeader: (container) => {
        const title = container.ownerDocument.createElement("strong");
        title.textContent = "UAT 测试项目";
        container.appendChild(title);
      },
      actions: [
        {
          id: "capture",
          title: "记录待整理想法",
          description: "保存到 Inbox，并自动关联这个 Project",
          icon: "lightbulb",
          onSelect: selected,
        },
        { title: "添加资料", onSelect: vi.fn() },
      ],
      renderIcon: renderedIcon,
      renderFooter: (container) => {
        const status = container.ownerDocument.createElement("button");
        status.textContent = "暂停项目";
        container.appendChild(status);
      },
    });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");

    (trigger as unknown as FakeElement).click();
    const root = bodyPanels(document)[0]!;
    const actions = root.querySelectorAll<FakeElement>(".okf-action-panel__action");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(root.id).toBe(panel.id);
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-label")).toBe("其他操作 · UAT 测试项目");
    expect(root.querySelectorAll(".okf-action-panel__header")).toHaveLength(1);
    expect(root.querySelectorAll(".okf-action-panel__header")[0]!.textContent).toBe("");
    expect(root.querySelectorAll(".okf-action-panel__header")[0]!.children[0]!.textContent)
      .toBe("UAT 测试项目");
    expect(actions).toHaveLength(2);
    expect(actions[0]!.dataset.action).toBe("capture");
    expect(root.querySelectorAll(".okf-action-panel__title")[0]!.textContent)
      .toBe("记录待整理想法");
    expect(root.querySelectorAll(".okf-action-panel__description")[0]!.textContent)
      .toBe("保存到 Inbox，并自动关联这个 Project");
    expect(root.querySelectorAll(".okf-action-panel__separator")).toHaveLength(1);
    expect(root.querySelectorAll(".okf-action-panel__footer")).toHaveLength(1);
    expect(renderedIcon).toHaveBeenCalledWith(expect.anything(), "lightbulb");
    expect(document.activeElement).toBe(actions[0]);

    actions[0]!.click();
    expect(selected).toHaveBeenCalledOnce();
    expect(panel.isOpen).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    panel.destroy();
  });

  it("keeps only one panel open and closes on outside pointer or Escape", () => {
    const document = new FakeDocument();
    const firstTrigger = button(document);
    const secondTrigger = button(document);
    const first = new AnchoredActionPanel(firstTrigger, {
      label: "第一个项目操作",
      actions: [{ title: "第一项", onSelect: vi.fn() }],
    });
    const second = new AnchoredActionPanel(secondTrigger, {
      label: "第二个项目操作",
      actions: [{ title: "第二项", onSelect: vi.fn() }],
    });

    first.open();
    second.open();
    expect(first.isOpen).toBe(false);
    expect(second.isOpen).toBe(true);
    expect(bodyPanels(document)).toHaveLength(1);

    const current = bodyPanels(document)[0]!;
    document.fire("pointerdown", eventFor(current));
    expect(second.isOpen).toBe(true);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    document.fire("pointerdown", eventFor(outside));
    expect(second.isOpen).toBe(false);

    second.open();
    const escape = eventFor(bodyPanels(document)[0]!, { key: "Escape" });
    document.fire("keydown", escape);
    expect(second.isOpen).toBe(false);
    expect(document.activeElement).toBe(secondTrigger as unknown as FakeElement);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    first.destroy();
    second.destroy();
  });

  it("anchors inside desktop viewport edges and changes to a narrow full-width sheet", () => {
    const document = new FakeDocument();
    document.defaultView.innerWidth = 1000;
    document.defaultView.innerHeight = 600;
    const trigger = button(document, {
      left: 908,
      right: 988,
      top: 460,
      bottom: 492,
    });
    const panel = new AnchoredActionPanel(trigger, {
      label: "项目操作",
      actions: [{ title: "记录", onSelect: vi.fn() }],
    });

    panel.open();
    const root = bodyPanels(document)[0]!;
    expect(root.style.width).toBe("390px");
    expect(root.style.left).toBe("598px");
    expect(root.style.top).toBe("192px");
    expect(root.dataset.placement).toBe("top");
    expect(root.classList.contains("okf-action-panel--sheet")).toBe(false);

    (trigger as unknown as FakeElement).rect = {
      left: 388,
      right: 468,
      top: 460,
      bottom: 492,
      width: 80,
      height: 32,
    };
    document.defaultView.innerWidth = 480;
    document.defaultView.fire("resize");
    expect(root.classList.contains("okf-action-panel--sheet")).toBe(true);
    expect(root.dataset.placement).toBe("sheet");
    expect(root.style.left).toBe("12px");
    expect(root.style.right).toBe("12px");
    expect(root.style.bottom).toBe("12px");
    expect(root.style.width).toBe("auto");
    panel.destroy();
  });

  it("uses the owning Dashboard pane width for responsive sheet mode", () => {
    const document = new FakeDocument();
    document.defaultView.innerWidth = 1200;
    document.defaultView.innerHeight = 800;
    const pane = document.createElement("div");
    pane.rect = {
      left: 80,
      right: 600,
      top: 40,
      bottom: 760,
      width: 520,
      height: 720,
    };
    document.body.appendChild(pane);
    const trigger = button(document);
    const panel = new AnchoredActionPanel(trigger, {
      label: "项目操作",
      actions: [{ title: "记录", onSelect: vi.fn() }],
      responsiveContainer: pane as unknown as HTMLElement,
    });

    panel.open();
    const root = bodyPanels(document)[0]!;
    expect(root.classList.contains("okf-action-panel--sheet")).toBe(true);
    expect(root.dataset.placement).toBe("sheet");
    expect(root.style.left).toBe("92px");
    expect(root.style.right).toBe("612px");
    expect(root.style.bottom).toBe("52px");
    expect(root.style.maxHeight).toBe("696px");

    (trigger as unknown as FakeElement).rect = {
      left: 100,
      right: 180,
      top: 0,
      bottom: 40,
      width: 80,
      height: 40,
    };
    document.fire("scroll");
    expect(panel.isOpen).toBe(false);
    panel.destroy();
  });

  it("removes global and trigger listeners and restores existing ARIA attributes", () => {
    const document = new FakeDocument();
    const trigger = button(document);
    trigger.setAttribute("aria-expanded", "mixed");
    trigger.setAttribute("aria-controls", "existing-panel");
    const fakeTrigger = trigger as unknown as FakeElement;
    const panel = new AnchoredActionPanel(trigger, {
      label: "项目操作",
      actions: [{ title: "记录", onSelect: vi.fn() }],
    });

    panel.open();
    expect(document.listenerCount("pointerdown")).toBe(1);
    expect(document.listenerCount("keydown")).toBe(1);
    expect(document.listenerCount("scroll")).toBe(1);
    expect(document.defaultView.listenerCount("resize")).toBe(1);
    expect(fakeTrigger.listenerCount("click")).toBe(1);

    panel.destroy();
    expect(document.listenerCount("pointerdown")).toBe(0);
    expect(document.listenerCount("keydown")).toBe(0);
    expect(document.listenerCount("scroll")).toBe(0);
    expect(document.defaultView.listenerCount("resize")).toBe(0);
    expect(fakeTrigger.listenerCount("click")).toBe(0);
    expect(trigger.getAttribute("aria-expanded")).toBe("mixed");
    expect(trigger.getAttribute("aria-controls")).toBe("existing-panel");
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();

    fakeTrigger.click();
    expect(bodyPanels(document)).toHaveLength(0);
  });

  it("closes before invoking an action and reports async action failures", async () => {
    const document = new FakeDocument();
    const trigger = button(document);
    let panel: AnchoredActionPanel;
    const error = new Error("failed action");
    const onActionError = vi.fn();
    const onSelect = vi.fn(() => {
      expect(panel.isOpen).toBe(false);
      return Promise.reject(error);
    });
    panel = new AnchoredActionPanel(trigger, {
      label: "项目操作",
      actions: [{ title: "失败动作", onSelect }],
      onActionError,
    });

    panel.open();
    bodyPanels(document)[0]!
      .querySelectorAll<FakeElement>(".okf-action-panel__action")[0]!
      .click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onActionError).toHaveBeenCalledWith(error);
    panel.destroy();
  });

  it("reports synchronous action failures through the same error boundary", () => {
    const document = new FakeDocument();
    const trigger = button(document);
    const error = new Error("synchronous failure");
    const onActionError = vi.fn();
    const panel = new AnchoredActionPanel(trigger, {
      label: "项目操作",
      actions: [{
        title: "失败动作",
        onSelect: () => { throw error; },
      }],
      onActionError,
    });

    panel.open();
    bodyPanels(document)[0]!
      .querySelectorAll<FakeElement>(".okf-action-panel__action")[0]!
      .click();
    expect(panel.isOpen).toBe(false);
    expect(onActionError).toHaveBeenCalledWith(error);
    panel.destroy();
  });
});

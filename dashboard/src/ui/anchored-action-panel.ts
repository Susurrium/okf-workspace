const PANEL_CLASS = "okf-action-panel";
const SHEET_CLASS = "okf-action-panel--sheet";
const DEFAULT_BREAKPOINT = 600;
const DEFAULT_WIDTH = 390;
const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 8;

let nextPanelId = 0;
let activePanel: AnchoredActionPanel | undefined;

export interface AnchoredActionPanelAction {
  /** Stable key for tests, telemetry, and action-specific styling. */
  id?: string;
  title: string;
  description?: string;
  icon?: string;
  disabled?: boolean;
  tone?: "default" | "danger";
  /** Keep the panel open only for controls whose result stays inside the panel. */
  keepOpen?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface AnchoredActionPanelFooterContext {
  close: () => void;
  trigger: HTMLButtonElement;
}

export interface AnchoredActionPanelOptions {
  /** Accessible name, normally including the entity title. */
  label: string;
  actions: readonly AnchoredActionPanelAction[];
  /** Optional visible identity/context above the flat action list. */
  renderHeader?: (
    container: HTMLElement,
    context: AnchoredActionPanelFooterContext,
  ) => void;
  /** A single optional footer, preceded by the component's only separator. */
  renderFooter?: (
    container: HTMLElement,
    context: AnchoredActionPanelFooterContext,
  ) => void;
  /** Lets the Obsidian integration use setIcon without coupling this module to Obsidian. */
  renderIcon?: (container: HTMLElement, icon: string) => void;
  sheetBreakpoint?: number;
  /** Pane width can be narrower than the Obsidian window that owns the portal. */
  responsiveWidth?: () => number;
  /** Owning pane used for responsive mode, fixed positioning, and resize observation. */
  responsiveContainer?: HTMLElement;
  onOpen?: () => void;
  onClose?: () => void;
  onActionError?: (error: unknown) => void;
}

interface CloseOptions {
  restoreFocus: boolean;
}

interface PreservedTriggerAttributes {
  expanded: string | null;
  controls: string | null;
  hasPopup: string | null;
}

/**
 * A non-modal, viewport-aware action popover for dense Dashboard entity lists.
 *
 * The panel is portalled to the trigger's document body, so it is not clipped by
 * Dashboard rows and also works in Obsidian pop-out windows. Call destroy() when
 * the owning view or row is disposed.
 */
export class AnchoredActionPanel {
  public readonly id = `okf-action-panel-${++nextPanelId}`;

  private options: AnchoredActionPanelOptions;
  private panelEl: HTMLDivElement | undefined;
  private destroyed = false;
  private listening = false;
  private resizeObserver: ResizeObserver | undefined;
  private readonly document: Document;
  private readonly view: Window;
  private readonly previousTriggerAttributes: PreservedTriggerAttributes;

  public constructor(
    private readonly trigger: HTMLButtonElement,
    options: AnchoredActionPanelOptions,
  ) {
    const ownerDocument = trigger.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) {
      throw new Error("AnchoredActionPanel requires a trigger attached to a window document");
    }
    this.document = ownerDocument;
    this.view = ownerWindow;
    this.options = options;
    this.previousTriggerAttributes = {
      expanded: trigger.getAttribute("aria-expanded"),
      controls: trigger.getAttribute("aria-controls"),
      hasPopup: trigger.getAttribute("aria-haspopup"),
    };
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", this.id);
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.addEventListener("click", this.handleTriggerClick);
  }

  public get isOpen(): boolean {
    return this.panelEl !== undefined;
  }

  public open(): void {
    if (this.destroyed || this.panelEl) return;
    if (activePanel && activePanel !== this) {
      activePanel.close({ restoreFocus: false });
    }

    const panel = this.buildPanel();
    this.panelEl = panel;
    activePanel = this;
    this.document.body.appendChild(panel);
    this.trigger.setAttribute("aria-expanded", "true");
    this.startListening();
    if (!this.positionPanel()) return;
    this.firstEnabledAction(panel)?.focus();
    this.options.onOpen?.();
  }

  public close(options: CloseOptions = { restoreFocus: false }): void {
    const panel = this.panelEl;
    if (!panel) return;
    this.stopListening();
    panel.remove();
    this.panelEl = undefined;
    this.trigger.setAttribute("aria-expanded", "false");
    if (activePanel === this) activePanel = undefined;
    this.options.onClose?.();
    if (options.restoreFocus && this.trigger.isConnected) this.trigger.focus();
  }

  public toggle(): void {
    if (this.panelEl) this.close({ restoreFocus: false });
    else this.open();
  }

  /** Replaces the entity-specific actions without replacing the trigger. */
  public update(options: AnchoredActionPanelOptions): void {
    const reopen = this.isOpen;
    if (reopen) this.close({ restoreFocus: false });
    this.options = options;
    if (reopen) this.open();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.close({ restoreFocus: false });
    this.trigger.removeEventListener("click", this.handleTriggerClick);
    this.restoreAttribute("aria-expanded", this.previousTriggerAttributes.expanded);
    this.restoreAttribute("aria-controls", this.previousTriggerAttributes.controls);
    this.restoreAttribute("aria-haspopup", this.previousTriggerAttributes.hasPopup);
    this.destroyed = true;
  }

  private readonly handleTriggerClick = (event: Event): void => {
    event.preventDefault();
    this.toggle();
  };

  private readonly handlePointerDown = (event: Event): void => {
    const target = event.target as Node | null;
    if (target && (this.panelEl?.contains(target) || this.trigger.contains(target))) return;
    this.close({ restoreFocus: false });
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.close({ restoreFocus: true });
  };

  private readonly handleViewportChange = (): void => {
    if (this.panelEl) this.positionPanel();
  };

  private buildPanel(): HTMLDivElement {
    const panel = this.document.createElement("div");
    panel.id = this.id;
    panel.className = PANEL_CLASS;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", this.options.label);
    panel.setAttribute("data-okf-action-panel", "");
    panel.tabIndex = -1;
    panel.style.position = "fixed";
    panel.style.visibility = "hidden";

    if (this.options.renderHeader) {
      const header = this.document.createElement("div");
      header.className = `${PANEL_CLASS}__header`;
      panel.appendChild(header);
      this.options.renderHeader(header, {
        close: () => this.close({ restoreFocus: true }),
        trigger: this.trigger,
      });
    }

    const actions = this.document.createElement("div");
    actions.className = `${PANEL_CLASS}__actions`;
    panel.appendChild(actions);
    for (const action of this.options.actions) {
      actions.appendChild(this.buildAction(action));
    }

    if (this.options.renderFooter) {
      const separator = this.document.createElement("div");
      separator.className = `${PANEL_CLASS}__separator`;
      separator.setAttribute("role", "separator");
      panel.appendChild(separator);

      const footer = this.document.createElement("div");
      footer.className = `${PANEL_CLASS}__footer`;
      panel.appendChild(footer);
      this.options.renderFooter(footer, {
        close: () => this.close({ restoreFocus: true }),
        trigger: this.trigger,
      });
    }
    return panel;
  }

  private buildAction(action: AnchoredActionPanelAction): HTMLButtonElement {
    const button = this.document.createElement("button");
    button.type = "button";
    button.className = `${PANEL_CLASS}__action`;
    button.disabled = action.disabled ?? false;
    if (action.id) button.dataset.action = action.id;
    if (action.tone === "danger") button.classList.add(`${PANEL_CLASS}__action--danger`);

    if (action.icon) {
      const icon = this.document.createElement("span");
      icon.className = `${PANEL_CLASS}__icon`;
      icon.setAttribute("aria-hidden", "true");
      icon.dataset.icon = action.icon;
      this.options.renderIcon?.(icon, action.icon);
      button.appendChild(icon);
    }

    const copy = this.document.createElement("span");
    copy.className = `${PANEL_CLASS}__copy`;
    const title = this.document.createElement("span");
    title.className = `${PANEL_CLASS}__title`;
    title.textContent = action.title;
    copy.appendChild(title);
    if (action.description) {
      const description = this.document.createElement("span");
      description.className = `${PANEL_CLASS}__description`;
      description.textContent = action.description;
      copy.appendChild(description);
    }
    button.appendChild(copy);

    button.addEventListener("click", () => {
      if (!action.keepOpen) this.close({ restoreFocus: false });
      try {
        void Promise.resolve(action.onSelect()).catch((error: unknown) => {
          this.options.onActionError?.(error);
        });
      } catch (error: unknown) {
        this.options.onActionError?.(error);
      }
    });
    return button;
  }

  private firstEnabledAction(panel: HTMLElement): HTMLButtonElement | undefined {
    for (const candidate of panel.querySelectorAll<HTMLButtonElement>(
      `.${PANEL_CLASS}__action`,
    )) {
      if (!candidate.disabled) return candidate;
    }
    panel.focus();
    return undefined;
  }

  private positionPanel(): boolean {
    const panel = this.panelEl;
    if (!panel) return false;
    const viewportWidth = this.view.innerWidth;
    const viewportHeight = this.view.innerHeight;
    const containerRect = this.usableContainerRect();
    const horizontalStart = Math.max(VIEWPORT_MARGIN, (containerRect?.left ?? 0) + VIEWPORT_MARGIN);
    const horizontalEnd = Math.min(
      viewportWidth - VIEWPORT_MARGIN,
      (containerRect?.right ?? viewportWidth) - VIEWPORT_MARGIN,
    );
    const verticalStart = Math.max(VIEWPORT_MARGIN, (containerRect?.top ?? 0) + VIEWPORT_MARGIN);
    const verticalEnd = Math.min(
      viewportHeight - VIEWPORT_MARGIN,
      (containerRect?.bottom ?? viewportHeight) - VIEWPORT_MARGIN,
    );
    const triggerRect = this.trigger.getBoundingClientRect();
    if (
      triggerRect.right <= horizontalStart ||
      triggerRect.left >= horizontalEnd ||
      triggerRect.bottom <= verticalStart ||
      triggerRect.top >= verticalEnd
    ) {
      this.close({ restoreFocus: false });
      return false;
    }
    const responsiveWidth = Math.min(
      viewportWidth,
      this.options.responsiveWidth?.() ?? containerRect?.width ?? viewportWidth,
    );
    const useSheet = responsiveWidth < (this.options.sheetBreakpoint ?? DEFAULT_BREAKPOINT);
    panel.classList.toggle(SHEET_CLASS, useSheet);

    if (useSheet) {
      panel.dataset.placement = "sheet";
      panel.style.left = `${Math.round(horizontalStart)}px`;
      panel.style.right = `${Math.round(Math.max(VIEWPORT_MARGIN, viewportWidth - horizontalEnd))}px`;
      panel.style.top = "auto";
      panel.style.bottom = `${Math.round(Math.max(VIEWPORT_MARGIN, viewportHeight - verticalEnd))}px`;
      panel.style.width = "auto";
      panel.style.maxWidth = "none";
      panel.style.maxHeight = `${Math.round(Math.max(0, verticalEnd - verticalStart))}px`;
      panel.style.visibility = "visible";
      return true;
    }

    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.width = `${DEFAULT_WIDTH}px`;
    panel.style.maxWidth = `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`;
    const measured = panel.getBoundingClientRect();
    const panelWidth = measured.width || DEFAULT_WIDTH;
    const panelHeight = measured.height;
    const maxLeft = Math.max(horizontalStart, horizontalEnd - panelWidth);
    const left = clamp(triggerRect.right - panelWidth, horizontalStart, maxLeft);
    panel.style.left = `${Math.round(left)}px`;

    const spaceBelow = verticalEnd - triggerRect.bottom - ANCHOR_GAP;
    const spaceAbove = triggerRect.top - ANCHOR_GAP - verticalStart;
    const placeAbove = panelHeight > spaceBelow && spaceAbove > spaceBelow;
    if (placeAbove) {
      const availableHeight = Math.max(0, spaceAbove);
      const shownHeight = Math.min(panelHeight, availableHeight);
      panel.style.top = `${Math.round(Math.max(
        verticalStart,
        triggerRect.top - ANCHOR_GAP - shownHeight,
      ))}px`;
      panel.style.maxHeight = `${Math.round(availableHeight)}px`;
      panel.dataset.placement = "top";
    } else {
      const top = Math.min(triggerRect.bottom + ANCHOR_GAP, verticalEnd);
      panel.style.top = `${Math.round(top)}px`;
      panel.style.maxHeight = `${Math.round(Math.max(0, verticalEnd - top))}px`;
      panel.dataset.placement = "bottom";
    }
    panel.style.visibility = "visible";
    return true;
  }

  private startListening(): void {
    if (this.listening) return;
    this.document.addEventListener("pointerdown", this.handlePointerDown);
    this.document.addEventListener("keydown", this.handleKeyDown);
    this.document.addEventListener("scroll", this.handleViewportChange, true);
    this.view.addEventListener("resize", this.handleViewportChange);
    const ResizeObserverConstructor = (this.view as Window & {
      ResizeObserver?: typeof ResizeObserver;
    }).ResizeObserver;
    if (ResizeObserverConstructor && this.options.responsiveContainer) {
      this.resizeObserver = new ResizeObserverConstructor(this.handleViewportChange);
      this.resizeObserver.observe(this.options.responsiveContainer);
    }
    this.listening = true;
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.document.removeEventListener("pointerdown", this.handlePointerDown);
    this.document.removeEventListener("keydown", this.handleKeyDown);
    this.document.removeEventListener("scroll", this.handleViewportChange, true);
    this.view.removeEventListener("resize", this.handleViewportChange);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.listening = false;
  }

  private usableContainerRect(): DOMRect | undefined {
    const rect = this.options.responsiveContainer?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : undefined;
  }

  private restoreAttribute(name: string, value: string | null): void {
    if (value === null) this.trigger.removeAttribute(name);
    else this.trigger.setAttribute(name, value);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

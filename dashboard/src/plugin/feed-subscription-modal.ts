import { App, Modal, Notice } from "obsidian";

import {
  createFeedSubscriptionIdempotencyKey,
  FEED_SUBSCRIPTION_CONTENT_MAX,
  FEED_SUBSCRIPTION_CONTENT_MIN,
  FEED_SUBSCRIPTION_FULL_CONTENT_DEFAULT,
  feedSubscriptionAdapterLabel,
  feedSubscriptionDisplayOrigin,
  feedSubscriptionFailureLabel,
  feedSubscriptionModeLabel,
  normalizeFeedSubscriptionContentMax,
  normalizeFeedSubscriptionUrl,
} from "../domain/feed-subscriptions.js";
import { FeedHttpError } from "../feeds/service.js";
import type {
  FeedSubscriptionAdapter,
  FeedSubscriptionConfirmRequest,
  FeedSubscriptionConfirmResult,
  FeedSubscriptionContentMode,
  FeedSubscriptionManagementPage,
  FeedSubscriptionManagementSource,
  FeedSubscriptionMutationRequest,
  FeedSubscriptionMutationResult,
  FeedSubscriptionPreview,
  FeedSubscriptionPreviewRequest,
  FeedSubscriptionRemoveRequest,
  FeedSubscriptionRemoveResult,
  FeedSubscriptionSource,
} from "../feeds/types.js";

export interface FeedSubscriptionAddActions {
  preview(request: FeedSubscriptionPreviewRequest): Promise<FeedSubscriptionPreview>;
  confirm(request: FeedSubscriptionConfirmRequest): Promise<FeedSubscriptionConfirmResult>;
  confirmed(result: FeedSubscriptionConfirmResult): Promise<void> | void;
}

export interface FeedSubscriptionSettingsActions {
  load(): Promise<FeedSubscriptionManagementPage>;
  enable(
    sourceId: string,
    request: FeedSubscriptionMutationRequest,
  ): Promise<FeedSubscriptionMutationResult>;
  disable(
    sourceId: string,
    request: FeedSubscriptionMutationRequest,
  ): Promise<FeedSubscriptionMutationResult>;
  remove(
    sourceId: string,
    request: FeedSubscriptionRemoveRequest,
  ): Promise<FeedSubscriptionRemoveResult>;
  changed(): Promise<void> | void;
}

type InputElement = HTMLInputElement | HTMLSelectElement;

export class FeedSubscriptionAddModal extends Modal {
  private url = "";
  private name = "";
  private adapter: FeedSubscriptionAdapter = "auto";
  private preview: FeedSubscriptionPreview | undefined;
  private contentMode: FeedSubscriptionContentMode = "summary";
  private contentMaxChars = String(FEED_SUBSCRIPTION_FULL_CONTENT_DEFAULT);
  private includeExisting = false;
  private idempotencyKey = "";
  private requestGeneration = 0;
  private submitting = false;
  private backButton: HTMLButtonElement | undefined;

  public constructor(app: App, private readonly actions: FeedSubscriptionAddActions) {
    super(app);
  }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal", "okf-feed-subscription-modal");
    this.titleEl.setText("添加订阅");
    this.renderInput();
  }

  public onClose(): void {
    this.requestGeneration += 1;
    this.url = "";
    this.name = "";
    this.preview = undefined;
    this.idempotencyKey = "";
    this.contentEl.empty();
  }

  private renderInput(message = ""): void {
    this.contentEl.empty();
    this.contentEl.createDiv({
      cls: "okf-feed-subscription-modal__intro",
      text: "填写 RSS、Atom 或受支持的 GitHub 地址。系统会先检测并预览，不会立即保存。",
    });
    const form = this.contentEl.createEl("form", {
      cls: "okf-feed-subscription-modal__form",
    });
    const url = this.field(form, "订阅地址", "url", {
      type: "url",
      placeholder: "https://example.com/feed.xml",
      required: "true",
      autocomplete: "url",
    }) as HTMLInputElement;
    url.value = this.url;
    url.addEventListener("input", () => {
      this.url = url.value;
    });
    const name = this.field(form, "来源名称（可选）", "name", {
      type: "text",
      placeholder: "留空时使用检测到的来源名称",
      autocomplete: "off",
    }) as HTMLInputElement;
    name.value = this.name;
    name.addEventListener("input", () => {
      this.name = name.value;
      name.removeAttribute("aria-invalid");
    });
    const adapter = this.selectField(form, "来源类型", "adapter", [
      ["auto", "自动检测（推荐）"],
      ["rss", "RSS / Atom"],
      ["github_repository", "GitHub 仓库动态"],
      ["github_releases", "GitHub Releases"],
    ]);
    adapter.value = this.adapter;
    adapter.addEventListener("change", () => {
      this.adapter = adapter.value as FeedSubscriptionAdapter;
    });
    const feedback = form.createDiv({
      cls: `okf-feed-subscription-modal__feedback${message ? " is-error" : ""}`,
      text: message,
      attr: { role: "alert", "aria-live": "polite" },
    });
    const actions = form.createDiv({ cls: "okf-feed-subscription-modal__actions" });
    const cancel = actions.createEl("button", {
      text: "取消",
      cls: "okf-dashboard__ghost-action",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());
    const detect = actions.createEl("button", {
      text: "检测并预览",
      cls: "mod-cta okf-dashboard__primary-action",
      attr: { type: "submit" },
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.detect(detect, feedback, name);
    });
    url.focus();
  }

  private async detect(
    button: HTMLButtonElement,
    feedback: HTMLElement,
    nameInput: HTMLInputElement,
  ): Promise<void> {
    if (this.submitting) return;
    let url: string;
    try {
      url = normalizeFeedSubscriptionUrl(this.url);
    } catch (error) {
      feedback.addClass("is-error");
      feedback.setText(feedSubscriptionErrorMessage(error));
      return;
    }
    const generation = ++this.requestGeneration;
    this.submitting = true;
    button.disabled = true;
    button.setText("正在检测…");
    feedback.removeClass("is-error");
    feedback.setText("正在读取来源并检查最近内容…");
    try {
      const preview = await this.actions.preview({
        url,
        ...(this.name.trim() ? { name: this.name.trim() } : {}),
        adapter: this.adapter,
      });
      if (generation !== this.requestGeneration) return;
      this.preview = preview;
      this.contentMode = preview.defaults.content_mode;
      this.contentMaxChars = String(preview.defaults.content_max_chars);
      this.includeExisting = preview.defaults.include_existing;
      this.idempotencyKey = createFeedSubscriptionIdempotencyKey();
      this.renderPreview();
    } catch (error) {
      if (generation !== this.requestGeneration) return;
      feedback.addClass("is-error");
      feedback.setText(feedSubscriptionErrorMessage(error));
      if (
        error instanceof FeedHttpError
        && ["source_name_conflict", "invalid_source_name"].includes(error.code ?? "")
      ) {
        nameInput.setAttr("aria-invalid", "true");
        nameInput.focus();
      }
    } finally {
      if (generation === this.requestGeneration) {
        this.submitting = false;
        button.disabled = false;
        button.setText("检测并预览");
      }
    }
  }

  private renderPreview(message = ""): void {
    const preview = this.preview;
    if (!preview) {
      this.renderInput(message);
      return;
    }
    this.contentEl.empty();
    const summary = this.contentEl.createEl("section", {
      cls: "okf-feed-subscription-preview",
      attr: { "aria-label": "订阅检测结果" },
    });
    summary.createEl("h3", { text: preview.source_name });
    const origin = summary.createDiv({ cls: "okf-feed-subscription-preview__url" });
    origin.createSpan({ text: "来源域名：" });
    origin.createEl("strong", { text: feedSubscriptionDisplayOrigin(preview.canonical_url) });
    summary.createDiv({
      cls: "okf-dashboard__muted",
      text: "来源域名只用于辨识来源；不包含订阅路径或私密参数，也不能用于重新检测。",
    });
    const badges = summary.createDiv({ cls: "okf-feed-subscription-preview__badges" });
    badges.createSpan({
      cls: "okf-dashboard__badge",
      text: feedSubscriptionAdapterLabel(preview.detected_adapter),
    });
    for (const mode of preview.capabilities.content_modes) {
      badges.createSpan({
        cls: "okf-dashboard__badge",
        text: mode === "full" ? "可尝试获取正文" : "可保存摘要",
      });
    }
    if (preview.existing_source_id) {
      summary.createDiv({
        cls: "okf-dashboard__inline-alert",
        text: "这个订阅已经存在，不能重复添加。可关闭窗口后在对应来源卡中打开设置。",
      });
    }
    for (const warning of preview.warnings ?? []) {
      summary.createDiv({ cls: "okf-dashboard__inline-alert", text: warning });
    }
    this.renderPreviewEntries(summary, preview);
    if (preview.existing_source_id) {
      const duplicateActions = this.contentEl.createDiv({
        cls: "okf-feed-subscription-modal__actions",
      });
      const back = duplicateActions.createEl("button", {
        text: "修改地址",
        cls: "okf-dashboard__secondary-action",
        attr: { type: "button" },
      });
      back.addEventListener("click", () => {
        this.requestGeneration += 1;
        this.preview = undefined;
        this.renderInput();
      });
      const close = duplicateActions.createEl("button", {
        text: "关闭",
        cls: "mod-cta okf-dashboard__primary-action",
        attr: { type: "button" },
      });
      close.addEventListener("click", () => this.close());
      close.focus();
      return;
    }

    const form = this.contentEl.createEl("form", {
      cls: "okf-feed-subscription-modal__form okf-feed-subscription-modal__configuration",
    });
    const mode = this.selectField(
      form,
      "保存内容",
      "content-mode",
      preview.capabilities.content_modes.map((value) => [
        value,
        value === "full" ? "正文优先（建议上限 12000 字符）" : "摘要（推荐）",
      ]),
    );
    mode.value = this.contentMode;
    const advanced = form.createEl("details", {
      cls: `okf-feed-subscription-modal__advanced${this.contentMode === "full" ? "" : " is-hidden"}`,
    });
    advanced.createEl("summary", { text: "高级设置" });
    const maxChars = this.field(advanced, "单条正文上限", "content-max", {
      type: "number",
      min: String(FEED_SUBSCRIPTION_CONTENT_MIN),
      max: String(FEED_SUBSCRIPTION_CONTENT_MAX),
      step: "100",
      inputmode: "numeric",
    }) as HTMLInputElement;
    maxChars.value = this.contentMaxChars;
    advanced.createDiv({
      cls: "okf-dashboard__muted",
      text: `推荐 ${FEED_SUBSCRIPTION_FULL_CONTENT_DEFAULT}；允许 ${FEED_SUBSCRIPTION_CONTENT_MIN}–${FEED_SUBSCRIPTION_CONTENT_MAX}。`,
    });
    mode.addEventListener("change", () => {
      this.contentMode = mode.value as FeedSubscriptionContentMode;
      advanced.toggleClass("is-hidden", this.contentMode !== "full");
    });
    maxChars.addEventListener("input", () => {
      this.contentMaxChars = maxChars.value;
    });
    if (preview.capabilities.can_include_existing) {
      const existing = this.selectField(form, "从哪里开始", "include-existing", [
        ["false", "仅订阅未来内容（推荐）"],
        ["true", "包含当前检测到的内容"],
      ]);
      existing.value = String(this.includeExisting);
      existing.addEventListener("change", () => {
        this.includeExisting = existing.value === "true";
      });
    } else {
      form.createDiv({
        cls: "okf-dashboard__muted",
        text: this.includeExisting
          ? "此类来源固定包含当前检测到的内容，不能改为仅订阅未来内容。"
          : "此类来源只订阅未来内容，不能包含当前内容。",
      });
    }
    const feedback = form.createDiv({
      cls: `okf-feed-subscription-modal__feedback${message ? " is-error" : ""}`,
      text: message,
      attr: { role: "alert", "aria-live": "polite" },
    });
    const actions = form.createDiv({ cls: "okf-feed-subscription-modal__actions" });
    const back = actions.createEl("button", {
      text: "返回修改",
      cls: "okf-dashboard__ghost-action",
      attr: { type: "button" },
    });
    back.addEventListener("click", () => {
      if (this.submitting) return;
      this.requestGeneration += 1;
      this.preview = undefined;
      this.renderInput();
    });
    this.backButton = back;
    const confirm = actions.createEl("button", {
      text: "确认添加",
      cls: "mod-cta okf-dashboard__primary-action",
      attr: { type: "submit" },
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.confirm(confirm, feedback);
    });
    mode.focus();
  }

  private async confirm(button: HTMLButtonElement, feedback: HTMLElement): Promise<void> {
    const preview = this.preview;
    if (!preview || this.submitting) return;
    let contentMaxChars: number | undefined;
    try {
      if (this.contentMode === "full") {
        contentMaxChars = normalizeFeedSubscriptionContentMax(this.contentMaxChars);
      }
    } catch (error) {
      feedback.addClass("is-error");
      feedback.setText(feedSubscriptionErrorMessage(error));
      return;
    }
    const generation = ++this.requestGeneration;
    this.submitting = true;
    button.disabled = true;
    button.setText("正在保存…");
    if (this.backButton) this.backButton.disabled = true;
    feedback.removeClass("is-error");
    feedback.setText("正在保存订阅设置…");
    try {
      const result = await this.actions.confirm({
        preview_id: preview.preview_id,
        expected_registry_revision: preview.registry_revision,
        idempotency_key: this.idempotencyKey,
        include_existing: this.includeExisting,
        content_mode: this.contentMode,
        ...(contentMaxChars === undefined ? {} : { content_max_chars: contentMaxChars }),
      });
      // Closing a view cannot undo an accepted server mutation. Always publish
      // its result so the Reading catalog refreshes even after the modal closes.
      try {
        await this.actions.confirmed(result);
      } catch {
        new Notice("订阅已保存，但列表刷新失败；请重新打开 Reading 查看。", 10_000);
      }
      if (generation === this.requestGeneration) this.close();
    } catch (error) {
      if (generation !== this.requestGeneration) {
        new Notice(`订阅保存未确认：${feedSubscriptionErrorMessage(error)}，请先检查 Reading 中的来源列表。`, 10_000);
        return;
      }
      feedback.addClass("is-error");
      feedback.setText(feedSubscriptionErrorMessage(error));
    } finally {
      this.submitting = false;
      if (generation === this.requestGeneration) {
        button.disabled = false;
        button.setText("确认添加");
        if (this.backButton) this.backButton.disabled = false;
      }
    }
  }

  private renderPreviewEntries(parent: HTMLElement, preview: FeedSubscriptionPreview): void {
    const section = parent.createDiv({ cls: "okf-feed-subscription-preview__entries" });
    section.createEl("h4", { text: `最近内容 · ${preview.entries.length} 条预览` });
    if (!preview.entries.length) {
      section.createDiv({
        cls: "okf-dashboard__empty",
        text: "检测成功，但来源当前没有可预览的条目。保存后会等待首次更新。",
      });
      return;
    }
    for (const entry of preview.entries.slice(0, 3)) {
      const item = section.createEl("article", { cls: "okf-feed-subscription-preview__entry" });
      item.createEl("strong", { text: entry.title });
      item.createDiv({ cls: "okf-feed-subscription-preview__url", text: entry.url });
      if (entry.published_at) {
        item.createDiv({
          cls: "okf-dashboard__muted",
          text: formatSubscriptionTimestamp(entry.published_at),
        });
      }
    }
  }

  private field(
    parent: HTMLElement,
    label: string,
    id: string,
    attributes: Record<string, string>,
  ): InputElement {
    const wrapper = parent.createDiv({ cls: "okf-feed-subscription-modal__field" });
    wrapper.createEl("label", { text: label, attr: { for: `okf-subscription-${id}` } });
    return wrapper.createEl("input", {
      attr: { id: `okf-subscription-${id}`, ...attributes },
    }) as InputElement;
  }

  private selectField(
    parent: HTMLElement,
    label: string,
    id: string,
    options: readonly (readonly [string, string])[],
  ): HTMLSelectElement {
    const wrapper = parent.createDiv({ cls: "okf-feed-subscription-modal__field" });
    wrapper.createEl("label", { text: label, attr: { for: `okf-subscription-${id}` } });
    const select = wrapper.createEl("select", {
      attr: { id: `okf-subscription-${id}` },
    });
    for (const [value, text] of options) {
      select.createEl("option", { text, attr: { value } });
    }
    return select;
  }
}

export class FeedSubscriptionSettingsModal extends Modal {
  private generation = 0;
  private page: FeedSubscriptionManagementPage | undefined;
  private source: FeedSubscriptionManagementSource | undefined;
  private busy = false;
  private readonly projection: Pick<FeedSubscriptionSource, "source_id" | "source_name">;

  public constructor(
    app: App,
    projection: Pick<FeedSubscriptionSource, "source_id" | "source_name">,
    private readonly actions: FeedSubscriptionSettingsActions,
  ) {
    super(app);
    this.projection = {
      source_id: projection.source_id,
      source_name: projection.source_name,
    };
  }

  public onOpen(): void {
    this.modalEl.addClass("okf-workflow-modal", "okf-feed-subscription-modal");
    this.titleEl.setText("订阅设置");
    this.renderLoading();
    void this.load();
  }

  public onClose(): void {
    this.generation += 1;
    this.contentEl.empty();
  }

  private renderLoading(): void {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "okf-dashboard__loading", text: "正在读取订阅设置…" });
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    try {
      const page = await this.actions.load();
      if (generation !== this.generation) return;
      this.page = page;
      this.source = page.sources.find((source) => source.source_id === this.projection.source_id);
      this.render();
    } catch (error) {
      if (generation !== this.generation) return;
      this.renderFailure(feedSubscriptionErrorMessage(error), () => void this.load());
    }
  }

  private render(): void {
    this.contentEl.empty();
    const source = this.source;
    if (!source) {
      this.contentEl.createEl("h3", { text: this.projection.source_name });
      this.contentEl.createDiv({
        cls: "okf-dashboard__inline-alert",
        text: "这个来源已不在订阅列表中。历史内容仍然保留，可继续从 Reading 打开。",
      });
      return;
    }
    const heading = this.contentEl.createDiv({ cls: "okf-feed-subscription-settings__heading" });
    heading.createEl("h3", { text: source.source_name });
    heading.createSpan({
      cls: `okf-feed-subscription-status is-${source.status}`,
      text: managementStatusLabel(source),
    });
    const origin = this.contentEl.createDiv({ cls: "okf-feed-subscription-preview__url" });
    origin.createSpan({ text: "来源域名：" });
    origin.createEl("strong", { text: feedSubscriptionDisplayOrigin(source.canonical_url) });
    this.contentEl.createDiv({
      cls: "okf-dashboard__muted",
      text: "来源域名只用于辨识来源；不包含订阅路径或私密参数，也不能用于重新检测。",
    });
    const facts = this.contentEl.createDiv({ cls: "okf-feed-subscription-settings__facts" });
    this.fact(facts, "类型", feedSubscriptionAdapterLabel(source.adapter));
    this.fact(
      facts,
      "保存内容",
      source.content_mode === "full"
        ? `${feedSubscriptionModeLabel(source.content_mode)} · 最多 ${source.content_max_chars} 字符`
        : feedSubscriptionModeLabel(source.content_mode),
    );
    if (source.last_success_at) {
      this.fact(facts, "最近成功", formatSubscriptionTimestamp(source.last_success_at));
    }
    if (source.last_error_at) {
      this.fact(facts, "最近失败", formatSubscriptionTimestamp(source.last_error_at));
    }
    if (source.last_error || source.last_error_type) {
      this.contentEl.createDiv({
        cls: "okf-dashboard__inline-alert",
        text: feedSubscriptionFailureLabel(source.last_error_type),
      });
    }
    if (this.page?.remote_status !== "current") {
      this.contentEl.createDiv({
        cls: "okf-dashboard__inline-alert",
        text: this.page?.remote_status === "stale"
          ? "当前显示的是最近一次成功读取的设置；连接恢复并重新读取前，暂停、恢复和移除暂不可用。"
          : "远端订阅服务尚未配置，暂停、恢复和移除暂不可用。",
      });
    }
    const mutationsAvailable = this.page?.remote_status === "current" &&
      Boolean(this.page.registry_revision);
    if (source.status !== "removed") {
      const actions = this.contentEl.createDiv({ cls: "okf-feed-subscription-settings__actions" });
      const toggle = actions.createEl("button", {
        text: source.enabled ? "暂停订阅" : "恢复订阅",
        cls: "okf-dashboard__secondary-action",
        attr: {
          type: "button",
          ...(!mutationsAvailable ? { title: "连接恢复并重新读取设置后才能更改" } : {}),
        },
      });
      toggle.disabled = !mutationsAvailable;
      if (mutationsAvailable) {
        toggle.addEventListener("click", () => void this.toggle(source, toggle));
      }
      if (!source.required) {
        const remove = actions.createEl("button", {
          text: "移除订阅…",
          cls: "okf-dashboard__danger-action",
          attr: {
            type: "button",
            ...(!mutationsAvailable ? { title: "连接恢复并重新读取设置后才能更改" } : {}),
          },
        });
        remove.disabled = !mutationsAvailable;
        if (mutationsAvailable) {
          remove.addEventListener("click", () => this.renderRemoveConfirmation(source));
        }
      }
    }
    if (source.required && source.status !== "removed") {
      this.contentEl.createDiv({
        cls: "okf-dashboard__muted",
        text: "这是系统必需来源，可以暂停或恢复，但不能从 Dashboard 移除。",
      });
    }
  }

  private async toggle(
    source: FeedSubscriptionManagementSource,
    button: HTMLButtonElement,
  ): Promise<void> {
    const revision = this.page?.registry_revision;
    if (!revision || this.busy) {
      this.transientError("当前没有可用于安全修改的订阅版本，请重新打开设置后再试。");
      return;
    }
    this.busy = true;
    button.disabled = true;
    const enabling = !source.enabled;
    button.setText(enabling ? "正在恢复…" : "正在暂停…");
    try {
      const request = {
        expected_registry_revision: revision,
        idempotency_key: createFeedSubscriptionIdempotencyKey(),
      };
      const result = enabling
        ? await this.actions.enable(source.source_id, request)
        : await this.actions.disable(source.source_id, request);
      this.page = { ...this.page!, registry_revision: result.registry_revision };
      this.source = result.source;
      await this.actions.changed();
      this.render();
    } catch (error) {
      this.transientError(feedSubscriptionErrorMessage(error));
      button.disabled = false;
      button.setText(enabling ? "恢复订阅" : "暂停订阅");
    } finally {
      this.busy = false;
    }
  }

  private renderRemoveConfirmation(source: FeedSubscriptionManagementSource): void {
    this.removeTransientResults();
    const warning = this.contentEl.createDiv({
      cls: "okf-feed-subscription-settings__danger",
      attr: { role: "alertdialog", "aria-label": "确认移除订阅" },
    });
    warning.createEl("strong", { text: "确认移除这个订阅？" });
    warning.createDiv({
      text: "移除后会停止抓取。已有历史的来源卡、Digest、阅读位置和判断结果都会保留，并标为“已移除”；尚无历史的空卡会消失。",
    });
    const actions = warning.createDiv({ cls: "okf-feed-subscription-modal__actions" });
    const cancel = actions.createEl("button", {
      text: "取消",
      cls: "okf-dashboard__ghost-action",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => warning.remove());
    const confirm = actions.createEl("button", {
      text: "确认移除，保留历史",
      cls: "okf-dashboard__danger-action",
      attr: { type: "button" },
    });
    confirm.addEventListener("click", () => void this.remove(source, confirm));
    confirm.focus();
  }

  private async remove(
    source: FeedSubscriptionManagementSource,
    button: HTMLButtonElement,
  ): Promise<void> {
    const revision = this.page?.registry_revision;
    if (!revision || this.busy) return;
    this.busy = true;
    button.disabled = true;
    button.setText("正在移除…");
    try {
      const result = await this.actions.remove(source.source_id, {
        expected_registry_revision: revision,
        idempotency_key: createFeedSubscriptionIdempotencyKey(),
        confirm: true,
      });
      this.page = { ...this.page!, registry_revision: result.registry_revision };
      this.source = undefined;
      await this.actions.changed();
      new Notice("订阅已移除；历史内容仍然保留");
      this.render();
    } catch (error) {
      this.transientError(feedSubscriptionErrorMessage(error));
      button.disabled = false;
      button.setText("确认移除，保留历史");
    } finally {
      this.busy = false;
    }
  }

  private fact(parent: HTMLElement, label: string, value: string): void {
    const item = parent.createDiv({ cls: "okf-feed-subscription-settings__fact" });
    item.createSpan({ text: label });
    item.createEl("strong", { text: value });
  }

  private removeTransientResults(): void {
    for (const selector of [
      ".okf-feed-subscription-settings__transient",
      ".okf-feed-subscription-settings__danger",
    ]) {
      for (const element of this.contentEl.querySelectorAll(selector)) element.remove();
    }
  }

  private transientError(message: string): void {
    this.removeTransientResults();
    this.contentEl.createDiv({
      cls: "okf-dashboard__inline-alert okf-feed-subscription-settings__transient",
      text: message,
      attr: { role: "alert" },
    });
  }

  private renderFailure(message: string, retry: () => void): void {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "okf-dashboard__inline-alert", text: message });
    const button = this.contentEl.createEl("button", {
      text: "重新读取",
      cls: "okf-dashboard__secondary-action",
      attr: { type: "button" },
    });
    button.addEventListener("click", retry);
  }
}

function managementStatusLabel(source: FeedSubscriptionManagementSource): string {
  if (source.status === "error") return "更新异常";
  if (source.status === "removed") return "已移除";
  return source.enabled ? "已启用" : "已暂停";
}

function formatSubscriptionTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function feedSubscriptionErrorMessage(error: unknown): string {
  if (error instanceof FeedHttpError) {
    if (error.code === "unsafe_url") {
      return "这个地址不安全或不受支持，请使用公开的 HTTP 或 HTTPS 地址。";
    }
    if (["discovery_failed", "detection_failed", "feed_detection_failed"].includes(error.code ?? "")) {
      return "没有检测到可订阅的内容，请检查地址或手动选择正确的来源类型。";
    }
    if (["source_exists", "duplicate_source"].includes(error.code ?? "")) {
      return "这个订阅已经存在，请在对应来源卡中打开设置。";
    }
    if (error.code === "source_name_conflict") {
      return "来源名称已存在，请修改名称后重新检测。";
    }
    if (error.code === "invalid_source_name") {
      return "来源名称不能使用保留标题、换行或 Markdown 标题符号，请修改后重新检测。";
    }
    if (error.code === "protected_source") {
      return "这是系统必需来源，不能移除；如需停用，可以暂停订阅。";
    }
    if (["preview_expired"].includes(error.code ?? "") || error.status === 410) {
      return "检测结果已过期，请返回后重新检测。";
    }
    if (
      [
        "revision_conflict",
        "registry_revision_conflict",
        "stale_preview",
        "stale_registry",
        "mirror_stale",
        "idempotency_conflict",
      ].includes(error.code ?? "") || error.status === 409
    ) {
      return "订阅设置已经发生变化；添加时请返回重新检测，管理现有来源时请重新打开设置。";
    }
    if (
      [
        "unconfigured",
        "remote_unavailable",
        "registry_unavailable",
        "lock_busy",
        "timeout",
      ].includes(error.code ?? "") ||
      error.status === 503
    ) {
      return "订阅服务尚未配置或暂时无法连接，请稍后重试。";
    }
    if (error.status === 422) {
      return "没有检测到可订阅的内容，请检查地址或手动选择正确的来源类型。";
    }
    if (error.status === 400) return "订阅地址或设置无效，请检查后重试。";
    if (error.status === 502) return "订阅服务返回了无法识别的结果，请稍后重试。";
    return error.publicMessage;
  }
  return error instanceof Error ? error.message : "订阅操作失败";
}

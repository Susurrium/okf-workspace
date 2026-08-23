import type { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FeedSubscriptionManagementPage,
  FeedSubscriptionManagementSource,
  FeedSubscriptionPreview,
  FeedSubscriptionSource,
} from "../src/feeds/types.js";
import { FeedHttpError } from "../src/feeds/service.js";
import {
  FeedSubscriptionAddModal,
  FeedSubscriptionSettingsModal,
  feedSubscriptionErrorMessage,
} from "../src/plugin/feed-subscription-modal.js";
import { Notice, TestElement } from "./obsidian-runtime.js";

function rootOf(modal: FeedSubscriptionAddModal | FeedSubscriptionSettingsModal): TestElement {
  return modal.contentEl as unknown as TestElement;
}

function elementById(root: TestElement, id: string): TestElement {
  const element = root.descendants().find((candidate) => candidate.attributes.get("id") === id);
  if (!element) throw new Error(`Missing test element #${id}`);
  return element;
}

function buttonWithText(root: TestElement, text: string): TestElement {
  const button = root.descendants().find((candidate) =>
    candidate.tagName === "button" && candidate.textContent === text
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

function submitCurrentForm(root: TestElement): void {
  const form = root.descendants().find((candidate) => candidate.tagName === "form");
  if (!form) throw new Error("Missing subscription form");
  form.dispatch("submit", { preventDefault: vi.fn() });
}

function enter(root: TestElement, id: string, value: string, event = "input"): void {
  const element = elementById(root, id);
  element.value = value;
  element.dispatch(event);
}

function preview(overrides: Partial<FeedSubscriptionPreview> = {}): FeedSubscriptionPreview {
  return {
    preview_id: "preview-1",
    expires_at: "2026-08-23T12:30:00+08:00",
    registry_revision: "revision-1",
    detected_adapter: "rss",
    detected_from: "https://example.com/feed_name.xml",
    canonical_url: "https://example.com/feed_name.xml",
    url_redacted: false,
    source_id: "rss-example",
    source_name: "示例周刊",
    entries: [
      {
        title: "第一条",
        url: "https://example.com/first_item",
        published_at: "2026-08-23T08:00:00+08:00",
      },
      {
        title: "第二条",
        url: "https://example.com/second_item",
        published_at: null,
      },
      {
        title: "第三条",
        url: "https://example.com/third_item",
        published_at: null,
      },
    ],
    defaults: {
      include_existing: false,
      content_mode: "summary",
      content_max_chars: 12_000,
    },
    capabilities: {
      content_modes: ["summary", "full"],
      can_include_existing: true,
    },
    warnings: ["部分条目只有摘要"],
    existing_source_id: null,
    ...overrides,
  };
}

function managedSource(
  overrides: Partial<FeedSubscriptionManagementSource> = {},
): FeedSubscriptionManagementSource {
  return {
    source_id: "rss-example",
    source_name: "示例周刊",
    canonical_url: "https://example.com/feed_name.xml",
    url_redacted: false,
    adapter: "rss",
    enabled: true,
    required: false,
    added_at: "2026-08-23T08:00:00+08:00",
    content_mode: "summary",
    content_max_chars: 12_000,
    status: "enabled",
    last_success_at: null,
    last_error_at: null,
    last_error_type: null,
    last_error: null,
    ...overrides,
  };
}

function managementPage(
  source = managedSource(),
  overrides: Partial<FeedSubscriptionManagementPage> = {},
): FeedSubscriptionManagementPage {
  return {
    registry_revision: "revision-1",
    sources: [source],
    count: 1,
    mirror_updated_at: "2026-08-23T08:00:00+08:00",
    remote_status: "current",
    ...overrides,
  };
}

function projection(source = managedSource()): FeedSubscriptionSource {
  return {
    source_id: source.source_id,
    source_name: source.source_name,
    latest_issued_at: null,
    latest_digest_id: null,
    latest_revision: null,
    latest_item_count: 0,
    pending_decision_count: 0,
    edition_count: 0,
    native_section_counts: {},
    preview_items: [],
    status: "waiting",
    registry_managed: true,
    enabled: source.enabled,
    registry_status: source.status,
    canonical_url: source.canonical_url,
    url_redacted: source.url_redacted,
    adapter: source.adapter,
    required: source.required,
  };
}

describe("FeedSubscriptionAddModal", () => {
  beforeEach(() => {
    Notice.messages.length = 0;
  });

  it("supports keyboard form submission from detection through explicit configuration", async () => {
    const detected = preview();
    const previewAction = vi.fn(async () => detected);
    const confirmAction = vi.fn(async () => ({
      registry_revision: "revision-2",
      source: managedSource({ content_mode: "full" }),
      existing_items_marked_seen: 0,
      next_run_will_include_current: true,
    }));
    const confirmed = vi.fn();
    const modal = new FeedSubscriptionAddModal({} as App, {
      preview: previewAction,
      confirm: confirmAction,
      confirmed,
    });
    modal.open();
    const root = rootOf(modal);
    enter(root, "okf-subscription-url", "https://example.com/feed_name.xml");
    enter(root, "okf-subscription-name", "我的周刊");

    submitCurrentForm(root);

    await vi.waitFor(() => expect(previewAction).toHaveBeenCalledWith({
      url: "https://example.com/feed_name.xml",
      name: "我的周刊",
      adapter: "auto",
    }));
    await vi.waitFor(() => {
      expect(root.descendants().some((element) => element.textContent === "示例周刊")).toBe(true);
    });
    expect(root.descendants("okf-feed-subscription-preview__entry")).toHaveLength(3);
    expect(root.descendants().some((element) =>
      element.textContent === "https://example.com"
    )).toBe(true);
    expect(root.descendants().some((element) => element.tagName === "code")).toBe(false);

    enter(root, "okf-subscription-content-mode", "full", "change");
    enter(root, "okf-subscription-content-max", "12000");
    enter(root, "okf-subscription-include-existing", "true", "change");
    submitCurrentForm(root);

    await vi.waitFor(() => expect(confirmAction).toHaveBeenCalledOnce());
    expect(confirmAction).toHaveBeenCalledWith({
      preview_id: "preview-1",
      expected_registry_revision: "revision-1",
      idempotency_key: expect.stringMatching(/^dashboard-/u),
      include_existing: true,
      content_mode: "full",
      content_max_chars: 12_000,
    });
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledOnce());
  });

  it("blocks confirmation when detection reports an existing source", async () => {
    const confirmAction = vi.fn();
    const modal = new FeedSubscriptionAddModal({} as App, {
      preview: vi.fn(async () => preview({ existing_source_id: "rss-example" })),
      confirm: confirmAction,
      confirmed: vi.fn(),
    });
    modal.open();
    const root = rootOf(modal);
    enter(root, "okf-subscription-url", "https://example.com/feed_name.xml");

    submitCurrentForm(root);

    await vi.waitFor(() => {
      expect(root.descendants().some((element) => element.textContent.includes("已经存在")))
        .toBe(true);
    });
    expect(root.descendants().some((element) => element.textContent === "确认添加")).toBe(false);
    expect(root.descendants().filter((element) => element.tagName === "form")).toHaveLength(0);
    buttonWithText(root, "关闭").click();
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("preserves input and focuses the optional source name after a name conflict", async () => {
    const previewAction = vi.fn(async () => {
      throw new FeedHttpError(409, JSON.stringify({
        detail: {
          code: "source_name_conflict",
          message: "conflict",
          retryable: false,
        },
      }));
    });
    const modal = new FeedSubscriptionAddModal({} as App, {
      preview: previewAction,
      confirm: vi.fn(),
      confirmed: vi.fn(),
    });
    modal.open();
    const root = rootOf(modal);
    const url = "https://example.com/another-feed.xml";
    enter(root, "okf-subscription-url", url);
    enter(root, "okf-subscription-name", "重复名称");

    submitCurrentForm(root);

    await vi.waitFor(() => {
      expect(root.descendants().some((element) =>
        element.textContent === "来源名称已存在，请修改名称后重新检测。"
      )).toBe(true);
    });
    expect(elementById(root, "okf-subscription-url").value).toBe(url);
    const name = elementById(root, "okf-subscription-name");
    expect(name.value).toBe("重复名称");
    expect(name.attributes.get("aria-invalid")).toBe("true");
    expect(name.focusCount).toBe(1);

    enter(root, "okf-subscription-name", "新的来源名称");
    expect(name.attributes.has("aria-invalid")).toBe(false);
  });

  it("focuses the source name after the remote rejects an unsafe name", async () => {
    const previewAction = vi.fn(async () => {
      throw new FeedHttpError(422, JSON.stringify({
        detail: {
          code: "invalid_source_name",
          message: "invalid",
          retryable: false,
        },
      }));
    });
    const modal = new FeedSubscriptionAddModal({} as App, {
      preview: previewAction,
      confirm: vi.fn(),
      confirmed: vi.fn(),
    });
    modal.open();
    const root = rootOf(modal);
    enter(root, "okf-subscription-url", "https://example.com/feed.xml");
    enter(root, "okf-subscription-name", "# 注入标题");

    submitCurrentForm(root);

    await vi.waitFor(() => {
      expect(root.descendants().some((element) =>
        element.textContent.includes("来源名称不能使用保留标题")
      )).toBe(true);
    });
    const name = elementById(root, "okf-subscription-name");
    expect(name.attributes.get("aria-invalid")).toBe("true");
    expect(name.focusCount).toBe(1);
  });

  it("shows only the redacted preview URL after detecting a private feed address", async () => {
    const privateUrl = "https://reader:credential@example.com/private/secret-feed.xml?token=secret-token#private";
    const previewAction = vi.fn(async () => preview({
      detected_from: "rss",
      canonical_url: privateUrl,
      url_redacted: true,
    }));
    const modal = new FeedSubscriptionAddModal({} as App, {
      preview: previewAction,
      confirm: vi.fn(),
      confirmed: vi.fn(),
    });
    modal.open();
    const root = rootOf(modal);
    enter(root, "okf-subscription-url", privateUrl);

    submitCurrentForm(root);

    await vi.waitFor(() => expect(previewAction).toHaveBeenCalledWith({
      url: privateUrl,
      adapter: "auto",
    }));
    await vi.waitFor(() => {
      expect(root.descendants().some((element) =>
        element.textContent === "https://example.com"
      )).toBe(true);
    });
    expect(root.descendants().some((element) => element.textContent.includes("secret-token")))
      .toBe(false);
    expect(root.descendants().some((element) => element.value.includes("secret-token")))
      .toBe(false);
    expect(root.descendants().some((element) =>
      element.textContent.includes("来源域名只用于辨识来源")
    ))
      .toBe(true);
    for (const secret of ["credential", "private", "secret-feed", "secret-token"]) {
      expect(root.descendants().some((element) => element.textContent.includes(secret))).toBe(false);
      expect(root.descendants().some((element) => element.value.includes(secret))).toBe(false);
    }
  });

  it("honors a one-time source whose detected current content is mandatory", async () => {
    const confirmAction = vi.fn(async () => ({
      registry_revision: "revision-2",
      source: managedSource({ adapter: "github_repository" }),
      existing_items_marked_seen: 0,
      next_run_will_include_current: true,
    }));
    const modal = new FeedSubscriptionAddModal({} as App, {
      preview: vi.fn(async () => preview({
        detected_adapter: "github_repository",
        defaults: {
          include_existing: true,
          content_mode: "summary",
          content_max_chars: 12_000,
        },
        capabilities: {
          content_modes: ["summary", "full"],
          can_include_existing: false,
        },
      })),
      confirm: confirmAction,
      confirmed: vi.fn(),
    });
    modal.open();
    const root = rootOf(modal);
    enter(root, "okf-subscription-url", "https://github.com/example/repository");
    submitCurrentForm(root);

    await vi.waitFor(() => {
      expect(root.descendants().some((element) =>
        element.textContent.includes("固定包含当前检测到的内容")
      ))
        .toBe(true);
    });
    expect(root.descendants().some((element) =>
      element.attributes.get("id") === "okf-subscription-include-existing"
    )).toBe(false);
    submitCurrentForm(root);

    await vi.waitFor(() => expect(confirmAction).toHaveBeenCalledOnce());
    expect(confirmAction).toHaveBeenCalledWith(expect.objectContaining({
      include_existing: true,
      content_mode: "summary",
    }));
  });

  it("does not submit full mode with a blank advanced limit", async () => {
    const confirmAction = vi.fn();
    const modal = new FeedSubscriptionAddModal({} as App, {
      preview: vi.fn(async () => preview()),
      confirm: confirmAction,
      confirmed: vi.fn(),
    });
    modal.open();
    const root = rootOf(modal);
    enter(root, "okf-subscription-url", "https://example.com/feed.xml");
    submitCurrentForm(root);
    await vi.waitFor(() => {
      expect(root.descendants().some((element) => element.textContent === "确认添加")).toBe(true);
    });
    enter(root, "okf-subscription-content-mode", "full", "change");
    enter(root, "okf-subscription-content-max", "");

    submitCurrentForm(root);

    expect(confirmAction).not.toHaveBeenCalled();
    expect(root.descendants().some((element) => element.textContent.includes("100–20000")))
      .toBe(true);
  });
});

describe("Feed subscription error presentation", () => {
  it.each([
    [400, "unsafe_url", "这个地址不安全或不受支持"],
    [422, "discovery_failed", "没有检测到可订阅的内容"],
    [409, "revision_conflict", "订阅设置已经发生变化"],
    [503, "remote_unavailable", "订阅服务尚未配置或暂时无法连接"],
  ] as const)("maps %i %s without exposing raw structured details", (status, code, expected) => {
    const error = new FeedHttpError(status, JSON.stringify({
      detail: {
        code,
        message: "不要显示 https://private.example/?token=secret-token",
        retryable: status === 503,
      },
    }));

    const message = feedSubscriptionErrorMessage(error);

    expect(error.code).toBe(code);
    expect(error.retryable).toBe(status === 503);
    expect(error.message).not.toContain("{\"detail\"");
    expect(message).toContain(expected);
    expect(message).not.toContain("private.example");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("{\"detail\"");
  });
});

describe("FeedSubscriptionSettingsModal", () => {
  it("allows a required source to pause but never offers destructive removal", async () => {
    const source = managedSource({ required: true });
    const disable = vi.fn(async () => ({
      registry_revision: "revision-2",
      source: { ...source, enabled: false, status: "disabled" as const },
    }));
    const modal = new FeedSubscriptionSettingsModal({} as App, projection(source), {
      load: vi.fn(async () => managementPage(source)),
      enable: vi.fn(),
      disable,
      remove: vi.fn(),
      changed: vi.fn(),
    });
    modal.open();
    const root = rootOf(modal);
    await vi.waitFor(() => {
      expect(root.descendants().some((element) => element.textContent === "暂停订阅")).toBe(true);
    });
    expect(root.descendants().some((element) => element.textContent === "移除订阅…")).toBe(false);
    expect(root.descendants().some((element) => element.textContent.includes("可以暂停或恢复")))
      .toBe(true);

    buttonWithText(root, "暂停订阅").click();

    await vi.waitFor(() => expect(disable).toHaveBeenCalledOnce());
    expect(disable).toHaveBeenCalledWith("rss-example", {
      expected_registry_revision: "revision-1",
      idempotency_key: expect.stringMatching(/^dashboard-/u),
    });
  });

  it("treats a redacted existing URL as display-only and never offers replay", async () => {
    const source = managedSource({
      canonical_url: "https://reader:credential@example.com/private/secret-feed.xml?token=secret-token#private",
      url_redacted: true,
    });
    const modal = new FeedSubscriptionSettingsModal({} as App, projection(source), {
      load: vi.fn(async () => managementPage(source)),
      enable: vi.fn(),
      disable: vi.fn(),
      remove: vi.fn(),
      changed: vi.fn(),
    });
    modal.open();
    const root = rootOf(modal);

    await vi.waitFor(() => {
      expect(root.descendants().some((element) =>
        element.textContent.includes("来源域名只用于辨识来源")
      )).toBe(true);
    });
    expect(root.descendants().some((element) =>
      element.tagName === "button" && element.textContent.includes("重新检测")
    ))
      .toBe(false);
    expect(root.descendants().some((element) => element.textContent === "https://example.com"))
      .toBe(true);
    for (const secret of ["credential", "private", "secret-feed", "secret-token", "token="]) {
      expect(root.descendants().some((element) => element.textContent.includes(secret))).toBe(false);
      expect(root.descendants().some((element) => element.value.includes(secret))).toBe(false);
    }
    expect(JSON.stringify((modal as unknown as { projection: unknown }).projection))
      .not.toContain("secret");
  });

  it("disables mutations for a stale registry mirror without replaying a display URL", async () => {
    const source = managedSource();
    const disable = vi.fn();
    const remove = vi.fn();
    const modal = new FeedSubscriptionSettingsModal({} as App, projection(source), {
      load: vi.fn(async () => managementPage(source, { remote_status: "stale" })),
      enable: vi.fn(),
      disable,
      remove,
      changed: vi.fn(),
    });
    modal.open();
    const root = rootOf(modal);
    await vi.waitFor(() => {
      expect(root.descendants().some((element) => element.textContent === "暂停订阅")).toBe(true);
    });
    const toggle = buttonWithText(root, "暂停订阅");
    const removeButton = buttonWithText(root, "移除订阅…");
    expect(toggle.disabled).toBe(true);
    expect(removeButton.disabled).toBe(true);
    expect(root.descendants().some((element) => element.textContent.includes("暂不可用")))
      .toBe(true);

    toggle.click();
    removeButton.click();
    expect(disable).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(root.descendants().some((element) =>
      element.tagName === "button" && element.textContent.includes("重新检测")
    ))
      .toBe(false);
  });

  it("requires a second explicit step before removal", async () => {
    const source = managedSource();
    const remove = vi.fn(async () => ({
      registry_revision: "revision-2",
      source_id: source.source_id,
      removed: true as const,
      historical_state_retained: true as const,
    }));
    const changed = vi.fn();
    const modal = new FeedSubscriptionSettingsModal({} as App, projection(source), {
      load: vi.fn(async () => managementPage(source)),
      enable: vi.fn(),
      disable: vi.fn(),
      remove,
      changed,
    });
    modal.open();
    const root = rootOf(modal);
    await vi.waitFor(() => {
      expect(root.descendants().some((element) => element.textContent === "移除订阅…")).toBe(true);
    });
    expect(remove).not.toHaveBeenCalled();

    buttonWithText(root, "移除订阅…").click();
    expect(remove).not.toHaveBeenCalled();
    expect(root.descendants().some((element) => element.textContent.includes("已有历史的来源卡")))
      .toBe(true);
    expect(root.descendants().some((element) => element.textContent.includes("空卡会消失")))
      .toBe(true);
    buttonWithText(root, "确认移除，保留历史").click();

    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith("rss-example", {
      expected_registry_revision: "revision-1",
      idempotency_key: expect.stringMatching(/^dashboard-/u),
      confirm: true,
    });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(Notice.messages).toContain("订阅已移除；历史内容仍然保留");
  });
});

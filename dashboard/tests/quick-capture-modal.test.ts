import type { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QuickCaptureModal } from "../src/plugin/quick-capture-modal.js";
import { Notice, TestElement } from "./obsidian-runtime.js";

function textareaIn(modal: QuickCaptureModal): TestElement {
  const root = modal.contentEl as unknown as TestElement;
  const textarea = root.descendants().find((element) => element.tagName === "textarea");
  if (!textarea) throw new Error("Quick Capture textarea was not rendered");
  return textarea;
}

function buttonWithText(modal: QuickCaptureModal, text: string): TestElement {
  const root = modal.contentEl as unknown as TestElement;
  const button = root.descendants().find((element) =>
    element.tagName === "button" && element.textContent === text
  );
  if (!button) throw new Error(`Quick Capture button was not rendered: ${text}`);
  return button;
}

function enterContent(textarea: TestElement, value: string): void {
  textarea.value = value;
  textarea.dispatch("input");
}

function pressCtrlEnter(textarea: TestElement): void {
  textarea.dispatch("keydown", {
    key: "Enter",
    ctrlKey: true,
    preventDefault: vi.fn(),
  } as unknown as Event);
}

describe("QuickCaptureModal", () => {
  beforeEach(() => {
    Notice.messages.length = 0;
  });

  it("keeps Ctrl+Enter as direct Inbox save on the first step", () => {
    const onSubmit = vi.fn(async () => undefined);
    const modal = new QuickCaptureModal({} as App, { courses: [], projects: [] }, {}, onSubmit);
    modal.open();
    const textarea = textareaIn(modal);
    enterContent(textarea, "暂时没有明确归属的想法");

    pressCtrlEnter(textarea);

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("暂时没有明确归属的想法", {});
  });

  it.each([
    {
      action: "关联 Course 后保存",
      option: "操作系统",
      notice: "请先选择具体 Course",
      relation: { course: "/learning/courses/os/course.md" },
      contexts: {
        courses: [{ title: "操作系统", path: "learning/courses/os/course.md" }],
        projects: [],
      },
    },
    {
      action: "关联 Project 后保存",
      option: "个人知识工作区",
      notice: "请先选择具体 Project",
      relation: { project: "/projects/workspace/project.md" },
      contexts: {
        courses: [],
        projects: [{ title: "个人知识工作区", path: "projects/workspace/project.md" }],
      },
    },
  ])("requires a concrete context after choosing $action", ({ action, option, notice, relation, contexts }) => {
    const onSubmit = vi.fn(async () => undefined);
    const modal = new QuickCaptureModal({} as App, contexts, {}, onSubmit);
    modal.open();
    const textarea = textareaIn(modal);
    enterContent(textarea, "已经决定关联的想法");
    buttonWithText(modal, action).click();

    pressCtrlEnter(textarea);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([notice]);

    const contextButton = (modal.contentEl as unknown as TestElement).descendants().find((element) =>
      element.classes.has("okf-quick-capture-modal__context") &&
      element.children.some((child) => child.textContent === option)
    );
    expect(contextButton, `Missing concrete context button for ${option}`).toBeDefined();
    contextButton?.click();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("已经决定关联的想法", relation);
  });
});

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

  it("restores an unsent draft, keeps it on failure and clears it only after saving", async () => {
    const save = vi.fn();
    const submit = vi.fn(async () => { throw new Error("保存失败"); });
    const modal = new QuickCaptureModal({} as App, { courses: [], projects: [] }, {}, submit, { text: "尚未保存的想法", save });
    modal.open();
    expect(textareaIn(modal).value).toBe("尚未保存的想法");
    pressCtrlEnter(textareaIn(modal));
    await vi.waitFor(() => expect(Notice.messages).toContain("保存失败"));
    expect(save).not.toHaveBeenCalledWith("");
    modal.close();
    expect(save).toHaveBeenLastCalledWith("尚未保存的想法");
    const saved = new QuickCaptureModal({} as App, { courses: [], projects: [] }, {}, async () => undefined,
      { text: "尚未保存的想法", save });
    saved.open();
    pressCtrlEnter(textareaIn(saved));
    await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith(""));
  });

  it("selects both relations without submitting until the explicit save", () => {
    const onSubmit = vi.fn(async () => undefined);
    const modal = new QuickCaptureModal({} as App, {
      courses: [{ title: "操作系统", path: "learning/courses/os/course.md" }],
      projects: [{ title: "个人知识库", path: "projects/workspace/project.md" }],
    }, {}, onSubmit);
    modal.open();
    const textarea = textareaIn(modal);
    enterContent(textarea, "已经决定关联的想法");
    const selects = (modal.contentEl as unknown as TestElement).descendants().filter(item => item.tagName === "select");
    selects[0]!.value = "/learning/courses/os/course.md"; selects[0]!.dispatch("change");
    selects[1]!.value = "/projects/workspace/project.md"; selects[1]!.dispatch("change");
    expect(onSubmit).not.toHaveBeenCalled();
    buttonWithText(modal, "保存到收集箱").click();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("已经决定关联的想法", { course: "/learning/courses/os/course.md", project: "/projects/workspace/project.md" });
  });

  it("keeps a relation draft on close and clears one selected relation independently", () => {
    const onSubmit = vi.fn(async () => undefined);
    const saveRelation = vi.fn();
    const modal = new QuickCaptureModal({} as App, { courses: [], projects: [] }, {}, onSubmit,
      { text: "双重关联草稿", save: vi.fn(), relation: { course: "/learning/courses/os/course.md", project: "/projects/workspace/project.md" }, saveRelation });
    modal.open();
    const selects = (modal.contentEl as unknown as TestElement).descendants().filter(item => item.tagName === "select");
    expect(selects.map(item => item.value)).toEqual(["/learning/courses/os/course.md", "/projects/workspace/project.md"]);
    selects[0]!.value = ""; selects[0]!.dispatch("change");
    modal.close();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(saveRelation).toHaveBeenLastCalledWith({ project: "/projects/workspace/project.md" });
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  CAPTURE_ENTRY_ACTION_LABELS,
  filterCaptureContextOptions,
  normalizeCaptureRelation,
  relationVaultPath,
  routeCaptureUsingLinkedContext,
} from "../src/domain/capture-context.js";

describe("capture context", () => {
  it("normalizes canonical Course and Project relations", () => {
    expect(normalizeCaptureRelation({
      course: "learning\\courses\\cs61a\\course.md",
      project: "/projects/okf/project.md/",
    })).toEqual({
      course: "/learning/courses/cs61a/course.md",
      project: "/projects/okf/project.md",
    });
    expect(relationVaultPath("/projects/okf/project.md")).toBe("projects/okf/project.md");
  });

  it("rejects relations that do not identify the canonical context note", () => {
    expect(() => normalizeCaptureRelation({ course: "learning/courses/cs61a" }))
      .toThrow("Course 关联必须指向");
    expect(() => normalizeCaptureRelation({ project: "projects/okf/log.md" }))
      .toThrow("Project 关联必须指向");
  });

  it("uses the confirmed two-step labels and searches contexts by title or path", () => {
    expect(CAPTURE_ENTRY_ACTION_LABELS).toEqual([
      "直接保存到 Inbox",
      "关联 Course 后保存",
      "关联 Project 后保存",
    ]);
    const options = [
      { path: "learning/courses/cs61a/course.md", title: "计算机程序构造" },
      { path: "learning/courses/stat/course.md", title: "医学统计" },
    ];
    expect(filterCaptureContextOptions(options, "统计")).toEqual([options[1]]);
    expect(filterCaptureContextOptions(options, "cs61a")).toEqual([options[0]]);
  });

  it("uses an existing Capture relation immediately without opening a second selector", () => {
    const select = vi.fn();
    const organize = vi.fn();

    routeCaptureUsingLinkedContext("cs61a", select, organize);

    expect(organize).toHaveBeenCalledOnce();
    expect(organize).toHaveBeenCalledWith("cs61a");
    expect(select).not.toHaveBeenCalled();
  });

  it("opens context selection only when the Capture is not linked", () => {
    const organize = vi.fn();
    const select = vi.fn((onSelect: (slug: string) => void) => onSelect("workspace"));

    routeCaptureUsingLinkedContext(undefined, select, organize);

    expect(select).toHaveBeenCalledOnce();
    expect(organize).toHaveBeenCalledOnce();
    expect(organize).toHaveBeenCalledWith("workspace");
  });
});

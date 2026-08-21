import { describe, expect, it } from "vitest";

import {
  normalizeCaptureRelation,
  relationVaultPath,
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
});

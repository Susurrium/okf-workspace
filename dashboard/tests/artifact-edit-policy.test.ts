import { describe, expect, it, vi } from "vitest";

import { ArtifactEditPolicy } from "../src/application/artifact-edit-policy.js";

describe("ArtifactEditPolicy", () => {
  it("routes the only generic Project property action through the Project service", async () => {
    const setProjectStatus = vi.fn().mockResolvedValue({ path: "projects/demo/project.md" });
    const policy = new ArtifactEditPolicy({ setProjectStatus });

    await expect(policy.mutate({
      kind: "frontmatter",
      path: "projects/demo/project.md",
      artifactType: "Project",
      property: "project_status",
      value: "paused",
    })).resolves.toMatchObject({ outcome: "handled" });
    expect(setProjectStatus).toHaveBeenCalledWith("projects/demo/project.md", "paused");
  });

  it("prevents generic edits and moves from breaking managed contracts", async () => {
    const policy = new ArtifactEditPolicy({ setProjectStatus: vi.fn() });

    await expect(policy.mutate({
      kind: "frontmatter",
      path: "sources/records/web/shared.md",
      artifactType: "Source",
      property: "uses",
      value: [],
    })).resolves.toMatchObject({ outcome: "deny" });
    await expect(policy.mutate({
      kind: "move",
      path: "projects/demo/project.md",
      artifactType: "Project",
      targetPath: "archive/project.md",
    })).resolves.toMatchObject({ outcome: "deny" });
    await expect(policy.mutate({
      kind: "move",
      path: "notes/free.md",
      artifactType: "Note",
      targetPath: "archive/free.md",
    })).resolves.toEqual({ outcome: "allow" });
  });
});

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { parse, serialize, workbenchCompatibilityMessage } from "../apex/src/parser.js";
import { registerSectionDefinition } from "../apex/src/section-registry.js";

function frontmatter(markdown: string): Record<string, unknown> {
  const end = markdown.indexOf("---", 3);
  return parseYaml(markdown.slice(3, end)) as Record<string, unknown>;
}

describe("Apex workbench format", () => {
  it("warns visibly when a board comes from a newer schema", () => {
    expect(workbenchCompatibilityMessage(1)).toBeUndefined();
    expect(workbenchCompatibilityMessage(99)).toContain("更高格式版本 99");
  });

  it("keeps stable IDs, duplicate-name bodies, unknown fields, and free prose", () => {
    const source = `---
dashboard: true
workbench_schema: 99
future_root:
  enabled: true
banner:
  quote: hello
  author: tester
  future_banner: retained
columns:
  - id: alpha
    name: Same
    color: "#111111"
    type: memo
    future_column:
      value: one
  - id: beta
    name: Same
    color: "#222222"
    type: workspace-future
    customConfig:
      nested: retained
---
Board introduction that Apex did not previously preserve.

## Same
<!-- okf-section:alpha -->
Free prose before cards.

### Card A
body A

## Same
<!-- okf-section:beta -->
Opaque future section body.
- [ ] must remain byte-visible
`;

    const data = parse(source);
    expect(data.columns.map((column) => column.id)).toEqual(["alpha", "beta"]);
    expect(data.bodyPreamble).toContain("Board introduction");
    expect(data.columns[0]?.leadingContent).toBe("Free prose before cards.");
    expect(data.columns[1]?.rawContent).toContain("Opaque future section body");

    data.columns = [data.columns[1]!, data.columns[0]!];
    data.columns[1]!.name = "Renamed";
    const saved = serialize(data);
    const reparsed = parse(saved);
    const savedFrontmatter = frontmatter(saved);
    const savedColumns = savedFrontmatter.columns as Array<Record<string, unknown>>;

    expect(reparsed.workbenchSchema).toBe(99);
    expect(reparsed.columns.map((column) => column.id)).toEqual(["beta", "alpha"]);
    expect(reparsed.columns.map((column) => column.name)).toEqual(["Same", "Renamed"]);
    expect(reparsed.columns[0]?.rawContent).toContain("must remain byte-visible");
    expect(reparsed.columns[1]?.leadingContent).toBe("Free prose before cards.");
    expect(savedFrontmatter.future_root).toEqual({ enabled: true });
    expect((savedFrontmatter.banner as Record<string, unknown>).future_banner).toBe("retained");
    expect(savedColumns[0]?.customConfig).toEqual({ nested: "retained" });
    expect(savedColumns[1]?.future_column).toEqual({ value: "one" });
  });

  it("assigns distinct persistent IDs when a legacy board repeats section names", () => {
    const legacy = `---
dashboard: true
columns:
  - name: Same
    color: red
    type: memo
  - name: Same
    color: blue
    type: memo
---
## Same
### First
one
## Same
### Second
two
`;

    const data = parse(legacy);
    expect(data.columns[0]?.id).toBeTruthy();
    expect(data.columns[1]?.id).toBeTruthy();
    expect(data.columns[0]?.id).not.toBe(data.columns[1]?.id);

    const saved = serialize(data);
    expect(saved).toContain(`<!-- okf-section:${data.columns[0]?.id} -->`);
    expect(saved).toContain(`<!-- okf-section:${data.columns[1]?.id} -->`);
  });

  it("round-trips registered section config without treating its body as opaque", () => {
    const unregister = registerSectionDefinition({
      type: "workspace-projects",
      icon: "folder-kanban",
      label: "项目（OKF）",
      defaultName: "项目",
      render: () => undefined,
    });
    try {
      const data = parse(`---
dashboard: true
columns:
  - id: project-active
    name: 项目
    type: workspace-projects
    config:
      statuses: [active, paused]
---
## 项目
<!-- okf-section:project-active -->
`);

      expect(data.columns[0]?.extensionConfig).toEqual({ statuses: ["active", "paused"] });
      expect(data.columns[0]?.rawContent).toBeUndefined();

      const saved = serialize(data);
      expect(parse(saved).columns[0]?.extensionConfig).toEqual({ statuses: ["active", "paused"] });
    } finally {
      unregister();
    }
  });
});

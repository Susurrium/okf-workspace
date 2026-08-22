import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const styles = readFileSync(
  fileURLToPath(new URL("../styles.css", import.meta.url)),
  "utf8",
);

describe("Dashboard global styles", () => {
  it("keeps native note Properties visible while hiding only the duplicate inline title", () => {
    expect(styles).toContain(
      '.workspace-leaf-content[data-type="markdown"] .inline-title {',
    );
    expect(styles).not.toMatch(/\.metadata-container\s*\{[^}]*display:\s*none/iu);
  });

  it("left-aligns every descriptive action regardless of its text length", () => {
    expect(styles).toMatch(
      /button\.okf-action-panel__action\s*\{[^}]*justify-content:\s*flex-start/isu,
    );
    expect(styles).toMatch(
      /\.okf-action-panel__copy\s*\{[^}]*flex:\s*1 1 auto[^}]*text-align:\s*left/isu,
    );
  });

  it("uses one responsive Feed surface for daily updates and subscription history", () => {
    expect(styles).toMatch(
      /\.okf-feed-shelf--daily\s*\{[^}]*grid-template-columns:\s*repeat\(3,/isu,
    );
    expect(styles).toContain(".okf-feed-project--reading");
    expect(styles).toContain(".okf-reading-feed__scroll");
    expect(styles).toContain(".okf-feed-digest__item.is-full");
    expect(styles).toMatch(
      /@container\s*\(max-width:\s*1250px\)[\s\S]*?\.okf-feed-shelf--daily\s*>\s*:last-child\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/iu,
    );
  });
});

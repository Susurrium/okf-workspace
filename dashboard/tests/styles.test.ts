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

  it("uses full-width responsive action, daily update, and source-card grids", () => {
    expect(styles).toMatch(
      /\.okf-today-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/isu,
    );
    expect(styles).toMatch(
      /\.okf-today-action-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.35fr\)\s*minmax\(0,\s*\.75fr\)\s*minmax\(0,\s*1fr\)/isu,
    );
    expect(styles).toMatch(
      /\.okf-feed-shelf--daily\s*\{[^}]*grid-template-columns:\s*repeat\(3,/isu,
    );
    expect(styles).toMatch(
      /\.okf-feed-shelf--daily \.okf-feed-project__scroll\s*\{[^}]*height:\s*auto[^}]*overflow:\s*visible/isu,
    );
    expect(styles).toMatch(
      /\.okf-reading-source-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/isu,
    );
    expect(styles).toContain(".okf-reading-source-card");
    expect(styles).toContain(".okf-feed-digest__item.is-full");
    expect(styles).toMatch(
      /@container\s*\(max-width:\s*1119px\)[\s\S]*?\.okf-feed-shelf--daily\s*>\s*:last-child\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/iu,
    );
    expect(styles).toMatch(
      /@container\s*\(max-width:\s*1179px\)[\s\S]*?\.okf-reading-source-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/iu,
    );
    expect(styles).toMatch(
      /@container\s*\(max-width:\s*759px\)[\s\S]*?\.okf-reading-source-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/iu,
    );
  });
});

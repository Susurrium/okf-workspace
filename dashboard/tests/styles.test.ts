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
      /\.okf-feed-shelf--daily,\s*\.okf-reading-source-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/isu,
    );
    expect(styles).toMatch(
      /\.okf-feed-card--scrollable \.okf-feed-card__body\s*\{[^}]*height:\s*clamp\([^}]*overflow-y:\s*auto/isu,
    );
    expect(styles).toContain(".okf-feed-card__header");
    expect(styles).toContain(".okf-feed-card__body");
    expect(styles).toContain(".okf-feed-card__footer");
    expect(styles).toContain(".okf-reading-source-card");
    expect(styles).toContain(".okf-feed-digest__item.is-full");
    expect(styles).toMatch(
      /@container\s*\(max-width:\s*1179px\)[\s\S]*?\.okf-feed-shelf--daily,\s*\.okf-reading-source-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/iu,
    );
    expect(styles).toMatch(
      /@container\s*\(max-width:\s*759px\)[\s\S]*?\.okf-reading-source-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/iu,
    );
  });

  it("keeps subscription states readable and management forms keyboard/mobile friendly", () => {
    expect(styles).toContain(".okf-feed-subscription-status.is-waiting");
    expect(styles).toContain(".okf-reading-source-card__empty");
    expect(styles).toContain(".okf-workflow-modal select:focus-visible,");
    expect(styles).toMatch(
      /\.okf-dashboard button:focus-visible,[\s\S]*?\{[^}]*outline:\s*2px solid/iu,
    );
    expect(styles).toMatch(
      /\.okf-feed-subscription-modal\s*\{[^}]*width:\s*min\(680px,/isu,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*700px\)[\s\S]*?\.okf-feed-subscription-settings__facts\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/iu,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*700px\)[\s\S]*?\.okf-feed-subscription-modal__actions button,[\s\S]*?width:\s*100%/iu,
    );
  });
});

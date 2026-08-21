import { describe, expect, it } from "vitest";

import { DASHBOARD_VERSION } from "../src/version";

describe("dashboard scaffold", () => {
  it("exposes a semver version", () => {
    expect(DASHBOARD_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

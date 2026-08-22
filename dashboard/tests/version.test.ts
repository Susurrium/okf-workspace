import { describe, expect, it } from "vitest";

import { DASHBOARD_VERSION } from "../src/version";

describe("dashboard scaffold", () => {
  it("exposes a semver version", () => {
    expect(DASHBOARD_VERSION).toBe("1.10.0");
  });
});

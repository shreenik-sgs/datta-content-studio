import { describe, expect, it } from "vitest";
import { distributionFeatureEnabled, distributionStage } from "./config";

describe("DS-DIST-R0 web gate", () => {
  it("DS-DIST-R0-06 treats missing or invalid configuration as OFF", () => {
    expect(distributionStage(undefined)).toBe("OFF");
    expect(distributionStage("EVERYONE")).toBe("OFF");
    expect(distributionStage("TEST")).toBe("TEST");
  });

  it("DS-DIST-R0-06b requires an explicit enabled flag", () => {
    expect(distributionFeatureEnabled(undefined)).toBe(false);
    expect(distributionFeatureEnabled("false")).toBe(false);
    expect(distributionFeatureEnabled("true")).toBe(true);
  });
});

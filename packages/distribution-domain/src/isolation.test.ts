import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_QUEUE_PREFIX,
  DISTRIBUTION_STORAGE_PREFIXES,
  distributionAccess,
  distributionGate,
  distributionStorageKey,
  isDistributionQueue,
  nextContentState,
} from "./index";

describe("DS-DIST-R0 isolation rules", () => {
  it("DS-DIST-R0-01 defaults closed and only opens to the declared audience", () => {
    expect(distributionAccess(undefined, { isTest: true, isOperator: true })).toBe(false);
    expect(distributionAccess("OFF", { isTest: true, isOperator: true })).toBe(false);
    expect(distributionAccess("TEST", { isTest: false, isOperator: true })).toBe(false);
    expect(distributionAccess("TEST", { isTest: true, isOperator: true })).toBe(true);
    expect(distributionAccess("LIMITED", { isTest: false, isOperator: false })).toBe(false);
    expect(distributionAccess("LIMITED", { isTest: false, isOperator: true })).toBe(true);
  });

  it("DS-DIST-R0-01b requires both the feature switch and rollout stage", () => {
    const audience = { isTest: true, isOperator: true };
    expect(distributionGate({ featureEnabled: false, stage: "ON", audience })).toBe(false);
    expect(distributionGate({ featureEnabled: true, stage: "OFF", audience })).toBe(false);
    expect(distributionGate({ featureEnabled: true, stage: "TEST", audience })).toBe(true);
  });

  it("DS-DIST-R0-02 owns queue and object namespaces without colliding with core", () => {
    expect(DISTRIBUTION_QUEUE_PREFIX).toBe("distribution:");
    expect(isDistributionQueue("distribution:content.ingest")).toBe(true);
    expect(isDistributionQueue("distribution:")).toBe(false);
    expect(isDistributionQueue("distribution:anything")).toBe(false);
    expect(isDistributionQueue("credit-rollup")).toBe(false);
    expect(DISTRIBUTION_STORAGE_PREFIXES).toEqual({
      masters: "distribution/masters/",
      derivatives: "distribution/derivatives/",
    });
    expect(distributionStorageKey("masters", "2026/item.json")).toBe(
      "distribution/masters/2026/item.json",
    );
    expect(() => distributionStorageKey("masters", "../private.txt")).toThrow(
      "INVALID_STORAGE_KEY",
    );
  });

  it("DS-DIST-R0-03 permits only the governed content lifecycle", () => {
    expect(nextContentState("DRAFT", "CLEAR_RIGHTS")).toBe("RIGHTS_CLEARED");
    expect(nextContentState("RIGHTS_CLEARED", "APPROVE")).toBe("APPROVED");
    expect(() => nextContentState("DRAFT", "PUBLISH")).toThrow("INVALID_TRANSITION");
  });
});

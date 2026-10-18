import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_CAPABILITIES,
  distributionRoleCapabilities,
  hasDistributionCapability,
  isDistributionOperator,
  requireIndependentContentReview,
} from "./content";

describe("content creation and independent approval roles", () => {
  it("Content Curators create and cannot acquire review or publishing from legacy grants", () => {
    expect(distributionRoleCapabilities(["CONTENT_COORDINATOR"])).toEqual(["content.create"]);
    expect(
      distributionRoleCapabilities(["CONTENT_COORDINATOR"], DISTRIBUTION_CAPABILITIES),
    ).toEqual(["content.create"]);
  });
  it("only Content Approvers review and publish, without granting global administration", () => {
    expect(distributionRoleCapabilities(["CONTENT_APPROVER"], DISTRIBUTION_CAPABILITIES)).toEqual([
      "content.review",
      "content.publish",
    ]);
    expect(isDistributionOperator(["CONTENT_APPROVER"])).toBe(true);
    for (const role of ["TECH_SUPER_ADMIN", "SUPER_ADMIN"]) {
      expect(distributionRoleCapabilities([role])).toEqual([]);
      expect(distributionRoleCapabilities([role], DISTRIBUTION_CAPABILITIES)).toEqual([
        "channels.manage",
        "campaigns.manage",
        "analytics.view",
        "operations.manage",
      ]);
      expect(distributionRoleCapabilities([role, "CONTENT_APPROVER"])).toEqual([
        "content.review",
        "content.publish",
      ]);
    }
  });
  it("roles require an explicit combined assignment for self-review", () => {
    expect(distributionRoleCapabilities(["CONTENT_COORDINATOR", "CONTENT_APPROVER"])).toEqual([
      "content.create",
      "content.review",
      "content.publish",
    ]);
    for (const roles of [
      [],
      ["ADMIN_MODERATOR"],
      ["CIRCLE_COORDINATOR"],
      ["PRACTITIONER"],
      ["SRI_SWAMIJI"],
    ])
      expect(distributionRoleCapabilities(roles, DISTRIBUTION_CAPABILITIES)).toEqual([]);
    expect(() =>
      requireIndependentContentReview("same-person", ["first-person", "same-person"]),
    ).toThrow("INDEPENDENT_REVIEW_REQUIRED");
    expect(() =>
      requireIndependentContentReview(
        "same-person",
        ["same-person"],
        ["CONTENT_COORDINATOR", "CONTENT_APPROVER"],
      ),
    ).not.toThrow();
    for (const roles of [["CONTENT_COORDINATOR"], ["CONTENT_APPROVER"], ["SUPER_ADMIN"]])
      expect(() => requireIndependentContentReview("same-person", ["same-person"], roles)).toThrow(
        "INDEPENDENT_REVIEW_REQUIRED",
      );
    expect(() =>
      requireIndependentContentReview(
        "same-person",
        [],
        ["CONTENT_COORDINATOR", "CONTENT_APPROVER"],
      ),
    ).toThrow("INDEPENDENT_REVIEW_REQUIRED");
    expect(() =>
      requireIndependentContentReview("independent-approver", ["first-person", "second-person"]),
    ).not.toThrow();
    expect(() => requireIndependentContentReview("approver", [])).toThrow(
      "INDEPENDENT_REVIEW_REQUIRED",
    );
    expect(
      hasDistributionCapability(
        { id: "", isTest: true, roles: ["CONTENT_COORDINATOR"], locale: "en" },
        [],
        "content.create",
      ),
    ).toBe(false);
  });
});

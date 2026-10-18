import { describe, expect, it } from "vitest";
import {
  type ActivationPackageInput,
  type CanonicalDestinationEvidence,
  SOCIAL_PLACEMENTS,
  sameActivationDestination,
  validateActivationDestination,
} from "./activation-package";
import { type CtaDefinition, validateCtaDestination } from "./outreach";
const id = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-04T12:00:00.000Z";
const cta: CtaDefinition = {
  id,
  revision: 2,
  intent: "LEARN",
  copy: "Watch the complete discourse",
  language: "te",
  destination: { path: `/content/room/${id}`, requiresIdentity: true },
  fallback: { path: "/explore", requiresIdentity: false },
  approval: null,
};
const input: ActivationPackageInput = {
  channel: "instagram",
  copy: "Source-linked editorial caption.",
  promise: "FULL_DISCOURSE",
  intendedAccess: "AUTH_REQUIRED",
};
function evidence(): CanonicalDestinationEvidence {
  return {
    version: 2,
    isTest: true,
    checkedAt: now,
    flags: { tracked_social_deep_links: true, universal_content_landing: true },
    results: [
      {
        ...cta.destination,
        available: true,
        canonicalId: `room:${id}`,
        kind: "DISCOURSE",
        accessMode: "AUTH_REQUIRED",
        revision: "v1",
        reason: null,
      },
      {
        ...cta.fallback,
        available: true,
        canonicalId: "library",
        kind: "LIBRARY",
        accessMode: "PUBLIC",
        revision: "v1",
        reason: null,
      },
    ],
  };
}
describe("full social activation package", () => {
  it("supports 15+ placement labels without claiming additional provider adapters", () => {
    expect(SOCIAL_PLACEMENTS.length).toBeGreaterThanOrEqual(15);
    for (const channel of SOCIAL_PLACEMENTS)
      expect(
        validateActivationDestination({ ...input, channel }, cta, evidence(), now).destination.path,
      ).toBe(cta.destination.path);
  });
  it("requires exact server-tested canonical destination and an accessible configured fallback", () => {
    for (const update of [
      { available: false },
      { canonicalId: null },
      { revision: null },
      { path: "/home" },
      { accessMode: "RESTRICTED" as const },
    ]) {
      const value = evidence();
      value.results = value.results.map((result, index) =>
        index === 0 ? { ...result, ...update } : result,
      );
      expect(() => validateActivationDestination(input, cta, value, now)).toThrow(
        "DESTINATION_UNAVAILABLE",
      );
    }
    const value = evidence();
    value.results = value.results.map((result, index) => ({ ...result, available: index === 0 }));
    expect(() => validateActivationDestination(input, cta, value, now)).toThrow(
      "DESTINATION_UNAVAILABLE",
    );
  });
  it("refuses CTA promise/type and intended-public audience mismatches", () => {
    expect(() =>
      validateActivationDestination({ ...input, promise: "FULL_ALBUM" }, cta, evidence(), now),
    ).toThrow("CTA_DESTINATION_MISMATCH");
    expect(() =>
      validateActivationDestination(input, { ...cta, intent: "SHARE" }, evidence(), now),
    ).toThrow("CTA_DESTINATION_MISMATCH");
    expect(() =>
      validateActivationDestination({ ...input, intendedAccess: "PUBLIC" }, cta, evidence(), now),
    ).toThrow("DESTINATION_AUDIENCE_REFUSED");
  });
  it("fails closed on either flag OFF, stale checks and future clocks", () => {
    for (const key of ["tracked_social_deep_links", "universal_content_landing"] as const) {
      const value = evidence();
      value.flags[key] = false;
      expect(() => validateActivationDestination(input, cta, value, now)).toThrow(
        "FEATURE_UNAVAILABLE",
      );
    }
    for (const checkedAt of ["2026-10-04T11:59:29Z", "2026-10-04T12:00:03Z", "invalid"])
      expect(() =>
        validateActivationDestination(input, cta, { ...evidence(), checkedAt }, now),
      ).toThrow("DESTINATION_CHECK_STALE");
  });
  it("requires re-testing if the canonical object or access revision changes", () => {
    const tested = validateActivationDestination(input, cta, evidence(), now);
    expect(
      sameActivationDestination(tested, { ...tested, checkedAt: "2026-10-04T12:00:01Z" }),
    ).toBe(true);
    expect(
      sameActivationDestination(tested, {
        ...tested,
        destination: { ...tested.destination, revision: "v2" },
      }),
    ).toBe(false);
  });
  it("allows only normalized exact room/event/seva and library paths", () => {
    for (const path of [
      `/content/room/${id}`,
      `/content/event/${id}`,
      `/content/seva/${id}`,
      "/explore",
    ])
      expect(() => validateCtaDestination(path)).not.toThrow();
    for (const path of [
      `/content/room/${id}?next=https://evil.test`,
      `/content/room/${id}/../home`,
      "/content/room/missing",
      "/explore?user=private",
    ])
      expect(() => validateCtaDestination(path)).toThrow("UNSAFE_DESTINATION");
  });
});

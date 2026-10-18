import { describe, expect, it } from "vitest";
import { type TrackedLinkRecord, trackedLinkDecision } from "./tracked-links";
const trackedFixture: TrackedLinkRecord = {
  schemaVersion: 1,
  token: "A".repeat(43),
  isTest: true,
  sequence: 1,
  activationId: "11111111-1111-4111-8111-111111111111",
  activationRevision: 2,
  campaignId: "22222222-2222-4222-8222-222222222222",
  campaignRevision: 2,
  contentId: "33333333-3333-4333-8333-333333333333",
  sourceVersionId: "44444444-4444-4444-8444-444444444444",
  derivativeId: "55555555-5555-4555-8555-555555555555",
  derivativeRevision: 2,
  title: "Approved meditation",
  cta: {
    id: "66666666-6666-4666-8666-666666666666",
    revision: 2,
    intent: "MEDITATE",
    copy: "Meditate",
    language: "en",
    destination: { path: "/practice/flute-meditation", requiresIdentity: true },
    fallback: { path: "/practice/koti-parayana", requiresIdentity: true },
    approval: {
      decision: "APPROVED",
      revision: 2,
      reviewerId: "human-review",
      reviewedAt: "2026-09-29T12:00:00.000Z",
    },
  },
  language: "en",
  startsAt: "2026-09-29T12:00:00.000Z",
  endsAt: "2026-09-30T12:00:00.000Z",
  checkedAt: "2026-09-29T12:00:00.000Z",
  status: "ACTIVE",
  destinationAvailable: true,
};
describe("DS-DIST-R4 cached destination selection", () => {
  it("DS-DIST-R4-CACHE permits only fresh approved exact destinations", () => {
    expect(trackedLinkDecision(trackedFixture, "2026-09-29T12:00:29.000Z")).toMatchObject({
      destination: "/practice/flute-meditation",
      usedFallback: false,
      requiresIdentity: true,
    });
    expect(trackedLinkDecision(trackedFixture, "2026-09-29T12:00:30.001Z")).toMatchObject({
      destination: "/practice/koti-parayana",
      usedFallback: true,
    });
  });
  it("DS-DIST-R4-STOP falls back on terminal states, unavailable destination, schedule and clock ambiguity", () => {
    for (const changed of [
      { status: "STOPPED" },
      { status: "STALE" },
      { destinationAvailable: false },
      { checkedAt: "2026-09-29T12:00:02.000Z" },
      { startsAt: "2026-09-29T12:01:00.000Z" },
      { endsAt: "2026-09-29T11:59:00.000Z" },
    ] as Partial<TrackedLinkRecord>[])
      expect(
        trackedLinkDecision({ ...trackedFixture, ...changed }, "2026-09-29T12:00:00.000Z")
          .usedFallback,
      ).toBe(true);
  });
  it("DS-DIST-R4-CACHE refuses unapproved or external promise even for fallback", () => {
    expect(() =>
      trackedLinkDecision(
        { ...trackedFixture, cta: { ...trackedFixture.cta, approval: null } },
        trackedFixture.checkedAt,
      ),
    ).toThrow("CTA_NOT_APPROVED");
    expect(() =>
      trackedLinkDecision(
        {
          ...trackedFixture,
          cta: {
            ...trackedFixture.cta,
            destination: { path: "https://example.test/", requiresIdentity: false },
          },
        },
        trackedFixture.checkedAt,
      ),
    ).toThrow("UNSAFE_DESTINATION");
  });
});

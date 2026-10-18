import { describe, expect, it } from "vitest";
import {
  activationInputSchema,
  makeCtaCommandSchema,
  outreachCampaignInputSchema,
  trackedIntentSchema,
} from "./outreach";
const id = "0193fd85-5213-7510-8139-981af6339219";
describe("DS-DIST-R4 operator command boundaries", () => {
  it("DS-DIST-R4-CAMPAIGN disallows client approvals or Maha Sankalpa objects", () => {
    const draft = {
      name: "Flute",
      program: "sacred_flute",
      goal: "Practice",
      outcomes: ["PRACTICE_COMPLETED"],
      startsAt: "2026-09-29T00:00:00Z",
      endsAt: "2026-10-01T00:00:00Z",
      budgetMicros: 0,
    };
    expect(outreachCampaignInputSchema.parse(draft)).toEqual(draft);
    expect(() => outreachCampaignInputSchema.parse({ ...draft, kind: "MAHA_SANKALPA" })).toThrow();
    expect(() => outreachCampaignInputSchema.parse({ ...draft, approval: true })).toThrow();
  });
  it("DS-DIST-R4-DESTINATION applies the configured origin allowlist before storing a CTA", () => {
    const cta = {
      intent: "PARTICIPATE",
      copy: "Explore Seva",
      language: "en",
      destination: { path: "https://dattapeetham.org/pujas", requiresIdentity: false },
      fallback: { path: "/practice/koti-parayana", requiresIdentity: false },
    };
    expect(() => makeCtaCommandSchema([]).parse(cta)).toThrow();
    expect(makeCtaCommandSchema(["https://dattapeetham.org"]).parse(cta)).toEqual(cta);
    expect(
      makeCtaCommandSchema([]).parse({
        ...cta,
        destination: { path: "/home", requiresIdentity: true },
      }).destination.path,
    ).toBe("/home");
    expect(() =>
      makeCtaCommandSchema([]).parse({
        ...cta,
        destination: { path: "/practice/flute-meditation", requiresIdentity: true },
        fallback: { path: "/home", requiresIdentity: true },
      }),
    ).toThrow();
  });
  it("DS-DIST-R4-ACTIVATION requires all pinned revisions and rejects forged approval", () => {
    const draft = {
      campaignId: id,
      campaignRevision: 2,
      ctaId: id,
      ctaRevision: 2,
      derivativeId: id,
      derivativeRevision: 2,
      sourceVersionId: id,
      channelAccountId: id,
      channel: "youtube",
      scheduledAt: "2026-09-29T12:00:00Z",
    };
    expect(activationInputSchema.parse(draft)).toEqual(draft);
    expect(
      activationInputSchema.parse({ ...draft, channel: "manual_export", channelAccountId: null })
        .channelAccountId,
    ).toBeNull();
    expect(() => activationInputSchema.parse({ ...draft, channel: "manual_export" })).toThrow();
    expect(() => activationInputSchema.parse({ ...draft, channelAccountId: null })).toThrow();
    expect(() => activationInputSchema.parse({ ...draft, approval: true })).toThrow();
    expect(() => activationInputSchema.parse({ ...draft, ctaRevision: 0 })).toThrow();
  });
  it("DS-DIST-R4-INTENT carries only bounded destination attribution and no user identity", () => {
    const intent = {
      campaignId: id,
      contentId: id,
      ctaId: id,
      ctaRevision: 2,
      language: "te",
      destination: "/practice/flute-meditation",
    };
    expect(trackedIntentSchema.parse(intent)).toEqual(intent);
    expect(() => trackedIntentSchema.parse({ ...intent, email: "person@example.com" })).toThrow();
  });
});

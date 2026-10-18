import { describe, expect, it } from "vitest";
import {
  type ChannelActivation,
  type CtaDefinition,
  type OutreachCampaign,
  activationDispatchDecision,
  approveChannelActivation,
  approveCta,
  approveOutreachCampaign,
  createManualActivation,
  pauseOutreachCampaign,
  resolveTrackedIntent,
  reviseCta,
  reviseOutreachCampaign,
  stopChannelActivation,
  stopOutreachCampaign,
  validateCta,
  validateCtaDestination,
  validateOutreachCampaign,
} from "./index";
const now = "2026-09-29T12:00:00Z";
const review = { decision: "APPROVED" as const, reviewerId: "human", reviewedAt: now, revision: 2 };
const campaign: OutreachCampaign = {
  id: "outreach-1",
  kind: "OUTREACH",
  revision: 2,
  name: "Sacred flute",
  program: "sacred_flute",
  goal: "Help people begin a daily practice",
  outcomes: ["PRACTICE_COMPLETED"],
  startsAt: "2026-09-28T00:00:00Z",
  endsAt: "2026-10-01T00:00:00Z",
  budgetMicros: 100,
  status: "APPROVED",
  approval: review,
};
const cta: CtaDefinition = {
  id: "cta-1",
  revision: 2,
  intent: "MEDITATE",
  copy: "Meditate",
  language: "en",
  destination: { path: "/practice/flute-meditation", requiresIdentity: true },
  fallback: { path: "/practice/koti-parayana", requiresIdentity: false },
  approval: review,
};
const activation: ChannelActivation = {
  id: "a1",
  revision: 2,
  campaignId: campaign.id,
  campaignRevision: 2,
  ctaId: cta.id,
  ctaRevision: 2,
  derivativeId: "d1",
  derivativeRevision: 2,
  sourceVersionId: "v1",
  channelAccountId: "ch1",
  channel: "youtube",
  scheduledAt: "2026-09-29T10:00:00Z",
  status: "APPROVED",
  approval: review,
};
const dispatch = {
  activation,
  campaign,
  cta,
  derivative: { id: "d1", revision: 2, sourceVersionId: "v1", approval: review, withdrawn: false },
  channelAccount: { id: "ch1", channel: "youtube" as const, connected: true, emergencyStop: false },
  sourceRightsAllowed: true,
  audienceAllowed: true,
  now,
};
describe("DS-DIST-R4 exact destinations and activation governance", () => {
  it("DS-DIST-R4-DESTINATION blocks open redirects, traversal, unknown routes and unapproved origins", () => {
    expect(() => validateCtaDestination(cta.destination.path)).not.toThrow();
    expect(() =>
      validateCtaDestination("https://dattapeetham.org/pujas", ["https://dattapeetham.org"]),
    ).not.toThrow();
    for (const bad of [
      "/",
      "/practices",
      "//evil.example",
      "/practice/../admin",
      "/practice/%252e%252e/admin",
      "/practice/flute?redirect=https://evil.example",
      "javascript:alert(1)",
      "https://dattapeetham.org.evil.example/pujas",
      "https://user:secret@dattapeetham.org/pujas",
    ])
      expect(() => validateCtaDestination(bad, ["https://dattapeetham.org"])).toThrow(
        "UNSAFE_DESTINATION",
      );
  });
  it("DS-DIST-R4-CAMPAIGN separates outreach from Maha Sankalpa and invalidates edited approvals", () => {
    expect(() => validateOutreachCampaign(campaign)).not.toThrow();
    expect(() =>
      validateOutreachCampaign({ ...campaign, kind: "MAHA_SANKALPA" as "OUTREACH" }),
    ).toThrow("INVALID_OUTREACH_CAMPAIGN");
    const changed = reviseOutreachCampaign(campaign, 2, { goal: "A revised goal" });
    expect(changed).toMatchObject({ revision: 3, approval: null, status: "DRAFT" });
    expect(
      approveOutreachCampaign(changed, {
        expectedRevision: 3,
        reviewerId: "human",
        reviewedAt: now,
      }).approval?.revision,
    ).toBe(4);
    expect(() => reviseOutreachCampaign(campaign, 1, { name: "stale" })).toThrow(
      "REVISION_CONFLICT",
    );
  });
  it("DS-DIST-R4-INTENT preserves the precise practice and attribution across authentication", () => {
    const snapshot = {
      token: "opaque-server-token",
      campaignId: campaign.id,
      contentId: "content-1",
      cta,
      language: "te",
    };
    expect(
      resolveTrackedIntent({
        snapshot,
        currentCta: cta,
        destinationAvailable: true,
        hubAvailable: true,
        emergencyStop: false,
      }),
    ).toMatchObject({
      destination: cta.destination.path,
      requiresIdentity: true,
      usedFallback: false,
      intent: {
        campaignId: campaign.id,
        contentId: "content-1",
        ctaId: cta.id,
        ctaRevision: 2,
        language: "te",
        destination: cta.destination.path,
      },
    });
    for (const overrides of [
      { hubAvailable: false },
      { emergencyStop: true },
      { destinationAvailable: false },
      { currentCta: { ...cta, revision: 3 } },
    ])
      expect(
        resolveTrackedIntent({
          snapshot,
          currentCta: cta,
          destinationAvailable: true,
          hubAvailable: true,
          emergencyStop: false,
          ...overrides,
        }),
      ).toMatchObject({ destination: "/practice/koti-parayana", usedFallback: true });
  });
  it("DS-DIST-R4-DESTINATION needs human approval for copy or destination edits", () => {
    const changed = reviseCta(cta, 2, { copy: "Listen" });
    expect(changed).toMatchObject({ revision: 3, approval: null });
    expect(
      approveCta(changed, { expectedRevision: 3, reviewerId: "human", reviewedAt: now }).approval
        ?.revision,
    ).toBe(4);
    expect(() =>
      approveCta(
        { ...changed, fallback: changed.destination },
        { expectedRevision: 3, reviewerId: "human", reviewedAt: now },
      ),
    ).toThrow("INVALID_CTA");
  });
  it("DS-DIST-R4-ACTIVATION dispatches only all-current approved objects and valid rights", () => {
    expect(activationDispatchDecision(dispatch)).toEqual({ allowed: true });
    for (const patch of [
      { campaign: { ...campaign, revision: 3 } },
      { cta: { ...cta, revision: 3 } },
      { derivative: { ...dispatch.derivative, revision: 3 } },
      { sourceRightsAllowed: false },
      { audienceAllowed: false },
    ])
      expect(activationDispatchDecision({ ...dispatch, ...patch }).allowed).toBe(false);
  });
  it("DS-DIST-R4-STOP applies at activation, campaign and channel account with schedule boundaries", () => {
    for (const patch of [
      { activation: { ...activation, status: "STOPPED" as const } },
      { campaign: { ...campaign, status: "STOPPED" as const } },
      { channelAccount: { ...dispatch.channelAccount, emergencyStop: true } },
      { now: "2026-10-01T00:00:00Z" },
      { now: "2026-09-29T09:00:00Z" },
    ])
      expect(activationDispatchDecision({ ...dispatch, ...patch }).allowed).toBe(false);
  });
});

it("DS-DIST-R4-DESTINATION checks approved CTA paths again at dispatch and blocks external redirectors", () => {
  expect(() =>
    validateCtaDestination("https://dattapeetham.org/redirect?url=https://evil.example", [
      "https://dattapeetham.org",
    ]),
  ).toThrow("UNSAFE_DESTINATION");
  expect(
    activationDispatchDecision({
      ...dispatch,
      cta: { ...cta, destination: { path: "//evil.example", requiresIdentity: false } },
    }),
  ).toMatchObject({ allowed: false, reason: "CTA_NOT_APPROVED" });
});

it("DS-DIST-R4-DESTINATION uses the real Practices route only as an explicit destination, never generic fallback", () => {
  expect(() => validateCtaDestination("/home")).not.toThrow();
  expect(() => validateCtaDestination("/practices")).toThrow("UNSAFE_DESTINATION");
  expect(() =>
    validateCta({ ...cta, destination: { path: "/home", requiresIdentity: true } }),
  ).not.toThrow();
  expect(() =>
    validateCta({ ...cta, fallback: { path: "/home", requiresIdentity: true } }),
  ).toThrow("GENERIC_FALLBACK_REFUSED");
});
it("DS-DIST-R4-STOP paused campaigns need fresh review and stopped campaigns cannot reopen", () => {
  expect(pauseOutreachCampaign(campaign, 2)).toMatchObject({
    status: "PAUSED",
    revision: 3,
    approval: null,
  });
  expect(() => pauseOutreachCampaign({ ...campaign, status: "DRAFT" }, 2)).toThrow(
    "CAMPAIGN_NOT_APPROVED",
  );
  const stopped = stopOutreachCampaign(campaign, 2);
  expect(stopped).toMatchObject({ status: "STOPPED", revision: 3, approval: null });
  expect(() => reviseOutreachCampaign(stopped, 3, { name: "Restart" })).toThrow("CAMPAIGN_STOPPED");
  expect(() => stopOutreachCampaign(stopped, 3)).toThrow("CAMPAIGN_STOPPED");
  expect(() => pauseOutreachCampaign(campaign, 1)).toThrow("REVISION_CONFLICT");
});

it("DS-DIST-R4-MANUAL explicitly permits accountless Manual Export only", () => {
  const manual = {
    ...dispatch,
    activation: { ...activation, channel: "manual_export" as const, channelAccountId: null },
    channelAccount: null,
  };
  expect(activationDispatchDecision(manual)).toEqual({ allowed: true });
  expect(
    activationDispatchDecision({ ...manual, channelAccount: dispatch.channelAccount }),
  ).toMatchObject({ allowed: false, reason: "CHANNEL_UNAVAILABLE" });
  expect(activationDispatchDecision({ ...dispatch, channelAccount: null })).toMatchObject({
    allowed: false,
    reason: "CHANNEL_UNAVAILABLE",
  });
});

it("DS-DIST-R4-ACTIVATION binds manual drafts to versioned human decisions and terminal stops", () => {
  const input = { ...activation, channel: "manual_export" as const, channelAccountId: null };
  const draft = createManualActivation(input);
  expect(draft).toMatchObject({ revision: 1, status: "DRAFT", approval: null });
  const approved = approveChannelActivation(draft, {
    expectedRevision: 1,
    reviewerId: "reviewer",
    reviewedAt: "2026-09-29T12:00:00Z",
  });
  expect(approved).toMatchObject({ revision: 2, status: "APPROVED", approval: { revision: 2 } });
  expect(() =>
    approveChannelActivation(approved, {
      expectedRevision: 2,
      reviewerId: "reviewer",
      reviewedAt: "2026-09-29T12:00:00Z",
    }),
  ).toThrow("ACTIVATION_NOT_DRAFT");
  const stopped = stopChannelActivation(approved, 2);
  expect(stopped).toMatchObject({ revision: 3, status: "STOPPED", approval: null });
  expect(() => stopChannelActivation(stopped, 3)).toThrow("ACTIVATION_STOPPED");
  expect(() => createManualActivation({ ...input, channelAccountId: "fake" })).toThrow(
    "INVALID_ACTIVATION",
  );
  expect(() => createManualActivation({ ...input, scheduledAt: "bad" })).toThrow(
    "INVALID_ACTIVATION",
  );
});

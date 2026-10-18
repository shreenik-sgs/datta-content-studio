import { describe, expect, it } from "vitest";
import {
  type ChannelAdoption,
  type ChannelDispatchPolicy,
  type ChannelPublication,
  channelDispatchDecision,
  channelPublicationKey,
  claimChannelPublication,
  createChannelPublication,
  recordChannelOutcome,
  recoverChannelLease,
  requireSamePublication,
} from "./channel-publishing";
const now = "2026-10-03T12:00:00.000Z";
const adoption: ChannelAdoption = {
  channel: "telegram",
  accountId: "test-account",
  world: "TEST",
  enabled: true,
  officialCapabilityEvidence: "Synthetic contract",
  accountEligibilityEvidence: "Synthetic channel",
  contractTestEvidence: "Fake responses",
  authorizationExpiresAt: "2026-10-04T12:00:00.000Z",
  verifiedDestination: "-100123",
  allowedVisibility: ["public"],
};
const policy: ChannelDispatchPolicy = {
  accountId: "test-account",
  channel: "telegram",
  world: "TEST",
  destination: "-100123",
  visibility: "public",
  checkedAt: now,
  activationAllowed: true,
  emergencyStop: false,
  circuitOpen: false,
  quotaAvailable: true,
  audience: { kind: "PUBLIC_CHANNEL", authorized: true, authorizationId: "test-authorization" },
};
const created = () =>
  createChannelPublication({
    activationId: "test-activation",
    activationRevision: 3,
    accountId: "test-account",
    channel: "telegram",
    world: "TEST",
    payloadSha256: "a".repeat(64),
  });
const claim = (publication: ChannelPublication, attemptId = "attempt-1", at = now) =>
  claimChannelPublication({
    publication,
    expectedRevision: publication.revision,
    attemptId,
    now: at,
    adoption,
    policy: { ...policy, checkedAt: at },
  });
const outcome = (
  publication: ChannelPublication,
  value: Parameters<typeof recordChannelOutcome>[0]["outcome"],
  at = now,
) =>
  recordChannelOutcome({
    publication,
    expectedRevision: publication.revision,
    attemptId: publication.attemptId ?? "missing",
    outcome: value,
    now: at,
  });

describe("channel dispatch policy", () => {
  it("requires adoption evidence, matching world/account, unexpired authorization and a fresh decision", () => {
    expect(channelDispatchDecision(adoption, policy, now)).toEqual({ allowed: true });
    for (const change of [
      { enabled: false },
      { officialCapabilityEvidence: "" },
      { contractTestEvidence: "" },
      { accountEligibilityEvidence: "" },
      { authorizationExpiresAt: now },
      { world: "PRODUCTION" as const },
      { verifiedDestination: "-100999" },
      { accountId: "another" },
    ])
      expect(channelDispatchDecision({ ...adoption, ...change }, policy, now).allowed).toBe(false);
    expect(
      channelDispatchDecision(adoption, { ...policy, checkedAt: "2026-10-03T11:59:54Z" }, now),
    ).toMatchObject({ reason: "STALE_POLICY" });
    expect(
      channelDispatchDecision(adoption, { ...policy, checkedAt: "2026-10-03T12:00:01Z" }, now),
    ).toMatchObject({ reason: "STALE_POLICY" });
  });
  it("honors stop/circuit/rights/quota and refuses all direct delivery until consent integration is adopted", () => {
    for (const change of [
      { emergencyStop: true },
      { circuitOpen: true },
      { activationAllowed: false },
      { quotaAvailable: false },
      { visibility: "private" as const },
      { audience: { kind: "PUBLIC_CHANNEL" as const, authorized: false, authorizationId: "test" } },
      {
        audience: {
          kind: "DIRECT" as const,
          consentGranted: true,
          consentRevision: 9,
          purpose: "test",
        },
      },
    ])
      expect(channelDispatchDecision(adoption, { ...policy, ...change }, now).allowed).toBe(false);
  });
});
describe("durable publication transitions", () => {
  it("keys one publication per immutable activation revision/world and rejects changed payload reuse", () => {
    const publication = created();
    expect(channelPublicationKey(publication.identity)).toBe(
      "TEST:telegram:test-account:test-activation:3",
    );
    expect(() =>
      requireSamePublication(publication, {
        ...publication.identity,
        payloadSha256: "b".repeat(64),
      }),
    ).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() =>
      requireSamePublication(publication, { ...publication.identity, world: "PRODUCTION" }),
    ).toThrow("IDEMPOTENCY_CONFLICT");
  });
  it("has one winning claim, suppresses the same command and rejects parallel revision changes", () => {
    const fresh = created();
    const claimed = claim(fresh);
    expect(claimed.dispatch).toBe(true);
    expect(claim(claimed.publication).dispatch).toBe(false);
    expect(() =>
      claimChannelPublication({
        publication: claimed.publication,
        expectedRevision: fresh.revision,
        attemptId: "parallel",
        now,
        adoption,
        policy,
      }),
    ).toThrow("REVISION_CONFLICT");
    expect(() => claim(claimed.publication, "parallel")).toThrow("NOT_DISPATCHABLE");
  });
  it("suppresses an older command delivered again after a subsequent rate-limited attempt", () => {
    let publication = claim(created(), "first").publication;
    publication = outcome(publication, {
      kind: "REJECTED",
      code: "RATE_LIMIT",
      retryAfterSeconds: 1,
    });
    publication = claim(publication, "second", "2026-10-03T12:00:01.000Z").publication;
    publication = outcome(
      publication,
      { kind: "REJECTED", code: "RATE_LIMIT", retryAfterSeconds: 1 },
      "2026-10-03T12:00:01.000Z",
    );
    expect(claim(publication, "first", "2026-10-03T12:00:02.000Z")).toEqual({
      publication,
      dispatch: false,
    });
    expect(publication.attemptIds).toEqual(["first", "second"]);
  });
  it("never blindly repeats a timeout or a worker crash after claiming", () => {
    const claimed = claim(created()).publication;
    const uncertain = outcome(claimed, { kind: "UNKNOWN", code: "TRANSPORT" });
    expect(uncertain.state).toBe("RECONCILING");
    expect(() => claim(uncertain, "retry")).toThrow("NOT_DISPATCHABLE");
    expect(recoverChannelLease(claimed, "2026-10-03T12:01:29Z").state).toBe("IN_FLIGHT");
    const crashed = recoverChannelLease(claimed, "2026-10-03T12:01:30Z");
    expect(crashed.state).toBe("RECONCILING");
    expect(outcome(crashed, { kind: "MANUAL_RECONCILIATION", code: "NO_LOOKUP" }).state).toBe(
      "MANUAL_RECONCILIATION",
    );
  });
  it("honors explicit rate limits, rechecks current stops on retry and caps automatic attempts", () => {
    let publication = claim(created()).publication;
    publication = outcome(publication, {
      kind: "REJECTED",
      code: "RATE_LIMIT",
      retryAfterSeconds: 30,
    });
    expect(publication.state).toBe("RETRY_WAIT");
    expect(() => claim(publication, "retry")).toThrow("NOT_DUE");
    const later = "2026-10-03T12:00:30.000Z";
    expect(() =>
      claimChannelPublication({
        publication,
        expectedRevision: publication.revision,
        attemptId: "retry",
        now: later,
        adoption,
        policy: { ...policy, checkedAt: later, emergencyStop: true },
      }),
    ).toThrow("EMERGENCY_STOP");
    const exhausted = { ...publication, attempts: 5 };
    expect(() => claim(exhausted, "retry", later)).toThrow("RETRY_EXHAUSTED");
    expect(
      outcome(
        { ...claim(created()).publication, attempts: 5 },
        { kind: "REJECTED", code: "RATE_LIMIT", retryAfterSeconds: 30 },
      ).state,
    ).toBe("BLOCKED");
  });
  it("records one receipt and cannot dispatch a successful publication again", () => {
    const complete = {
      kind: "COMPLETE" as const,
      receipt: {
        channel: "telegram" as const,
        remoteId: "17",
        remoteDestination: "-100123",
        visibility: "public" as const,
      },
    };
    const published = outcome(claim(created()).publication, complete);
    expect(published.state).toBe("PUBLISHED");
    expect(outcome(published, complete)).toBe(published);
    expect(() => claim(published, "retry")).toThrow("NOT_DISPATCHABLE");
    expect(() => outcome(published, { kind: "UNKNOWN", code: "TRANSPORT" })).toThrow(
      "RESULT_REFUSED",
    );
  });
  it("keeps YouTube sessions and artifact bytes immutable across reconciliation", () => {
    const checkpoint = {
      channel: "youtube" as const,
      sessionUrl:
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture",
      totalBytes: 1000,
      artifactSha256: "b".repeat(64),
      nextByte: 0,
    };
    const claimed = {
      ...claim(created()).publication,
      identity: { ...created().identity, channel: "youtube" as const },
    };
    const resumed = outcome(claimed, { kind: "SESSION_READY", checkpoint });
    expect(resumed.checkpoint).toEqual(checkpoint);
    const uncertain = { ...resumed, state: "RECONCILING" as const };
    expect(
      outcome(uncertain, {
        kind: "RESUME",
        checkpoint: { ...checkpoint, nextByte: 500 },
        retryAfterSeconds: 2,
      }).checkpoint?.nextByte,
    ).toBe(500);
    for (const change of [
      { sessionUrl: "https://attacker.test/upload" },
      { artifactSha256: "c".repeat(64) },
      { nextByte: 1000 },
    ])
      expect(() =>
        outcome(uncertain, {
          kind: "RESUME",
          checkpoint: { ...checkpoint, ...change },
          retryAfterSeconds: 1,
        }),
      ).toThrow();
  });
});

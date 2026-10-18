/** Pure R5 policy and publication transitions. Persistence must CAS revision and commit
 * every claim/checkpoint before network I/O. No adapter is scheduled by this module. */
export const AUTOMATED_CHANNELS = ["youtube", "telegram"] as const;
export type AutomatedChannel = (typeof AUTOMATED_CHANNELS)[number];
export type ChannelWorld = "TEST" | "PRODUCTION";

export type ChannelAdoption = {
  channel: AutomatedChannel;
  accountId: string;
  world: ChannelWorld;
  enabled: boolean;
  officialCapabilityEvidence: string;
  accountEligibilityEvidence: string;
  contractTestEvidence: string;
  authorizationExpiresAt: string;
  verifiedDestination: string;
  allowedVisibility: ("private" | "unlisted" | "public")[];
};
export type ChannelDispatchPolicy = {
  accountId: string;
  channel: AutomatedChannel;
  world: ChannelWorld;
  destination: string;
  visibility: "private" | "unlisted" | "public";
  checkedAt: string;
  /** Fresh result of activationDispatchDecision, rights and native review rechecks. */
  activationAllowed: boolean;
  emergencyStop: boolean;
  circuitOpen: boolean;
  quotaAvailable: boolean;
  /** Public-channel authorization is not a grant to contact individual devotees. */
  audience:
    | { kind: "PUBLIC_CHANNEL"; authorized: boolean; authorizationId: string }
    | { kind: "DIRECT"; consentGranted: boolean; consentRevision: number; purpose: string };
};
export type ChannelDispatchRefusal =
  | "INVALID_TIME"
  | "PROVIDER_NOT_ADOPTED"
  | "ACCOUNT_MISMATCH"
  | "AUTHORIZATION_EXPIRED"
  | "STALE_POLICY"
  | "ACTIVATION_REFUSED"
  | "EMERGENCY_STOP"
  | "CIRCUIT_OPEN"
  | "QUOTA_UNAVAILABLE"
  | "VISIBILITY_REFUSED"
  | "AUDIENCE_REFUSED"
  | "DIRECT_DELIVERY_NOT_ADOPTED";

export function channelDispatchDecision(
  adoption: ChannelAdoption,
  policy: ChannelDispatchPolicy,
  now: string,
): { allowed: true } | { allowed: false; reason: ChannelDispatchRefusal } {
  const refuse = (reason: ChannelDispatchRefusal) => ({ allowed: false as const, reason });
  const time = Date.parse(now);
  const checked = Date.parse(policy.checkedAt);
  if (!Number.isFinite(time) || !Number.isFinite(checked)) return refuse("INVALID_TIME");
  if (
    !adoption.enabled ||
    !adoption.officialCapabilityEvidence.trim() ||
    !adoption.accountEligibilityEvidence.trim() ||
    !adoption.contractTestEvidence.trim()
  )
    return refuse("PROVIDER_NOT_ADOPTED");
  if (
    adoption.accountId !== policy.accountId ||
    adoption.channel !== policy.channel ||
    adoption.world !== policy.world ||
    adoption.verifiedDestination !== policy.destination
  )
    return refuse("ACCOUNT_MISMATCH");
  if (
    !Number.isFinite(Date.parse(adoption.authorizationExpiresAt)) ||
    Date.parse(adoption.authorizationExpiresAt) <= time
  )
    return refuse("AUTHORIZATION_EXPIRED");
  // Fail closed on future timestamps as well as old snapshots; the caller uses its DB clock.
  if (checked > time || time - checked > 5000) return refuse("STALE_POLICY");
  if (policy.emergencyStop) return refuse("EMERGENCY_STOP");
  if (policy.circuitOpen) return refuse("CIRCUIT_OPEN");
  if (!policy.quotaAvailable) return refuse("QUOTA_UNAVAILABLE");
  if (!policy.activationAllowed) return refuse("ACTIVATION_REFUSED");
  if (!adoption.allowedVisibility.includes(policy.visibility)) return refuse("VISIBILITY_REFUSED");
  // Purpose-specific, per-user consent integration is deliberately not implemented by R5 transports.
  if (policy.audience.kind === "DIRECT") return refuse("DIRECT_DELIVERY_NOT_ADOPTED");
  if (!policy.audience.authorized || !policy.audience.authorizationId.trim())
    return refuse("AUDIENCE_REFUSED");
  return { allowed: true };
}

export type ChannelPublicationIdentity = {
  activationId: string;
  activationRevision: number;
  accountId: string;
  channel: AutomatedChannel;
  world: ChannelWorld;
  /** SHA-256 of the approved payload, artifact and immutable lineage snapshot. */
  payloadSha256: string;
};
export type YouTubeCheckpoint = {
  channel: "youtube";
  sessionUrl: string;
  totalBytes: number;
  artifactSha256: string;
  nextByte: number;
};
export type ChannelReceipt = {
  channel: AutomatedChannel;
  remoteId: string;
  remoteDestination: string;
  visibility: "private" | "unlisted" | "public";
};
export type ChannelProviderOutcome =
  | { kind: "COMPLETE"; receipt: ChannelReceipt }
  | { kind: "SESSION_READY"; checkpoint: YouTubeCheckpoint }
  | { kind: "RESUME"; checkpoint: YouTubeCheckpoint; retryAfterSeconds: number }
  | {
      kind: "REJECTED";
      code: "AUTHORIZATION" | "RATE_LIMIT" | "INVALID_REQUEST" | "PROVIDER_REFUSED";
      retryAfterSeconds: number | null;
    }
  | { kind: "UNKNOWN"; code: "TRANSPORT" | "INVALID_RESPONSE" | "SERVER_FAILURE" }
  | { kind: "MANUAL_RECONCILIATION"; code: "NO_LOOKUP" | "SESSION_EXPIRED" | "REMOTE_MISMATCH" };
export type ChannelPublication = {
  identity: ChannelPublicationIdentity;
  revision: number;
  state:
    | "READY"
    | "IN_FLIGHT"
    | "RECONCILING"
    | "RETRY_WAIT"
    | "PUBLISHED"
    | "BLOCKED"
    | "MANUAL_RECONCILIATION";
  attempts: number;
  /** Bounded by the five-attempt ceiling; old delivery commands remain idempotent. */
  attemptIds: string[];
  attemptId: string | null;
  leaseUntil: string | null;
  retryAt: string | null;
  checkpoint: YouTubeCheckpoint | null;
  receipt: ChannelReceipt | null;
  lastOutcome: ChannelProviderOutcome | null;
};
const safeId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const timeAt = (value: string) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("CHANNEL_INVALID_TIME");
  return time;
};
/** Database UNIQUE key: source retries cannot silently swap approved payloads. */
export function channelPublicationKey(value: ChannelPublicationIdentity): string {
  if (
    !safeId(value.activationId) ||
    !safeId(value.accountId) ||
    !Number.isSafeInteger(value.activationRevision) ||
    value.activationRevision < 1 ||
    !AUTOMATED_CHANNELS.includes(value.channel) ||
    !["TEST", "PRODUCTION"].includes(value.world) ||
    !/^[a-f0-9]{64}$/.test(value.payloadSha256)
  )
    throw new Error("INVALID_CHANNEL_PUBLICATION");
  return `${value.world}:${value.channel}:${value.accountId}:${value.activationId}:${value.activationRevision}`;
}
export function createChannelPublication(identity: ChannelPublicationIdentity): ChannelPublication {
  channelPublicationKey(identity);
  return {
    identity: { ...identity },
    revision: 1,
    state: "READY",
    attempts: 0,
    attemptIds: [],
    attemptId: null,
    leaseUntil: null,
    retryAt: null,
    checkpoint: null,
    receipt: null,
    lastOutcome: null,
  };
}
export function requireSamePublication(
  existing: ChannelPublication,
  identity: ChannelPublicationIdentity,
): void {
  if (
    channelPublicationKey(existing.identity) !== channelPublicationKey(identity) ||
    existing.identity.payloadSha256 !== identity.payloadSha256
  )
    throw new Error("CHANNEL_IDEMPOTENCY_CONFLICT");
}
/** A duplicate command gets dispatch=false. The repository must atomically persist state
 * under its revision, then only the winning claimant may perform the returned action. */
export function claimChannelPublication(input: {
  publication: ChannelPublication;
  expectedRevision: number;
  attemptId: string;
  now: string;
  adoption: ChannelAdoption;
  policy: ChannelDispatchPolicy;
}): { publication: ChannelPublication; dispatch: boolean } {
  const { publication: current } = input;
  timeAt(input.now);
  if (!safeId(input.attemptId)) throw new Error("INVALID_CHANNEL_ATTEMPT");
  if (current.attemptIds.includes(input.attemptId))
    return { publication: current, dispatch: false };
  if (current.revision !== input.expectedRevision) throw new Error("CHANNEL_REVISION_CONFLICT");
  if (!["READY", "RETRY_WAIT"].includes(current.state)) throw new Error("CHANNEL_NOT_DISPATCHABLE");
  if (current.attempts >= 5) throw new Error("CHANNEL_RETRY_EXHAUSTED");
  if (current.retryAt && timeAt(current.retryAt) > timeAt(input.now))
    throw new Error("CHANNEL_NOT_DUE");
  if (
    current.identity.channel !== input.policy.channel ||
    current.identity.accountId !== input.policy.accountId ||
    current.identity.world !== input.policy.world
  )
    throw new Error("CHANNEL_ACCOUNT_MISMATCH");
  const decision = channelDispatchDecision(input.adoption, input.policy, input.now);
  if (!decision.allowed) throw new Error(`CHANNEL_${decision.reason}`);
  return {
    dispatch: true,
    publication: {
      ...current,
      revision: current.revision + 1,
      state: "IN_FLIGHT",
      attempts: current.attempts + 1,
      attemptIds: [...current.attemptIds, input.attemptId],
      attemptId: input.attemptId,
      leaseUntil: new Date(timeAt(input.now) + 90_000).toISOString(),
      retryAt: null,
      lastOutcome: null,
    },
  };
}

function validateCheckpoint(value: YouTubeCheckpoint): void {
  const url = new URL(value.sessionUrl);
  if (
    url.origin !== "https://www.googleapis.com" ||
    url.pathname !== "/upload/youtube/v3/videos" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.searchParams.get("upload_id") ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 1 ||
    !Number.isSafeInteger(value.nextByte) ||
    value.nextByte < 0 ||
    value.nextByte >= value.totalBytes ||
    !/^[a-f0-9]{64}$/.test(value.artifactSha256)
  )
    throw new Error("INVALID_CHANNEL_CHECKPOINT");
}
/** Also used for reconciliation results. UNKNOWN never becomes an automatic new send. */
export function recordChannelOutcome(input: {
  publication: ChannelPublication;
  expectedRevision: number;
  attemptId: string;
  outcome: ChannelProviderOutcome;
  now: string;
}): ChannelPublication {
  const { publication: current, outcome } = input;
  const now = timeAt(input.now);
  if (current.attemptId !== input.attemptId) throw new Error("CHANNEL_ATTEMPT_CONFLICT");
  if (current.lastOutcome && JSON.stringify(current.lastOutcome) === JSON.stringify(outcome))
    return current;
  if (current.revision !== input.expectedRevision) throw new Error("CHANNEL_REVISION_CONFLICT");
  if (!["IN_FLIGHT", "RECONCILING"].includes(current.state))
    throw new Error("CHANNEL_RESULT_REFUSED");
  const updated: ChannelPublication = {
    ...current,
    revision: current.revision + 1,
    leaseUntil: null,
    retryAt: null,
    lastOutcome: outcome,
  };
  switch (outcome.kind) {
    case "COMPLETE":
      if (
        outcome.receipt.channel !== current.identity.channel ||
        !outcome.receipt.remoteId.trim() ||
        !outcome.receipt.remoteDestination.trim()
      )
        throw new Error("CHANNEL_RECEIPT_MISMATCH");
      return { ...updated, state: "PUBLISHED", receipt: outcome.receipt };
    case "SESSION_READY":
    case "RESUME":
      if (
        current.identity.channel !== "youtube" ||
        (outcome.kind === "SESSION_READY" && current.checkpoint)
      )
        throw new Error("CHANNEL_CHECKPOINT_REFUSED");
      validateCheckpoint(outcome.checkpoint);
      if (
        current.checkpoint &&
        (current.checkpoint.sessionUrl !== outcome.checkpoint.sessionUrl ||
          current.checkpoint.artifactSha256 !== outcome.checkpoint.artifactSha256 ||
          current.checkpoint.totalBytes !== outcome.checkpoint.totalBytes ||
          outcome.checkpoint.nextByte < current.checkpoint.nextByte)
      )
        throw new Error("CHANNEL_CHECKPOINT_CONFLICT");
      if (
        outcome.kind === "RESUME" &&
        (!Number.isFinite(outcome.retryAfterSeconds) || outcome.retryAfterSeconds < 0)
      )
        throw new Error("CHANNEL_INVALID_RETRY");
      return {
        ...updated,
        state: "RETRY_WAIT",
        checkpoint: outcome.checkpoint,
        retryAt: new Date(
          now + (outcome.kind === "RESUME" ? Math.max(1, outcome.retryAfterSeconds) : 0) * 1000,
        ).toISOString(),
      };
    case "UNKNOWN":
      return { ...updated, state: "RECONCILING" };
    case "MANUAL_RECONCILIATION":
      return { ...updated, state: "MANUAL_RECONCILIATION" };
    case "REJECTED": {
      if (
        outcome.code !== "RATE_LIMIT" ||
        outcome.retryAfterSeconds === null ||
        current.attempts >= 5
      )
        return { ...updated, state: "BLOCKED" };
      if (!Number.isFinite(outcome.retryAfterSeconds) || outcome.retryAfterSeconds < 0)
        throw new Error("CHANNEL_INVALID_RETRY");
      return {
        ...updated,
        state: "RETRY_WAIT",
        retryAt: new Date(now + Math.max(1, outcome.retryAfterSeconds) * 1000).toISOString(),
      };
    }
  }
}
/** A crash after a send is indistinguishable from a timeout, even if no response was saved. */
export function recoverChannelLease(current: ChannelPublication, now: string): ChannelPublication {
  if (
    current.state !== "IN_FLIGHT" ||
    !current.leaseUntil ||
    timeAt(current.leaseUntil) > timeAt(now)
  )
    return current;
  return {
    ...current,
    revision: current.revision + 1,
    state: "RECONCILING",
    leaseUntil: null,
    lastOutcome: { kind: "UNKNOWN", code: "TRANSPORT" },
  };
}

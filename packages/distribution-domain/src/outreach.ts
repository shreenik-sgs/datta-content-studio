import { type DistributionChannel, requireContentRevision } from "./content";
import { type EditorialReview, isEditorialApproved } from "./intelligence";
export const MISSION_OUTCOMES = [
  "PRACTICE_COMPLETED",
  "SATSANG_JOINED",
  "SANKALPA_JOINED",
  "SEVA_DISCOVERED",
  "RETURNED",
  "REFERRED_PARTICIPATION",
] as const;
export type MissionOutcome = (typeof MISSION_OUTCOMES)[number];
export const CTA_INTENTS = [
  "MEDITATE",
  "CONTINUE",
  "JOIN",
  "LISTEN",
  "PRACTICE",
  "LEARN",
  "PARTICIPATE",
  "SHARE",
] as const;
export type CtaIntent = (typeof CTA_INTENTS)[number];
export type CtaDestination = { path: string; requiresIdentity: boolean };
export type CtaDefinition = {
  id: string;
  revision: number;
  intent: CtaIntent;
  copy: string;
  language: string;
  destination: CtaDestination;
  fallback: CtaDestination;
  approval: EditorialReview | null;
};
export type OutreachCampaign = {
  id: string;
  kind: "OUTREACH";
  revision: number;
  name: string;
  program: string;
  goal: string;
  outcomes: MissionOutcome[];
  startsAt: string;
  endsAt: string;
  budgetMicros: number;
  status: "DRAFT" | "APPROVED" | "PAUSED" | "STOPPED";
  approval: EditorialReview | null;
};
export type ChannelActivation = {
  id: string;
  revision: number;
  campaignId: string;
  campaignRevision: number;
  ctaId: string;
  ctaRevision: number;
  derivativeId: string;
  derivativeRevision: number;
  sourceVersionId: string;
  channelAccountId: string | null;
  channel: DistributionChannel;
  scheduledAt: string;
  status: "DRAFT" | "APPROVED" | "SCHEDULED" | "STOPPED";
  approval: EditorialReview | null;
};
const text = (value: string, maximum: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const revisionValid = (value: number) => Number.isSafeInteger(value) && value > 0;
const instant = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
/** Explicit core routes or an operator-approved HTTPS origin. No redirect parameter is accepted. */
export function validateCtaDestination(
  value: string,
  allowedOrigins: readonly string[] = [],
): void {
  if (!text(value, 2000)) throw new Error("UNSAFE_DESTINATION");
  let decoded = value;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new Error("UNSAFE_DESTINATION");
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("..") ||
    [...decoded].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("UNSAFE_DESTINATION");
  if (value.startsWith("/")) {
    if (
      !/^\/(?:home|community|blessings|explore|content\/(?:room|event|seva)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|practice\/[a-z0-9][a-z0-9-]{0,127}|darshan\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(
        value,
      )
    )
      throw new Error("UNSAFE_DESTINATION");
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("UNSAFE_DESTINATION");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedOrigins.includes(url.origin) ||
    [...url.searchParams.keys()].some((key) =>
      /^(?:url|redirect|redirect_uri|redirect_url|next|return|returnTo|continue|target)$/i.test(
        key,
      ),
    )
  )
    throw new Error("UNSAFE_DESTINATION");
}
export function validateOutreachCampaign(value: OutreachCampaign): void {
  if (
    value.kind !== "OUTREACH" ||
    !text(value.id, 128) ||
    !revisionValid(value.revision) ||
    !text(value.name, 200) ||
    !text(value.program, 100) ||
    !text(value.goal, 1000) ||
    value.outcomes.length < 1 ||
    value.outcomes.length > MISSION_OUTCOMES.length ||
    new Set(value.outcomes).size !== value.outcomes.length ||
    value.outcomes.some((outcome) => !MISSION_OUTCOMES.includes(outcome)) ||
    !instant(value.startsAt) ||
    !instant(value.endsAt) ||
    Date.parse(value.startsAt) >= Date.parse(value.endsAt) ||
    !Number.isSafeInteger(value.budgetMicros) ||
    value.budgetMicros < 0 ||
    !["DRAFT", "APPROVED", "PAUSED", "STOPPED"].includes(value.status)
  )
    throw new Error("INVALID_OUTREACH_CAMPAIGN");
}
export function validateCta(value: CtaDefinition, allowedOrigins: readonly string[] = []): void {
  if (
    !text(value.id, 128) ||
    !revisionValid(value.revision) ||
    !CTA_INTENTS.includes(value.intent) ||
    !text(value.copy, 120) ||
    !text(value.language, 16) ||
    value.destination.path === value.fallback.path ||
    typeof value.destination.requiresIdentity !== "boolean" ||
    typeof value.fallback.requiresIdentity !== "boolean"
  )
    throw new Error("INVALID_CTA");
  validateCtaDestination(value.destination.path, allowedOrigins);
  validateCtaDestination(value.fallback.path, allowedOrigins);
  if (value.fallback.path === "/home") throw new Error("GENERIC_FALLBACK_REFUSED");
}
export type HumanApprovalCommand = {
  expectedRevision: number;
  reviewerId: string;
  reviewedAt: string;
};
function approval(command: HumanApprovalCommand, revision: number): EditorialReview {
  const result: EditorialReview = {
    decision: "APPROVED",
    reviewerId: command.reviewerId,
    reviewedAt: command.reviewedAt,
    revision,
  };
  if (!isEditorialApproved(result, revision)) throw new Error("INVALID_REVIEW");
  return result;
}
export function reviseOutreachCampaign(
  source: OutreachCampaign,
  expectedRevision: number,
  changes: Partial<
    Pick<
      OutreachCampaign,
      "name" | "program" | "goal" | "outcomes" | "startsAt" | "endsAt" | "budgetMicros"
    >
  >,
): OutreachCampaign {
  requireContentRevision(source.revision, expectedRevision);
  validateOutreachCampaign(source);
  if (source.status === "STOPPED") throw new Error("CAMPAIGN_STOPPED");
  const revised: OutreachCampaign = {
    ...source,
    ...changes,
    revision: source.revision + 1,
    status: "DRAFT",
    approval: null,
  };
  validateOutreachCampaign(revised);
  return revised;
}
export function pauseOutreachCampaign(
  source: OutreachCampaign,
  expectedRevision: number,
): OutreachCampaign {
  requireContentRevision(source.revision, expectedRevision);
  validateOutreachCampaign(source);
  if (source.status !== "APPROVED") throw new Error("CAMPAIGN_NOT_APPROVED");
  return { ...source, status: "PAUSED", revision: source.revision + 1, approval: null };
}
export function stopOutreachCampaign(
  source: OutreachCampaign,
  expectedRevision: number,
): OutreachCampaign {
  requireContentRevision(source.revision, expectedRevision);
  validateOutreachCampaign(source);
  if (source.status === "STOPPED") throw new Error("CAMPAIGN_STOPPED");
  return { ...source, status: "STOPPED", revision: source.revision + 1, approval: null };
}
export function approveOutreachCampaign(
  source: OutreachCampaign,
  command: HumanApprovalCommand,
): OutreachCampaign {
  requireContentRevision(source.revision, command.expectedRevision);
  validateOutreachCampaign(source);
  if (source.status !== "DRAFT") throw new Error("CAMPAIGN_NOT_DRAFT");
  const revision = source.revision + 1;
  return { ...source, revision, status: "APPROVED", approval: approval(command, revision) };
}
export function reviseCta(
  source: CtaDefinition,
  expectedRevision: number,
  changes: Partial<
    Pick<CtaDefinition, "intent" | "copy" | "language" | "destination" | "fallback">
  >,
  allowedOrigins: readonly string[] = [],
): CtaDefinition {
  requireContentRevision(source.revision, expectedRevision);
  const revised = { ...source, ...changes, revision: source.revision + 1, approval: null };
  validateCta(revised, allowedOrigins);
  return revised;
}
export function approveCta(
  source: CtaDefinition,
  command: HumanApprovalCommand,
  allowedOrigins: readonly string[] = [],
): CtaDefinition {
  requireContentRevision(source.revision, command.expectedRevision);
  validateCta(source, allowedOrigins);
  const revision = source.revision + 1;
  return { ...source, revision, approval: approval(command, revision) };
}
export type TrackedLinkSnapshot = {
  token: string;
  campaignId: string;
  contentId: string;
  cta: CtaDefinition;
  language: string;
};
export type AuthenticatedDestinationIntent = {
  campaignId: string;
  contentId: string;
  ctaId: string;
  ctaRevision: number;
  language: string;
  destination: string;
};
/** Snapshot must be obtained from trusted storage/cache; the HTTP adapter signs the returned intent. */
export function resolveTrackedIntent(input: {
  snapshot: TrackedLinkSnapshot;
  currentCta: CtaDefinition | null;
  destinationAvailable: boolean;
  hubAvailable: boolean;
  emergencyStop: boolean;
  allowedOrigins?: readonly string[];
}): {
  destination: string;
  requiresIdentity: boolean;
  usedFallback: boolean;
  intent: AuthenticatedDestinationIntent;
} {
  const { snapshot, currentCta } = input;
  validateCta(snapshot.cta, input.allowedOrigins);
  if (!isEditorialApproved(snapshot.cta.approval, snapshot.cta.revision))
    throw new Error("CTA_NOT_APPROVED");
  const usedFallback =
    !input.hubAvailable ||
    input.emergencyStop ||
    !input.destinationAvailable ||
    !currentCta ||
    currentCta.id !== snapshot.cta.id ||
    currentCta.revision !== snapshot.cta.revision ||
    !isEditorialApproved(currentCta.approval, currentCta.revision);
  const destination = usedFallback ? snapshot.cta.fallback : snapshot.cta.destination;
  return {
    destination: destination.path,
    requiresIdentity: destination.requiresIdentity,
    usedFallback,
    intent: {
      campaignId: snapshot.campaignId,
      contentId: snapshot.contentId,
      ctaId: snapshot.cta.id,
      ctaRevision: snapshot.cta.revision,
      language: snapshot.language,
      destination: destination.path,
    },
  };
}
export type ActivationRefusal =
  | "INVALID_TIME"
  | "STOPPED"
  | "CAMPAIGN_NOT_APPROVED"
  | "CAMPAIGN_OUTSIDE_WINDOW"
  | "ACTIVATION_NOT_APPROVED"
  | "CTA_NOT_APPROVED"
  | "DERIVATIVE_NOT_APPROVED"
  | "CHANNEL_UNAVAILABLE"
  | "RIGHTS_REFUSED"
  | "AUDIENCE_REFUSED"
  | "NOT_DUE";
export function activationDispatchDecision(input: {
  activation: ChannelActivation;
  campaign: OutreachCampaign;
  cta: CtaDefinition;
  derivative: {
    id: string;
    revision: number;
    sourceVersionId: string;
    approval: EditorialReview | null;
    withdrawn: boolean;
  };
  channelAccount: {
    id: string;
    channel: DistributionChannel;
    connected: boolean;
    emergencyStop: boolean;
  } | null;
  sourceRightsAllowed: boolean;
  audienceAllowed: boolean;
  allowedOrigins?: readonly string[];
  now: string;
}): { allowed: true } | { allowed: false; reason: ActivationRefusal } {
  const { activation, campaign, cta, derivative, channelAccount } = input;
  const refuse = (reason: ActivationRefusal) => ({ allowed: false as const, reason });
  if (!instant(input.now) || !instant(activation.scheduledAt)) return refuse("INVALID_TIME");
  if (
    activation.status === "STOPPED" ||
    campaign.status === "STOPPED" ||
    campaign.status === "PAUSED" ||
    channelAccount?.emergencyStop
  )
    return refuse("STOPPED");
  try {
    validateOutreachCampaign(campaign);
  } catch {
    return refuse("CAMPAIGN_NOT_APPROVED");
  }
  if (
    campaign.status !== "APPROVED" ||
    !isEditorialApproved(campaign.approval, campaign.revision) ||
    activation.campaignId !== campaign.id ||
    activation.campaignRevision !== campaign.revision
  )
    return refuse("CAMPAIGN_NOT_APPROVED");
  if (
    Date.parse(input.now) < Date.parse(campaign.startsAt) ||
    Date.parse(input.now) >= Date.parse(campaign.endsAt)
  )
    return refuse("CAMPAIGN_OUTSIDE_WINDOW");
  if (
    !["APPROVED", "SCHEDULED"].includes(activation.status) ||
    !isEditorialApproved(activation.approval, activation.revision)
  )
    return refuse("ACTIVATION_NOT_APPROVED");
  try {
    validateCta(cta, input.allowedOrigins);
  } catch {
    return refuse("CTA_NOT_APPROVED");
  }
  if (
    activation.ctaId !== cta.id ||
    activation.ctaRevision !== cta.revision ||
    !isEditorialApproved(cta.approval, cta.revision)
  )
    return refuse("CTA_NOT_APPROVED");
  if (
    derivative.withdrawn ||
    activation.derivativeId !== derivative.id ||
    activation.derivativeRevision !== derivative.revision ||
    activation.sourceVersionId !== derivative.sourceVersionId ||
    !isEditorialApproved(derivative.approval, derivative.revision)
  )
    return refuse("DERIVATIVE_NOT_APPROVED");
  if (activation.channel === "manual_export") {
    if (activation.channelAccountId !== null || channelAccount !== null)
      return refuse("CHANNEL_UNAVAILABLE");
  } else if (
    !channelAccount ||
    !channelAccount.connected ||
    activation.channelAccountId !== channelAccount.id ||
    activation.channel !== channelAccount.channel
  ) {
    return refuse("CHANNEL_UNAVAILABLE");
  }
  if (!input.sourceRightsAllowed) return refuse("RIGHTS_REFUSED");
  if (!input.audienceAllowed) return refuse("AUDIENCE_REFUSED");
  if (Date.parse(input.now) < Date.parse(activation.scheduledAt)) return refuse("NOT_DUE");
  return { allowed: true };
}

export function validateChannelActivation(value: ChannelActivation): void {
  if (
    [value.id, value.campaignId, value.ctaId, value.derivativeId, value.sourceVersionId].some(
      (id) => !text(id, 128),
    ) ||
    [value.revision, value.campaignRevision, value.ctaRevision, value.derivativeRevision].some(
      (value) => !revisionValid(value),
    ) ||
    !instant(value.scheduledAt) ||
    !["DRAFT", "APPROVED", "SCHEDULED", "STOPPED"].includes(value.status) ||
    (value.channel === "manual_export"
      ? value.channelAccountId !== null
      : !text(value.channelAccountId ?? "", 128))
  )
    throw new Error("INVALID_ACTIVATION");
}
export function createManualActivation(
  input: Omit<ChannelActivation, "revision" | "status" | "approval">,
): ChannelActivation {
  if (input.channel !== "manual_export" || input.channelAccountId !== null)
    throw new Error("INVALID_ACTIVATION");
  const result: ChannelActivation = {
    id: input.id,
    campaignId: input.campaignId,
    campaignRevision: input.campaignRevision,
    ctaId: input.ctaId,
    ctaRevision: input.ctaRevision,
    derivativeId: input.derivativeId,
    derivativeRevision: input.derivativeRevision,
    sourceVersionId: input.sourceVersionId,
    channelAccountId: null,
    channel: "manual_export",
    scheduledAt: input.scheduledAt,
    revision: 1,
    status: "DRAFT",
    approval: null,
  };
  validateChannelActivation(result);
  return result;
}
export function approveChannelActivation(
  source: ChannelActivation,
  command: HumanApprovalCommand,
): ChannelActivation {
  requireContentRevision(source.revision, command.expectedRevision);
  validateChannelActivation(source);
  if (source.status !== "DRAFT") throw new Error("ACTIVATION_NOT_DRAFT");
  const revision = source.revision + 1;
  return { ...source, revision, status: "APPROVED", approval: approval(command, revision) };
}
export function stopChannelActivation(
  source: ChannelActivation,
  expectedRevision: number,
): ChannelActivation {
  requireContentRevision(source.revision, expectedRevision);
  validateChannelActivation(source);
  if (source.status === "STOPPED") throw new Error("ACTIVATION_STOPPED");
  return { ...source, revision: source.revision + 1, status: "STOPPED", approval: null };
}

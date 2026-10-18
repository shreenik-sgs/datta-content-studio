import type { CtaDefinition } from "./outreach";
/** Placement metadata does not imply a provider adapter, credentials or publishing adoption. */
export const SOCIAL_PLACEMENTS = [
  "youtube",
  "youtube_shorts",
  "instagram",
  "facebook",
  "threads",
  "x",
  "reddit",
  "telegram",
  "whatsapp",
  "linkedin",
  "pinterest",
  "tiktok",
  "snapchat",
  "mastodon",
  "bluesky",
  "email",
  "website",
] as const;
export type SocialPlacement = (typeof SOCIAL_PLACEMENTS)[number];
export const CANONICAL_DESTINATION_KINDS = [
  "DISCOURSE",
  "ALBUM",
  "TRACK",
  "PRACTICE",
  "LIVE",
  "TEACHING",
  "SEVA",
  "EVENT",
  "LIBRARY",
] as const;
export type CanonicalDestinationKind = (typeof CANONICAL_DESTINATION_KINDS)[number];
export const ACTIVATION_PROMISES = [
  "FULL_DISCOURSE",
  "FULL_ALBUM",
  "FULL_TRACK",
  "FULL_PRACTICE",
  "LIVE_JOIN",
  "FULL_TEACHING",
  "SEVA_DETAILS",
  "EVENT_DETAILS",
] as const;
export type ActivationPromise = (typeof ACTIVATION_PROMISES)[number];
export type CanonicalDestinationResult = {
  path: string;
  available: boolean;
  requiresIdentity: boolean;
  canonicalId: string | null;
  kind: CanonicalDestinationKind | null;
  accessMode: "PUBLIC" | "AUTH_REQUIRED" | "RESTRICTED";
  revision: string | null;
  reason: string | null;
};
export type CanonicalDestinationEvidence = {
  version: 2;
  isTest: true;
  checkedAt: string;
  flags: { tracked_social_deep_links: boolean; universal_content_landing: boolean };
  results: CanonicalDestinationResult[];
};
export type ActivationPackageInput = {
  channel: SocialPlacement;
  copy: string;
  promise: ActivationPromise;
  intendedAccess: "PUBLIC" | "AUTH_REQUIRED";
};
export type ActivationReviewPackage = ActivationPackageInput & {
  schemaVersion: 1;
  source: {
    startMs: number;
    endMs: number;
    transcriptVersionId: string;
    transcriptRevision: number;
    hasCaptions: boolean;
    aspect: string;
    nativeApproval: { analysisId: string; candidateId: string; reviewRevision: number } | null;
  };
  destinationTest: {
    checkedAt: string;
    destination: CanonicalDestinationResult;
    fallback: CanonicalDestinationResult;
  } | null;
};
const promiseKind: Record<ActivationPromise, CanonicalDestinationKind> = {
  FULL_DISCOURSE: "DISCOURSE",
  FULL_ALBUM: "ALBUM",
  FULL_TRACK: "TRACK",
  FULL_PRACTICE: "PRACTICE",
  LIVE_JOIN: "LIVE",
  FULL_TEACHING: "TEACHING",
  SEVA_DETAILS: "SEVA",
  EVENT_DETAILS: "EVENT",
};
const intents: Record<ActivationPromise, readonly string[]> = {
  FULL_DISCOURSE: ["LEARN", "CONTINUE"],
  FULL_ALBUM: ["LISTEN", "CONTINUE"],
  FULL_TRACK: ["LISTEN", "CONTINUE"],
  FULL_PRACTICE: ["MEDITATE", "PRACTICE", "CONTINUE", "PARTICIPATE"],
  LIVE_JOIN: ["JOIN", "PARTICIPATE"],
  FULL_TEACHING: ["LEARN", "CONTINUE"],
  SEVA_DETAILS: ["PARTICIPATE", "LEARN"],
  EVENT_DETAILS: ["JOIN", "PARTICIPATE", "LEARN"],
};
export function validateActivationPackageInput(input: ActivationPackageInput): void {
  if (
    !SOCIAL_PLACEMENTS.includes(input.channel) ||
    !ACTIVATION_PROMISES.includes(input.promise) ||
    !["PUBLIC", "AUTH_REQUIRED"].includes(input.intendedAccess) ||
    typeof input.copy !== "string" ||
    !input.copy.trim() ||
    input.copy.length > 12000 ||
    [...input.copy].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    })
  )
    throw new Error("INVALID_ACTIVATION_PACKAGE");
}
/** Server evidence, never a successful client fetch, determines audience and promised experience. */
export function validateActivationDestination(
  input: ActivationPackageInput,
  cta: CtaDefinition,
  evidence: CanonicalDestinationEvidence,
  now: string,
): NonNullable<ActivationReviewPackage["destinationTest"]> {
  validateActivationPackageInput(input);
  if (
    evidence.version !== 2 ||
    evidence.isTest !== true ||
    evidence.flags.tracked_social_deep_links !== true ||
    evidence.flags.universal_content_landing !== true
  )
    throw new Error("FEATURE_UNAVAILABLE");
  const time = Date.parse(now);
  const checked = Date.parse(evidence.checkedAt);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(checked) ||
    time - checked > 30000 ||
    checked - time > 2000
  )
    throw new Error("DESTINATION_CHECK_STALE");
  if (
    evidence.results.length !== 2 ||
    new Set(evidence.results.map((result) => result.path)).size !== 2
  )
    throw new Error("DESTINATION_UNAVAILABLE");
  const destination = evidence.results.find((result) => result.path === cta.destination.path);
  const fallback = evidence.results.find((result) => result.path === cta.fallback.path);
  if (
    !destination ||
    !fallback ||
    !destination.available ||
    !fallback.available ||
    !destination.canonicalId ||
    !destination.revision ||
    !destination.kind ||
    destination.accessMode === "RESTRICTED" ||
    fallback.accessMode === "RESTRICTED" ||
    destination.requiresIdentity !== (destination.accessMode === "AUTH_REQUIRED") ||
    fallback.requiresIdentity !== (fallback.accessMode === "AUTH_REQUIRED") ||
    cta.destination.requiresIdentity !== destination.requiresIdentity ||
    cta.fallback.requiresIdentity !== fallback.requiresIdentity
  )
    throw new Error("DESTINATION_UNAVAILABLE");
  if (
    promiseKind[input.promise] !== destination.kind ||
    !intents[input.promise].includes(cta.intent)
  )
    throw new Error("CTA_DESTINATION_MISMATCH");
  if (input.intendedAccess === "PUBLIC" && destination.accessMode !== "PUBLIC")
    throw new Error("DESTINATION_AUDIENCE_REFUSED");
  return { checkedAt: evidence.checkedAt, destination, fallback };
}
export function sameActivationDestination(
  expected: NonNullable<ActivationReviewPackage["destinationTest"]>,
  current: NonNullable<ActivationReviewPackage["destinationTest"]>,
): boolean {
  const identity = (value: CanonicalDestinationResult) =>
    JSON.stringify({
      path: value.path,
      canonicalId: value.canonicalId,
      kind: value.kind,
      accessMode: value.accessMode,
      requiresIdentity: value.requiresIdentity,
      revision: value.revision,
    });
  return (
    identity(expected.destination) === identity(current.destination) &&
    identity(expected.fallback) === identity(current.fallback)
  );
}
/** Excludes mutable validation timestamps; every authored or canonical identity change alters the seal. */
export function canonicalActivationApproval(input: {
  activationId: string;
  activationRevision: number;
  masterId: string;
  sourceVersionId: string;
  sourceRevision: number;
  derivativeId: string;
  derivativeRevision: number;
  recipeSha256: string;
  assetSha256: string;
  cta: CtaDefinition;
  reviewPackage: ActivationReviewPackage;
}): string {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== "checkedAt")
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, ordered(child)]),
          )
        : value;
  return JSON.stringify(ordered(input));
}

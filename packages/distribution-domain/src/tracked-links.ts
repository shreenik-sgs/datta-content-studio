import type { ActivationPromise, SocialPlacement } from "./activation-package";
import { type CtaDefinition, resolveTrackedIntent } from "./outreach";
import type { SocialLinkFallbackReason } from "./social-link-events";
export const TRACKED_LINK_FRESH_MS = 30000;
export const TRACKED_LINK_LOCALES = ["en", "hi", "te", "kn", "ta", "ml", "gu"] as const;
export type TrackedLinkRecord = {
  schemaVersion: 1;
  token: string;
  isTest: true;
  sequence: number;
  activationId: string;
  activationRevision: number;
  campaignId: string;
  campaignRevision: number;
  contentId: string;
  sourceVersionId: string;
  derivativeId: string;
  derivativeRevision: number;
  title: string;
  cta: CtaDefinition;
  language: (typeof TRACKED_LINK_LOCALES)[number];
  startsAt: string;
  endsAt: string;
  checkedAt: string;
  status: "ACTIVE" | "STOPPED" | "STALE";
  destinationAvailable: boolean;
  fallbackReason?: SocialLinkFallbackReason | null | undefined;
  social?:
    | {
        channel: SocialPlacement;
        promise: ActivationPromise;
        canonicalId: string;
        canonicalRevision: string;
        accessMode: "PUBLIC" | "AUTH_REQUIRED";
        fallbackAccessMode: "PUBLIC" | "AUTH_REQUIRED";
        approvalPackageSha256: string;
      }
    | undefined;
};
/** Input is an authenticated cache record; the resolver never queries core or the Hub. */
export function trackedLinkDecision(record: TrackedLinkRecord, now: string) {
  const time = Date.parse(now);
  const checked = Date.parse(record.checkedAt);
  if (!Number.isFinite(time) || !Number.isFinite(checked)) throw new Error("INVALID_TIME");
  const fresh = time >= checked && time - checked <= TRACKED_LINK_FRESH_MS;
  const inWindow = time >= Date.parse(record.startsAt) && time < Date.parse(record.endsAt);
  const result = resolveTrackedIntent({
    snapshot: {
      token: record.token,
      campaignId: record.campaignId,
      contentId: record.contentId,
      cta: record.cta,
      language: record.language,
    },
    currentCta: record.cta,
    destinationAvailable: record.destinationAvailable && inWindow,
    hubAvailable: fresh,
    emergencyStop: record.status !== "ACTIVE",
  });
  const fallbackReason: SocialLinkFallbackReason | null = !result.usedFallback
    ? null
    : record.status !== "ACTIVE"
      ? (record.fallbackReason ?? "SOURCE_OR_ACTIVATION_WITHDRAWN")
      : !fresh
        ? "VALIDATION_STALE"
        : !inWindow
          ? "CAMPAIGN_OUTSIDE_WINDOW"
          : !record.destinationAvailable
            ? "DESTINATION_UNAVAILABLE"
            : "CTA_CHANGED";
  return { ...result, fallbackReason };
}

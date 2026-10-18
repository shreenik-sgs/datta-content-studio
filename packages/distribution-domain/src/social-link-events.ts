import type { SocialPlacement } from "./activation-package";
export const SOCIAL_LINK_FALLBACK_REASONS = [
  "DESTINATION_UNAVAILABLE",
  "SOURCE_OR_ACTIVATION_WITHDRAWN",
  "CAMPAIGN_OUTSIDE_WINDOW",
  "VALIDATION_STALE",
  "CTA_CHANGED",
  "FEATURE_UNAVAILABLE",
] as const;
export type SocialLinkFallbackReason = (typeof SOCIAL_LINK_FALLBACK_REASONS)[number];
/** Anonymous operational receipt. Never attach token, identity, IP, user agent or referrer. */
export type SocialLinkReceipt = {
  version: 1;
  isTest: true;
  id: string;
  occurredAt: string;
  name: "tracked_link_resolved" | "tracked_link_fallback_used" | "activation_destination_validated";
  activationId: string;
  campaignId: string;
  contentId: string;
  derivativeId: string;
  ctaId: string;
  channel: SocialPlacement;
  canonicalId: string | null;
  fallbackReason: SocialLinkFallbackReason | null;
};

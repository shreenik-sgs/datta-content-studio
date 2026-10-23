import type { ContentState } from "./index";

export const DISTRIBUTION_CAPABILITIES = [
  "content.create",
  "content.review",
  "content.publish",
  "channels.manage",
  "campaigns.manage",
  "analytics.view",
  "operations.manage",
] as const;
export type DistributionCapability = (typeof DISTRIBUTION_CAPABILITIES)[number];
export const DISTRIBUTION_CHANNELS = [
  "manual_export",
  "youtube",
  "telegram",
  "whatsapp",
  "instagram",
  "facebook",
  "x",
  "reddit",
  "tiktok",
  "threads",
  "linkedin",
  "pinterest",
  "bluesky",
  "website",
] as const;
export type DistributionChannel = (typeof DISTRIBUTION_CHANNELS)[number];
export const CONTENT_CATEGORIES = [
  "sacred_flute",
  "gita",
  "bhajans",
  "pravachanams",
  "yoga",
  "seva",
  "other",
] as const;
export type ContentCategory = (typeof CONTENT_CATEGORIES)[number];

export type DistributionOperator = { id: string; roles: string[]; isTest: boolean; locale: string };
/** Role names belong to the versioned identity assertion, never to provider claims. */
export function isDistributionAdministrator(roles: readonly string[]): boolean {
  return roles.includes("TECH_SUPER_ADMIN") || roles.includes("SUPER_ADMIN");
}
/** Entry to the workspace; each operation still checks its distinct capability. */
export function isDistributionOperator(roles: readonly string[]): boolean {
  return (
    roles.includes("CONTENT_COORDINATOR") ||
    roles.includes("CONTENT_APPROVER") ||
    isDistributionAdministrator(roles)
  );
}
/** Two explicit workflow roles own creation and review/publishing.
 * Administrator status alone never grants content approval or publication.
 * Existing campaign/channel/analytics/operations permissions stay explicitly granted
 * to administrators. These permissions grant no Datta Circle authority.
 */
export function distributionRoleCapabilities(
  roles: readonly string[],
  grants: readonly string[] = [],
): DistributionCapability[] {
  const allowed = new Set<DistributionCapability>();
  if (roles.includes("CONTENT_COORDINATOR")) allowed.add("content.create");
  if (roles.includes("CONTENT_APPROVER")) {
    allowed.add("content.review");
    allowed.add("content.publish");
  }
  if (isDistributionAdministrator(roles)) {
    for (const capability of [
      "campaigns.manage",
      "channels.manage",
      "analytics.view",
      "operations.manage",
    ] as const)
      if (grants.includes(capability)) allowed.add(capability);
  }
  return DISTRIBUTION_CAPABILITIES.filter((capability) => allowed.has(capability));
}
export function hasDistributionCapability(
  operator: DistributionOperator,
  grants: readonly string[],
  capability: DistributionCapability,
): boolean {
  return (
    operator.id.length > 0 &&
    distributionRoleCapabilities(operator.roles, grants).includes(capability)
  );
}

/** Self-review is allowed only when both workflow roles are explicitly assigned. */
export function requireIndependentContentReview(
  reviewerId: string,
  contributorIds: readonly string[],
  reviewerRoles: readonly string[] = [],
): void {
  if (
    !reviewerId.trim() ||
    !contributorIds.length ||
    contributorIds.some((id) => !id.trim()) ||
    (contributorIds.includes(reviewerId) &&
      !(
        reviewerRoles.includes("CONTENT_COORDINATOR") && reviewerRoles.includes("CONTENT_APPROVER")
      ))
  )
    throw new Error("INDEPENDENT_REVIEW_REQUIRED");
}

export type ContentRights = {
  owner: string;
  territories: string[];
  channels: DistributionChannel[];
  authorizationBasis: string;
  privacyClass: "PUBLIC" | "INTERNAL" | "RESTRICTED";
  releaseAt: string | null;
  expiresAt: string | null;
};
export type ContentVersion = {
  id: string;
  masterId: string;
  number: number;
  sha256: string;
  byteSize: number;
  mimeType: string;
  originalName: string;
  createdAt: string;
  createdBy: string;
};
export type ContentApproval = {
  versionId: string;
  approvedRevision: number;
  reviewerId: string;
  approvedAt: string;
};
export type ContentMaster = {
  /** Workspace label only; does not change source evidence or approved media. */
  workspaceName?: string | null | undefined;
  sourceUrl?: string | undefined;
  id: string;
  title: string;
  language: string;
  category: ContentCategory;
  isTest: boolean;
  revision: number;
  state: ContentState;
  currentVersion: ContentVersion;
  rights: ContentRights | null;
  approval: ContentApproval | null;
  createdAt: string;
  updatedAt: string;
};
export function contentDisplayName(content: Pick<ContentMaster, "title" | "workspaceName">) {
  return content.workspaceName || content.title;
}
export function requireContentRevision(actual: number, expected: number): void {
  if (
    !Number.isSafeInteger(actual) ||
    actual < 1 ||
    !Number.isSafeInteger(expected) ||
    expected < 1 ||
    actual !== expected
  )
    throw new Error("REVISION_CONFLICT");
}
const isIsoInstant = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const nonblank = (value: string, maximum: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
/** Throws before rights can be saved, regardless of which adapter supplies them. */
export function validateContentRights(rights: ContentRights): void {
  if (
    !nonblank(rights.owner, 200) ||
    !nonblank(rights.authorizationBasis, 2000) ||
    !["PUBLIC", "INTERNAL", "RESTRICTED"].includes(rights.privacyClass) ||
    !Array.isArray(rights.channels) ||
    rights.channels.length < 1 ||
    rights.channels.length > DISTRIBUTION_CHANNELS.length ||
    new Set(rights.channels).size !== rights.channels.length ||
    rights.channels.some((channel) => !DISTRIBUTION_CHANNELS.includes(channel)) ||
    !Array.isArray(rights.territories) ||
    rights.territories.length < 1 ||
    rights.territories.length > 250 ||
    new Set(rights.territories).size !== rights.territories.length ||
    rights.territories.some((territory) => !/^(?:WORLDWIDE|[A-Z]{2})$/.test(territory)) ||
    (rights.releaseAt !== null && !isIsoInstant(rights.releaseAt)) ||
    (rights.expiresAt !== null && !isIsoInstant(rights.expiresAt)) ||
    (rights.releaseAt !== null &&
      rights.expiresAt !== null &&
      Date.parse(rights.releaseAt) >= Date.parse(rights.expiresAt))
  )
    throw new Error("INVALID_RIGHTS");
}
export type ExportRefusal =
  | "WITHDRAWN"
  | "NOT_APPROVED"
  | "APPROVAL_STALE"
  | "RIGHTS_MISSING"
  | "INVALID_RIGHTS"
  | "INVALID_TIME"
  | "RELEASE_PENDING"
  | "RIGHTS_EXPIRED"
  | "CHANNEL_NOT_PERMITTED"
  | "TERRITORY_NOT_PERMITTED"
  | "RESTRICTED_CONTENT";
export type ExportDecision = { allowed: true } | { allowed: false; reason: ExportRefusal };
/** Caller rechecks inside the same command transaction; prior downloads cannot be recalled. */
export function contentExportDecision(input: {
  content: ContentMaster;
  channel: DistributionChannel;
  territory: string;
  now: string;
}): ExportDecision {
  const { content, channel, territory, now } = input;
  const refuse = (reason: ExportRefusal): ExportDecision => ({ allowed: false, reason });
  if (content.state === "WITHDRAWN") return refuse("WITHDRAWN");
  if (content.state !== "APPROVED" && content.state !== "PUBLISHED") return refuse("NOT_APPROVED");
  if (
    !content.approval ||
    content.approval.versionId !== content.currentVersion.id ||
    content.approval.approvedRevision !== content.revision
  )
    return refuse("APPROVAL_STALE");
  if (!content.rights) return refuse("RIGHTS_MISSING");
  try {
    validateContentRights(content.rights);
  } catch {
    return refuse("INVALID_RIGHTS");
  }
  if (!isIsoInstant(now)) return refuse("INVALID_TIME");
  const rights = content.rights;
  const timestamp = Date.parse(now);
  if (rights.releaseAt !== null && timestamp < Date.parse(rights.releaseAt))
    return refuse("RELEASE_PENDING");
  if (rights.expiresAt !== null && timestamp >= Date.parse(rights.expiresAt))
    return refuse("RIGHTS_EXPIRED");
  if (
    rights.privacyClass === "RESTRICTED" ||
    (rights.privacyClass === "INTERNAL" && channel !== "manual_export")
  )
    return refuse("RESTRICTED_CONTENT");
  if (!rights.channels.includes(channel)) return refuse("CHANNEL_NOT_PERMITTED");
  if (
    !/^(?:WORLDWIDE|[A-Z]{2})$/.test(territory) ||
    (!rights.territories.includes("WORLDWIDE") && !rights.territories.includes(territory))
  )
    return refuse("TERRITORY_NOT_PERMITTED");
  return { allowed: true };
}

export function contentStateAfterEdit(
  state: ContentState,
  change: "metadata" | "rights" | "version",
): ContentState {
  if (state === "WITHDRAWN") throw new Error(`INVALID_TRANSITION:${state}:${change}`);
  if (change === "version") return "DRAFT";
  if (change === "rights") return "RIGHTS_CLEARED";
  return state === "DRAFT" ? "DRAFT" : "RIGHTS_CLEARED";
}
export type ApprovalDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "NOT_READY_FOR_REVIEW"
        | "RIGHTS_MISSING"
        | "INVALID_RIGHTS"
        | "INVALID_TIME"
        | "RIGHTS_EXPIRED";
    };
/** Scheduled masters may be reviewed ahead of release; exporting checks that date again. */
export function contentApprovalDecision(input: {
  content: ContentMaster;
  now: string;
}): ApprovalDecision {
  const { content, now } = input;
  if (content.state !== "RIGHTS_CLEARED") return { allowed: false, reason: "NOT_READY_FOR_REVIEW" };
  if (!content.rights) return { allowed: false, reason: "RIGHTS_MISSING" };
  try {
    validateContentRights(content.rights);
  } catch {
    return { allowed: false, reason: "INVALID_RIGHTS" };
  }
  if (!isIsoInstant(now)) return { allowed: false, reason: "INVALID_TIME" };
  if (content.rights.expiresAt !== null && Date.parse(now) >= Date.parse(content.rights.expiresAt))
    return { allowed: false, reason: "RIGHTS_EXPIRED" };
  return { allowed: true };
}

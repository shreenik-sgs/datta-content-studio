export const DISTRIBUTION_QUEUE_PREFIX = "distribution:" as const;

export const DISTRIBUTION_STORAGE_PREFIXES = {
  masters: "distribution/masters/",
  derivatives: "distribution/derivatives/",
} as const;

export const DISTRIBUTION_STAGES = ["OFF", "TEST", "LIMITED", "ON"] as const;
export type DistributionStage = (typeof DISTRIBUTION_STAGES)[number];

export type DistributionAudience = {
  isOperator: boolean;
  isTest: boolean;
};

export type DistributionGateInput = {
  featureEnabled: boolean;
  stage: string | undefined;
  audience: DistributionAudience;
};

export function normalizeDistributionStage(value: string | undefined): DistributionStage {
  return DISTRIBUTION_STAGES.includes(value as DistributionStage)
    ? (value as DistributionStage)
    : "OFF";
}

export function distributionAccess(
  value: string | undefined,
  audience: DistributionAudience,
): boolean {
  const stage = normalizeDistributionStage(value);
  if (!audience.isOperator || stage === "OFF") return false;
  return stage !== "TEST" || audience.isTest;
}

export function distributionGate(input: DistributionGateInput): boolean {
  return input.featureEnabled && distributionAccess(input.stage, input.audience);
}

const distributionQueues = new Set([
  "distribution:content.ingest",
  "distribution:release.dispatch",
]);

export function isDistributionQueue(name: string): boolean {
  return distributionQueues.has(name);
}

export function distributionStorageKey(
  namespace: keyof typeof DISTRIBUTION_STORAGE_PREFIXES,
  relativePath: string,
): string {
  const unsafe =
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("..") ||
    [...relativePath].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
  if (unsafe) throw new Error("INVALID_STORAGE_KEY");
  return `${DISTRIBUTION_STORAGE_PREFIXES[namespace]}${relativePath}`;
}

export type ContentState = "DRAFT" | "RIGHTS_CLEARED" | "APPROVED" | "PUBLISHED" | "WITHDRAWN";
export type ContentAction = "CLEAR_RIGHTS" | "APPROVE" | "PUBLISH" | "WITHDRAW";

const transitions: Partial<Record<ContentState, Partial<Record<ContentAction, ContentState>>>> = {
  DRAFT: { CLEAR_RIGHTS: "RIGHTS_CLEARED", WITHDRAW: "WITHDRAWN" },
  RIGHTS_CLEARED: { APPROVE: "APPROVED", WITHDRAW: "WITHDRAWN" },
  APPROVED: { PUBLISH: "PUBLISHED", WITHDRAW: "WITHDRAWN" },
  PUBLISHED: { WITHDRAW: "WITHDRAWN" },
};

export function nextContentState(state: ContentState, action: ContentAction): ContentState {
  const next = transitions[state]?.[action];
  if (!next) throw new Error(`INVALID_TRANSITION:${state}:${action}`);
  return next;
}

export * from "./content";
export * from "./uploads";
export * from "./studio-audio";
export * from "./studio-media-edits";
export * from "./studio-additional-message";
export * from "./live-curation";

export * from "./intelligence";

export * from "./variants";

export * from "./outreach";
export * from "./tracked-links";

export * from "./native-intelligence";

export * from "./native-recognition";

export * from "./native-bakeoff";

export * from "./analytics";

export * from "./channel-publishing";

export * from "./content-pack";

export * from "./activation-package";

export * from "./social-link-events";

export * from "./asset-names";
export * from "./intelligent-content";
export * from "./studio-assets";
export * from "./studio-planner";
export * from "./studio-validation";

export * from "./studio-workflow";

export * from "./studio-progress";

export * from "./studio-corrections";

export * from "./studio-content-review";
export * from "./studio-boundary-review";
export * from "./studio-presentation";
export * from "./studio-ending";
export * from "./studio-closing-destination";
export * from "./studio-visual-preferences";

export * from "./online-video";
export * from "./import-recovery";

export * from "./studio-post-art";
export * from "./studio-audio-analysis";
export * from "./storage-cleanup";

export * from "./studio-source-branding";

export * from "./studio-discovery";
export * from "./studio-posting-check";
export * from "./studio-bulk-actions";

export * from "./reviewer-languages.js";

import type { ContentCategory, ContentMaster } from "./content";
import type {
  StudioAiReviewEvidence,
  StudioContentReview,
  StudioExcludedMessage,
} from "./studio-content-review";

export const STUDIO_CHANNELS = [
  "youtube",
  "instagram",
  "facebook",
  "x",
  "reddit",
  "tiktok",
  "threads",
  "linkedin",
  "pinterest",
  "telegram",
  "whatsapp",
  "bluesky",
  "website",
] as const;
export type StudioChannel = (typeof STUDIO_CHANNELS)[number];
export const STUDIO_LANGUAGES = ["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"] as const;
export type StudioLanguage = (typeof STUDIO_LANGUAGES)[number];
export type StudioFormat = "short" | "reel" | "video" | "post" | "blog";
export type StudioStatus =
  | "QUEUED"
  | "GENERATING"
  | "DRAFT"
  | "IN_REVIEW"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "DISCARDED"
  | "FAILED";
export type StudioAsset = {
  /** Logical channel/output binding when several outputs share immutable stored bytes. */
  identityKey?: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  filename: string;
};
export type StudioSegment = { id: string; startMs: number; endMs: number; text: string };
export type StudioTranscript = {
  language: string;
  durationMs: number;
  segments: StudioSegment[];
  provenance: "APPROVED_TRANSCRIPT" | "MACHINE_TRANSCRIPT";
  sourceTranscriptId: string | null;
  recognition?: { provider: "sarvam" | "openai"; model: string };
};
export type StudioOutput = {
  /** Human workflow for this exact file; absent on legacy package-wide reviews. */
  workflow?: import("./studio-file-workflow").StudioFileWorkflow;
  /** Curator-selected, exact source times. Transcript evidence remains unchanged. */
  sourceTrim?: { startMs: number; endMs: number } | null;
  /** Retained across invalidated render reviews; configured package branding takes precedence. */
  closingDestination?: "app" | "youtube";
  mediaEdits?: import("./studio-media-edits").StudioMediaEdits;
  postArt?: import("./studio-post-art").StudioPostArt | null;
  presentationReview?: import("./studio-presentation").StudioPresentationReview | null;
  /** Stable teaching identity across channels, languages, corrections and AI reviews. */
  messageId?: string;
  aiReview?: StudioAiReviewEvidence | null;
  fileVersion?: number;
  generatedAt?: string;
  captionCues?: StudioSegment[];
  correction?: {
    comment: string;
    reviewerId: string;
    requestedAt: string;
    state: "pending" | "revised" | "submitted" | "resolved";
    before: {
      title: string;
      body: string;
      sourceSegmentIds: string[];
      sourceTrim?: { startMs: number; endMs: number } | null;
      captionCues?: StudioSegment[];
      mediaEdits?: import("./studio-media-edits").StudioMediaEdits;
      aiReview?: StudioAiReviewEvidence;
    };
  };
  id: string;
  channel: StudioChannel;
  format: StudioFormat;
  language: StudioLanguage;
  title: string;
  body: string;
  rationale: string;
  included: boolean;
  sourceSegmentIds: string[];
  startMs: number | null;
  endMs: number | null;
  aspect: "9:16" | "4:5" | "1:1" | "16:9" | "prose";
  asset: StudioAsset | null;
  /** Separate title artwork; never burned into the playing video. */
  thumbnail?: StudioAsset;
  captions: { language: StudioLanguage; asset: StudioAsset; translated: boolean }[];
  warnings: string[];
};
export type StudioGenerationRequest = {
  /** Format for newly discovered YouTube passages; omitted legacy requests remain Shorts. */
  youtubeFormat?: "short" | "video" | undefined;
  sourceBranding?: import("./studio-source-branding").StudioSourceBranding | undefined;
  youtubeClosing?: import("./studio-ending").StudioYoutubeClosing | undefined;
  /** Legacy requests omit this; new curation discovers every suitable complete message. */
  allCompleteMessages?: boolean | undefined;
  languages: StudioLanguage[];
  instructions: string;
  channels: StudioChannel[];
  captions: boolean;
};
export type StudioProvenance = {
  discovery?: import("./studio-discovery").StudioDiscoveryCoverage;
  excludedMessages?: StudioExcludedMessage[];
  draftingProviders?: { provider: "gemini" | "openai"; model: string }[];
  provider: "local" | "openai" | "gemini";
  inputMode?: "transcript" | "transcript_and_audio";
  model: string;
  promptVersion: string;
  generatedAt: string;
  brandName: string;
  /** No portrait/logo asset is used for text-only alternate-source branding. */
  brandLogoSha256: string | null;
  sourceBranding?: import("./studio-source-branding").StudioSourceBranding;
  transcript: StudioTranscript;
  skippedChannels: { channel: StudioChannel; reason: string }[];
};
export type StudioFeedback = {
  id: string;
  actorId: string;
  action: "APPROVED" | "REJECTED" | "DISCARDED" | "REVISED" | "SUBMITTED";
  comment: string;
  revision: number;
  createdAt: string;
};
export type StudioApproval = {
  reviewerId: string;
  revision: number;
  sourceRevision: number;
  approvedAt: string;
};
export type StudioSource = {
  /** Internal live-window ownership. A teaching starting in the overlap belongs to the next window. */
  liveWindow?: { broadcastId: string; windowId: string; startOffsetMs: number; ownedEndMs: number };
  masterId: string;
  versionId: string;
  sha256: string;
  revision: number;
  title: string;
  language: string;
  category: ContentCategory;
  mimeType: string;
};
export type StudioGenerationProgress = {
  discoverySection?: number;
  discoverySections?: number;
  phase: "source" | "transcription" | "drafting" | "reviewing" | "rendering" | "complete";
  provider: "local" | "sarvam" | "gemini" | "openai";
  completed: number;
  total: number;
  language?: StudioLanguage;
  channel?: StudioChannel;
  retryAt?: string;
  errorCode?: string;
  reviewIssues?: StudioContentReview[];
  presentationIssues?: string[];
  /** Source suitability decisions, not service errors or approval of an empty package. */
  excludedChannels?: { channel: StudioChannel; reason: string }[];
  /** The rendering/review pipeline of the worker that recorded a failure. */
  mediaPipeline?: string;
  /** The one automatic retry this failed job received under a newer pipeline. */
  recovery?: import("./studio-generation-recovery").StudioGenerationRecoveryRecord;
};
/** A repeat of unchanged settings cannot repair a source-suitability decision. */
export function studioNeedsSuitabilityReview(code?: string | null): boolean {
  return code === "STUDIO_NO_SUITABLE_CHANNELS";
}
export type StudioPackage = {
  /** Read-only renders from the current initial job; never eligible for editing or posting. */
  generationPreviews?: StudioGenerationPreview[];
  id: string;
  isTest: boolean;
  revision: number;
  status: StudioStatus;
  source: StudioSource;
  createdBy: string;
  contributorIds: string[];
  request: StudioGenerationRequest;
  generation?: {
    outputIds: string[];
    mode: "ai" | "render" | "closing" | "discover";
    steadyOpening?: true;
    closingDestinations?: Record<string, "app" | "youtube">;
    illustrationTimings?: import("./studio-presentation").StudioIllustrationTiming[];
  } | null;
  outputs: StudioOutput[];
  provenance: StudioProvenance | null;
  approval: StudioApproval | null;
  feedback: StudioFeedback[];
  failure: string | null;
  generationProgress?: StudioGenerationProgress | null;
  createdAt: string;
  updatedAt: string;
};
export type StudioGenerationPreview = Pick<
  StudioOutput,
  | "id"
  | "title"
  | "channel"
  | "language"
  | "format"
  | "generatedAt"
  | "asset"
  | "captions"
  | "thumbnail"
> & {
  /** Read-only render from before the current job; never an approval candidate. */
  fromPreviousRun?: boolean;
};
export type StudioPublicationStatus =
  | "QUEUED"
  | "RUNNING"
  | "PROCESSING"
  | "PUBLISHED"
  | "SIMULATED"
  | "BLOCKED"
  | "FAILED"
  | "UNCERTAIN"
  | "CANCELLED";
export type StudioPublication = {
  duplicateCheck?: import("./studio-posting-check").PostingCheck | null;
  id: string;
  packageId: string;
  packageRevision: number;
  outputId: string;
  channel: StudioChannel;
  isTest: boolean;
  status: StudioPublicationStatus;
  accountId: string | null;
  attempt: number;
  error: string | null;
  /** The channel's own reason for a refusal, as reported by the provider; null when it gave none. */
  errorDetail: string | null;
  remoteId: string | null;
  remoteUrl: string | null;
  createdAt: string;
  updatedAt: string;
};
export type StudioReadiness = {
  generation: {
    available: boolean;
    transcription: string;
    intelligence: string;
    translation: boolean;
    reason: string | null;
  };
  channels: {
    channel: StudioChannel;
    label: string;
    ready: boolean;
    reason: string | null;
    accountId: string | null;
    transport: string;
    accounts?: {
      id: string;
      label: string;
      isDefault: boolean;
      ready: boolean;
      reason: string | null;
      privacy?: string;
      connectionPending?: boolean;
      channelUrl?: string;
    }[];
  }[];
  isTest: boolean;
};

/** Approval may follow initial generation, but a changed recording or source meaning is never silently adopted. */
export function studioSourceMatches(source: StudioSource, master: ContentMaster): boolean {
  return (
    source.masterId === master.id &&
    source.versionId === master.currentVersion.id &&
    source.sha256 === master.currentVersion.sha256 &&
    source.title === master.title &&
    source.language === master.language &&
    source.category === master.category
  );
}

export function studioChannelLabel(channel: StudioChannel): string {
  return {
    youtube: "YouTube Shorts",
    instagram: "Instagram",
    facebook: "Facebook",
    x: "X",
    reddit: "Reddit",
    tiktok: "TikTok",
    threads: "Threads",
    linkedin: "LinkedIn",
    pinterest: "Pinterest",
    telegram: "Telegram",
    whatsapp: "WhatsApp Business",
    bluesky: "Bluesky",
    website: "Ashrama blog",
  }[channel];
}

/** A legacy single account is its default; multiple accounts require an explicit default. */
export function studioDefaultAccount<T extends { platform: StudioChannel; isDefault?: boolean }>(
  accounts: readonly T[],
  channel: StudioChannel,
): T | undefined {
  const candidates = accounts.filter((account) => account.platform === channel);
  return (
    candidates.find((account) => account.isDefault) ??
    (candidates.length === 1 ? candidates[0] : undefined)
  );
}

/** Resolve an explicit destination per platform before queuing; never accept an arbitrary ID. */
export function studioPublishingAccounts(
  configured: readonly {
    id: string;
    platform: StudioChannel;
    isDefault?: boolean;
    connectionPending?: boolean;
  }[],
  channels: readonly StudioChannel[],
  selected: Partial<Record<StudioChannel, string>>,
  isTest: boolean,
): Partial<Record<StudioChannel, string>> {
  const result: Partial<Record<StudioChannel, string>> = {};
  if (
    Object.keys(selected).some(
      (channel) => channel === "website" || !channels.includes(channel as StudioChannel),
    )
  )
    throw Error("STUDIO_PUBLISH_ACCOUNT_INVALID");
  for (const channel of new Set(channels)) {
    if (channel === "website") continue;
    const id = selected[channel];
    const account = id
      ? configured.find((a) => a.id === id && a.platform === channel)
      : studioDefaultAccount(configured, channel);
    if (id && !account) throw Error("STUDIO_PUBLISH_ACCOUNT_INVALID");
    if (account?.connectionPending) throw Error("STUDIO_PUBLISH_ACCOUNT_REQUIRED");
    if (!account && (!isTest || configured.some((a) => a.platform === channel)))
      throw Error("STUDIO_PUBLISH_ACCOUNT_REQUIRED");
    if (account) result[channel] = account.id;
  }
  return result;
}

export function studioOutputChannelLabel(output: Pick<StudioOutput, "channel" | "format">): string {
  return output.channel === "youtube" && output.format === "video"
    ? "YouTube video"
    : studioChannelLabel(output.channel);
}

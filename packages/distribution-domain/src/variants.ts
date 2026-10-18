import { SOCIAL_PLACEMENTS, type SocialPlacement } from "./activation-package";
import { type ContentMaster, type DistributionChannel, contentExportDecision } from "./content";
import {
  type EditorialReview,
  type QuoteCandidate,
  type TranscriptVersion,
  isEditorialApproved,
  quoteReviewDecision,
  sourceContextWindow,
  validateTranscript,
} from "./intelligence";
export const VARIANT_ASPECTS = ["16:9", "9:16", "4:5", "1:1"] as const;
export type VariantAspect = (typeof VARIANT_ASPECTS)[number];
const dimensions: Record<VariantAspect, readonly [number, number]> = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "4:5": [1080, 1350],
  "1:1": [1080, 1080],
};
export type ApprovedTranslation = {
  id: string;
  sourceId: string;
  sourceRevision: number;
  sourceSha256: string;
  startMs: number;
  endMs: number;
  language: string;
  text: string;
  revision: number;
  review: EditorialReview | null;
};
export type RenderRecipe = {
  /** Intended destination; transport authorization continues to use channel. */
  placement?: SocialPlacement;
  nativeApproval?: { analysisId: string; candidateId: string; reviewRevision: number } | undefined;
  schemaVersion: 1;
  sourceVersionId: string;
  sourceSha256: string;
  sourceRevision: number;
  transcriptVersionId: string;
  transcriptRevision: number;
  quoteId: string | null;
  quoteRevision: number | null;
  translationId: string | null;
  translationRevision: number | null;
  template: { id: string; version: number };
  aspect: VariantAspect;
  width: number;
  height: number;
  fit: "contain";
  language: string;
  startMs: number;
  endMs: number;
  captions: { startMs: number; endMs: number; text: string }[];
  channel: DistributionChannel;
  territory: string;
};
export function buildRenderRecipe(input: {
  placement?: SocialPlacement;
  master: ContentMaster;
  transcript: TranscriptVersion;
  quote?: QuoteCandidate | undefined;
  translation?: ApprovedTranslation | undefined;
  template: { id: string; version: number };
  aspect: VariantAspect;
  language: string;
  startMs: number;
  endMs: number;
  captionMode: "none" | "approved_transcript" | "approved_quote";
  channel: DistributionChannel;
  territory: string;
  now: string;
}): RenderRecipe {
  const { master, transcript, quote, translation } = input;
  if (
    input.placement !== undefined &&
    (!SOCIAL_PLACEMENTS.includes(input.placement) ||
      (input.channel === "youtube" && !["youtube", "youtube_shorts"].includes(input.placement)) ||
      (input.channel === "telegram" && input.placement !== "telegram"))
  )
    throw new Error("INVALID_RENDER_PLACEMENT");
  const access = contentExportDecision({
    content: master,
    channel: input.channel,
    territory: input.territory,
    now: input.now,
  });
  if (!access.allowed) throw new Error(access.reason);
  validateTranscript(transcript);
  if (
    transcript.masterVersionId !== master.currentVersion.id ||
    transcript.sourceSha256 !== master.currentVersion.sha256
  )
    throw new Error("SOURCE_MISMATCH");
  if (!isEditorialApproved(transcript.review, transcript.revision))
    throw new Error("TRANSCRIPT_NOT_APPROVED");
  sourceContextWindow({
    startMs: input.startMs,
    endMs: input.endMs,
    durationMs: transcript.durationMs,
    contextMs: 0,
  });
  if (
    !dimensions[input.aspect] ||
    !input.template.id.trim() ||
    input.template.id.length > 100 ||
    !Number.isSafeInteger(input.template.version) ||
    input.template.version < 1
  )
    throw new Error("INVALID_TEMPLATE");
  if (!["none", "approved_transcript", "approved_quote"].includes(input.captionMode))
    throw new Error("INVALID_CAPTION_MODE");
  let captions: RenderRecipe["captions"] = [];
  let quoteId: string | null = null;
  let quoteRevision: number | null = null;
  if (input.captionMode === "approved_quote") {
    if (!quote || !isEditorialApproved(quote.review, quote.revision))
      throw new Error("QUOTE_NOT_APPROVED");
    const decision = quoteReviewDecision({ quote, transcript });
    if (!decision.allowed) throw new Error(decision.reason);
    if (input.startMs !== quote.startMs || input.endMs !== quote.endMs)
      throw new Error("INVALID_SOURCE_SPAN");
    quoteId = quote.id;
    quoteRevision = quote.revision;
    captions = [{ startMs: 0, endMs: input.endMs - input.startMs, text: quote.text }];
  } else if (input.captionMode === "approved_transcript") {
    const segments = transcript.segments.filter(
      (segment) => segment.endMs > input.startMs && segment.startMs < input.endMs,
    );
    if (segments.some((segment) => segment.startMs < input.startMs || segment.endMs > input.endMs))
      throw new Error("PARTIAL_CAPTION_SEGMENT");
    captions = segments.map((segment) => ({
      startMs: segment.startMs - input.startMs,
      endMs: segment.endMs - input.startMs,
      text: segment.displayText,
    }));
  }
  let translationId: string | null = null;
  let translationRevision: number | null = null;
  if (input.language !== transcript.language) {
    if (
      input.captionMode === "none" ||
      !translation ||
      !isEditorialApproved(translation.review, translation.revision) ||
      translation.sourceId !== (quoteId ?? transcript.id) ||
      translation.sourceRevision !== (quoteRevision ?? transcript.revision) ||
      translation.sourceSha256 !== transcript.sourceSha256 ||
      translation.language !== input.language ||
      translation.startMs !== input.startMs ||
      translation.endMs !== input.endMs ||
      !translation.text.trim() ||
      translation.text.length > 20000
    )
      throw new Error("TRANSLATION_NOT_APPROVED");
    captions = [{ startMs: 0, endMs: input.endMs - input.startMs, text: translation.text }];
    translationId = translation.id;
    translationRevision = translation.revision;
  }
  const size = dimensions[input.aspect];
  return {
    ...(input.placement !== undefined ? { placement: input.placement } : {}),
    schemaVersion: 1,
    sourceVersionId: master.currentVersion.id,
    sourceSha256: master.currentVersion.sha256,
    sourceRevision: master.revision,
    transcriptVersionId: transcript.id,
    transcriptRevision: transcript.revision,
    quoteId,
    quoteRevision,
    translationId,
    translationRevision,
    template: { id: input.template.id, version: input.template.version },
    aspect: input.aspect,
    width: size[0],
    height: size[1],
    fit: "contain",
    language: input.language,
    startMs: input.startMs,
    endMs: input.endMs,
    captions,
    channel: input.channel,
    territory: input.territory,
  };
}
/** Adapter hashes these canonical bytes; no runtime-specific hash or IO enters the rule. */
export function canonicalRenderRecipe(recipe: RenderRecipe): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return value;
  };
  return JSON.stringify(canonical(recipe));
}
export function renderBudgetDecision(input: {
  estimatedCostMicros: number;
  budgetMicros: number;
  reservedMicros: number;
  spentMicros: number;
  attempt: number;
  maxAttempts: number;
  approvedCostCeilingMicros: number;
}):
  | { allowed: true }
  | {
      allowed: false;
      reason: "INVALID_BUDGET" | "BUDGET_EXCEEDED" | "COST_APPROVAL_REQUIRED" | "RETRY_LIMIT";
    } {
  if (
    Object.values(input).some((value) => !Number.isSafeInteger(value) || value < 0) ||
    input.attempt < 1 ||
    input.maxAttempts < 1 ||
    input.maxAttempts > 10
  )
    return { allowed: false, reason: "INVALID_BUDGET" };
  if (input.attempt > input.maxAttempts) return { allowed: false, reason: "RETRY_LIMIT" };
  if (input.estimatedCostMicros > input.approvedCostCeilingMicros)
    return { allowed: false, reason: "COST_APPROVAL_REQUIRED" };
  if (
    BigInt(input.estimatedCostMicros) + BigInt(input.reservedMicros) + BigInt(input.spentMicros) >
    BigInt(input.budgetMicros)
  )
    return { allowed: false, reason: "BUDGET_EXCEEDED" };
  return { allowed: true };
}

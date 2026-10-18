import { SOCIAL_PLACEMENTS, VARIANT_ASPECTS } from "@satsang/distribution-domain";
import { z } from "zod";
import { contentLanguageSchema, distributionChannelSchema } from "./content";
import { editorialReviewSchema } from "./intelligence";
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const template = z.object({ id: z.string().trim().min(1).max(100), version: revision }).strict();
export const variantAspectSchema = z.enum(VARIANT_ASPECTS);
const territory = z.string().regex(/^(?:WORLDWIDE|[A-Z]{2})$/);
export const renderRequestSchema = z
  .object({
    placement: z.enum(SOCIAL_PLACEMENTS).optional(),
    masterId: z.string().uuid(),
    expectedSourceRevision: revision,
    transcriptVersionId: z.string().uuid(),
    quoteId: z.string().uuid().nullable(),
    translationId: z.string().uuid().nullable(),
    template,
    aspect: variantAspectSchema,
    language: contentLanguageSchema,
    startMs: nonnegative,
    endMs: revision,
    captionMode: z.enum(["none", "approved_transcript", "approved_quote"]),
    channel: distributionChannelSchema,
    territory,
  })
  .strict()
  .refine(
    (value) =>
      value.endMs > value.startMs &&
      (value.placement === undefined ||
        value.channel === "manual_export" ||
        (value.channel === "youtube" && ["youtube", "youtube_shorts"].includes(value.placement)) ||
        (value.channel === "telegram" && value.placement === "telegram")) &&
      (value.captionMode !== "approved_quote" || value.quoteId !== null),
    "INVALID_SOURCE_SPAN",
  );
export const approvedTranslationSchema = z
  .object({
    id: z.string().uuid(),
    sourceId: z.string().uuid(),
    sourceRevision: revision,
    sourceSha256: checksum,
    startMs: nonnegative,
    endMs: revision,
    language: contentLanguageSchema,
    text: z.string().trim().min(1).max(20000),
    revision,
    review: editorialReviewSchema.nullable(),
  })
  .strict()
  .refine((value) => value.endMs > value.startMs, "INVALID_SOURCE_SPAN");
const caption = z
  .object({ startMs: nonnegative, endMs: revision, text: z.string().min(1).max(20000) })
  .strict();
const dimensions = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "4:5": [1080, 1350],
  "1:1": [1080, 1080],
} as const;
export const renderRecipeSchema = z
  .object({
    placement: z.enum(SOCIAL_PLACEMENTS).optional(),
    nativeApproval: z
      .object({
        analysisId: z.string().uuid(),
        candidateId: z.string().min(1).max(128),
        reviewRevision: revision,
      })
      .strict()
      .optional(),
    schemaVersion: z.literal(1),
    sourceVersionId: z.string().uuid(),
    sourceSha256: checksum,
    sourceRevision: revision,
    transcriptVersionId: z.string().uuid(),
    transcriptRevision: revision,
    quoteId: z.string().uuid().nullable(),
    quoteRevision: revision.nullable(),
    translationId: z.string().uuid().nullable(),
    translationRevision: revision.nullable(),
    template,
    aspect: variantAspectSchema,
    width: revision,
    height: revision,
    fit: z.literal("contain"),
    language: contentLanguageSchema,
    startMs: nonnegative,
    endMs: revision,
    captions: z.array(caption).max(20000),
    channel: distributionChannelSchema,
    territory,
  })
  .strict()
  .superRefine((value, context) => {
    const size = dimensions[value.aspect];
    let previousEnd = 0;
    const badCaptions = value.captions.some((cue) => {
      const bad =
        cue.startMs < previousEnd ||
        cue.endMs <= cue.startMs ||
        cue.endMs > value.endMs - value.startMs;
      previousEnd = cue.endMs;
      return bad;
    });
    if (
      (value.placement !== undefined &&
        value.channel !== "manual_export" &&
        !(value.channel === "youtube" && ["youtube", "youtube_shorts"].includes(value.placement)) &&
        !(value.channel === "telegram" && value.placement === "telegram")) ||
      value.width !== size[0] ||
      value.height !== size[1] ||
      value.endMs <= value.startMs ||
      badCaptions ||
      (value.quoteId === null) !== (value.quoteRevision === null) ||
      (value.translationId === null) !== (value.translationRevision === null)
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_RENDER_RECIPE" });
  });
export const renderBudgetSchema = z
  .object({
    estimatedCostMicros: nonnegative,
    budgetMicros: nonnegative,
    reservedMicros: nonnegative,
    spentMicros: nonnegative,
    attempt: revision,
    maxAttempts: z.number().int().min(1).max(10),
    approvedCostCeilingMicros: nonnegative,
  })
  .strict();
export const derivativeAssetSchema = z
  .object({
    id: z.string().uuid(),
    revision,
    sourceVersionId: z.string().uuid(),
    recipeSha256: checksum,
    assetSha256: checksum,
    mimeType: z.enum(["video/mp4", "image/png", "image/jpeg", "audio/mpeg"]),
    byteSize: revision,
    width: revision.nullable(),
    height: revision.nullable(),
    approval: editorialReviewSchema.nullable(),
    withdrawn: z.boolean(),
  })
  .strict();
export type RenderRequest = z.infer<typeof renderRequestSchema>;

export const renderArtifactReviewSchema = z
  .object({
    expectedRevision: revision,
    expectedRecipeSha256: checksum,
    expectedAssetSha256: checksum,
    decision: z.enum(["APPROVED", "REJECTED"]),
  })
  .strict();
export type RenderArtifactReview = z.infer<typeof renderArtifactReviewSchema>;

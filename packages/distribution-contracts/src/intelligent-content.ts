import {
  STUDIO_CHANNELS,
  STUDIO_LANGUAGES,
  studioYoutubeClosing,
} from "@satsang/distribution-domain";
import { z } from "zod";

const youtubeClosing = z
  .object({ label: z.string(), url: z.string() })
  .strict()
  .transform((value, ctx) => {
    try {
      return studioYoutubeClosing(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Choose a valid YouTube channel name and HTTPS channel link",
      });
      return z.NEVER;
    }
  });
const revision = z.number().int().positive();
const unique = <T>(items: T[]) => new Set(items).size === items.length;
export const studioGenerationRequestSchema = z
  .object({
    languages: z.array(z.enum(STUDIO_LANGUAGES)).min(1).max(8).refine(unique),
    instructions: z.string().trim().max(4000),
    channels: z.array(z.enum(STUDIO_CHANNELS)).min(1).max(STUDIO_CHANNELS.length).refine(unique),
    captions: z.boolean(),
    allCompleteMessages: z.boolean().optional(),
    youtubeClosing: youtubeClosing.optional(),
    sourceBranding: z.literal("bala-swamiji").optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.sourceBranding ||
      (value.channels.length === 1 &&
        value.channels[0] === "youtube" &&
        Boolean(value.youtubeClosing)),
    {
      message: "Alternate source branding requires YouTube Shorts and a subscription destination",
      path: ["sourceBranding"],
    },
  );
export const studioCreateSchema = z
  .object({
    masterId: z.string().uuid(),
    expectedSourceRevision: revision,
    request: studioGenerationRequestSchema,
  })
  .strict();
export const studioMediaEditsSchema = z
  .object({
    framing: z.enum(["auto", "full-picture"]),
    portraitFocus: z.number().finite().min(0).max(1),
    captions: z.enum(["default", "on", "off"]),
    subtitleSize: z.enum(["small", "standard", "large"]),
    speechLevel: z.enum(["softer", "standard", "louder"]),
    reduceNoise: z.boolean(),
  })
  .strict();
export const studioReviseSchema = z
  .object({
    render: z.boolean().optional(),
    expectedRevision: revision,
    comment: z.string().trim().max(4000),
    outputs: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: z.string().trim().min(1).max(200),
            body: z.string().trim().min(1).max(20000),
            included: z.boolean(),
            sourceSegmentIds: z
              .array(z.string().min(1).max(200))
              .min(1)
              .max(10000)
              .refine(unique)
              .optional(),
            mediaEdits: studioMediaEditsSchema.optional(),
            captionCues: z
              .array(
                z
                  .object({
                    id: z.string().min(1).max(200),
                    startMs: z.number().int().nonnegative(),
                    endMs: z.number().int().positive(),
                    text: z.string().trim().min(1).max(4000),
                  })
                  .strict(),
              )
              .max(10000)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export const studioSubmitSchema = z
  .object({ expectedRevision: revision, comment: z.string().trim().max(4000).default("") })
  .strict();
export const studioReviewSchema = z
  .object({
    expectedRevision: revision,
    decision: z.enum(["APPROVED", "REJECTED", "DISCARDED"]),
    outputIds: z.array(z.string().uuid()).min(1).max(200).refine(unique).optional(),
    comment: z.string().trim().max(4000).default(""),
    confirmTranscript: z.boolean().default(false),
    confirmTeachingIntegrity: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.decision !== "REJECTED" || v.comment.length > 0, {
    message: "Rejection comments are required",
    path: ["comment"],
  });
export const studioDiscardSchema = z
  .object({
    expectedRevision: revision,
    comment: z.string().trim().max(4000).default(""),
    outputId: z.string().uuid().optional(),
  })
  .strict();
export const studioPublishSchema = z
  .object({
    expectedRevision: revision,
    accounts: z
      .record(z.enum(STUDIO_CHANNELS), z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/))
      .optional(),
  })
  .strict();
export const studioRegenerateSchema = z
  .object({
    expectedRevision: revision,
    request: studioGenerationRequestSchema.optional(),
    outputIds: z.array(z.string().uuid()).min(1).max(200).refine(unique).optional(),
    mode: z.enum(["ai", "render", "closing"]).default("ai"),
    steadyOpening: z.literal(true).optional(),
    closingDestinations: z.record(z.string().uuid(), z.enum(["app", "youtube"])).optional(),
    illustrationTimings: z
      .array(
        z
          .object({
            assetId: z.string().regex(/^[a-z][a-z-]{0,60}$/),
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(3)
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.closingDestinations ||
      (v.mode !== "ai" &&
        Object.keys(v.closingDestinations).length > 0 &&
        Object.keys(v.closingDestinations).every((id) => v.outputIds?.includes(id))),
    {
      message: "Closing destinations require selected files and a visual-only render",
      path: ["closingDestinations"],
    },
  )
  .refine((v) => !v.steadyOpening || (v.mode === "closing" && v.outputIds?.length === 1), {
    message: "Opening repair requires one selected file and a visual-only repair",
    path: ["steadyOpening"],
  })
  .refine((v) => !v.illustrationTimings || (v.mode === "closing" && v.outputIds?.length === 1), {
    message: "Image timing requires one selected file and a closing-card repair",
    path: ["illustrationTimings"],
  });
export const studioListSchema = z
  .object({
    includeWithdrawn: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    masterId: z.string().uuid().optional(),
    playlistId: z.string().uuid().optional(),
    status: z
      .enum([
        "QUEUED",
        "GENERATING",
        "DRAFT",
        "IN_REVIEW",
        "CHANGES_REQUESTED",
        "APPROVED",
        "DISCARDED",
        "FAILED",
      ])
      .optional(),
  })
  .strict();

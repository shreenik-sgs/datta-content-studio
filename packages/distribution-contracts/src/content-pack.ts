import { PREVIEW_DESTINATIONS, validateContentPreviewPack } from "@satsang/distribution-domain";
import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(20000);
const title = z.string().min(1).max(1000);
const milliseconds = z.number().int().min(0).max(86400000);
const language = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
const attribution = z
  .object({
    narrator: z.string().min(1).max(300),
    subject: title,
    kind: z.enum(["discourse_summary", "story_character", "scripture"]),
    quotedSpeaker: z.string().min(1).max(300).nullable(),
  })
  .strict();

export const contentPreviewPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    world: z.literal("TEST"),
    status: z.literal("DRAFT_REVIEW_REQUIRED"),
    publishAllowed: z.literal(false),
    source: z
      .object({
        id,
        url: z.string().url().max(2048),
        title,
        displayTitle: z.string().min(1).max(68),
        sha256: checksum,
        durationMs: milliseconds,
        language,
        descriptionSha256: checksum,
        transcriptSha256: checksum,
      })
      .strict(),
    brand: z
      .object({
        id,
        revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        name: z.string().min(1).max(300),
        speaker: z.string().min(1).max(300),
        logoSha256: checksum,
        profileSha256: checksum,
      })
      .strict(),
    segments: z
      .array(
        z
          .object({
            id,
            startMs: milliseconds,
            endMs: milliseconds,
            text,
            language,
            provenance: z.enum(["machine_transcript", "human_transcript"]),
          })
          .strict(),
      )
      .min(1)
      .max(20000),
    clips: z
      .array(
        z
          .object({
            id,
            title,
            summary: text,
            attribution,
            startMs: milliseconds,
            endMs: milliseconds,
            segmentIds: z.array(id).min(1).max(20000),
            formats: z
              .array(z.enum(["short", "reel"]))
              .min(1)
              .max(2),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    posts: z
      .array(
        z
          .object({
            id,
            title,
            summary: text,
            attribution,
            sourceClipId: id,
            format: z.literal("post"),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    blogs: z
      .array(
        z
          .object({
            id,
            title,
            dek: text,
            paragraphs: z.array(text).min(1).max(100),
            attribution,
            sourceClipIds: z.array(id).min(1).max(100),
            format: z.literal("blog"),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    platforms: z
      .array(
        z
          .object({
            channel: z.enum(PREVIEW_DESTINATIONS),
            title,
            body: text,
            assetIds: z.array(id).min(1).max(300),
            recommendation: text,
          })
          .strict(),
      )
      .length(5),
    quotes: z
      .array(
        z
          .object({
            id,
            kind: z.literal("unreviewed_native_quote"),
            text,
            language,
            sourceClipId: id,
            segmentIds: z.array(id).min(1).max(20000),
            attribution,
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((pack, context) => {
    try {
      validateContentPreviewPack(pack);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "INVALID_PREVIEW_PACK",
      });
    }
  });

import { validateTranscript } from "@satsang/distribution-domain";
import { z } from "zod";
import { contentLanguageSchema } from "./content";
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const milliseconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(128);
export const editorialProvenanceSchema = z
  .object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(100).nullable(),
    promptVersion: z.string().min(1).max(100).nullable(),
    schemaVersion: revision,
    recipeVersion: z.string().min(1).max(100),
  })
  .strict()
  .refine(
    (value) =>
      value.provider === "manual"
        ? value.model === null && value.promptVersion === null
        : value.model !== null && value.promptVersion !== null,
    "INVALID_PROVENANCE",
  );
export const editorialReviewSchema = z
  .object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    reviewerId: identifier,
    reviewedAt: z.string().datetime({ offset: true }),
    revision,
  })
  .strict();
export const transcriptSegmentSchema = z
  .object({
    id: identifier,
    startMs: milliseconds,
    endMs: milliseconds,
    originalText: z.string().min(1).max(4000),
    displayText: z.string().min(1).max(4000),
  })
  .strict();
export const transcriptVersionSchema = z
  .object({
    id: z.string().uuid(),
    parentVersionId: z.string().uuid().nullable(),
    number: revision,
    masterVersionId: z.string().uuid(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    language: contentLanguageSchema,
    revision,
    durationMs: milliseconds,
    segments: z.array(transcriptSegmentSchema).min(1).max(20000),
    provenance: editorialProvenanceSchema,
    review: editorialReviewSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      validateTranscript(value);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_TRANSCRIPT" });
    }
  });
export const transcriptCorrectionSchema = z
  .object({
    expectedRevision: revision,
    corrections: z
      .array(
        z
          .object({ segmentId: identifier, displayText: z.string().trim().min(1).max(4000) })
          .strict(),
      )
      .min(1)
      .max(20000),
  })
  .strict();
export const editorialReviewCommandSchema = z
  .object({ expectedRevision: revision, decision: z.enum(["APPROVED", "REJECTED"]) })
  .strict();
export const quoteCandidateInputSchema = z
  .object({
    transcriptVersionId: z.string().uuid(),
    transcriptRevision: revision,
    kind: z.enum(["EXACT_QUOTE", "SUMMARY"]),
    segmentIds: z.array(identifier).min(1).max(1000),
    startMs: milliseconds,
    endMs: milliseconds,
    text: z.string().trim().min(1).max(20000),
  })
  .strict()
  .refine(
    (value) =>
      value.endMs > value.startMs && new Set(value.segmentIds).size === value.segmentIds.length,
    "INVALID_SOURCE_SPAN",
  );
export const glossaryEntrySchema = z
  .object({
    id: z.string().uuid(),
    term: z.string().trim().min(1).max(200),
    preferred: z.string().trim().min(1).max(200),
    language: contentLanguageSchema,
  })
  .strict();
export const corpusSampleSchema = z
  .object({
    sampleId: identifier,
    recipeVersion: z.string().min(1).max(100),
    exactQuotePass: z.boolean(),
    criticalGlossaryErrors: z.number().int().min(0),
    glossaryTerms: z.number().int().min(0),
  })
  .strict()
  .refine((value) => value.criticalGlossaryErrors <= value.glossaryTerms, "INVALID_CORPUS_SAMPLE");
export type TranscriptCorrectionCommand = z.infer<typeof transcriptCorrectionSchema>;
export type EditorialReviewCommand = z.infer<typeof editorialReviewCommandSchema>;
export type QuoteCandidateInput = z.infer<typeof quoteCandidateInputSchema>;

export const manualTranscriptCommandSchema = z
  .object({
    expectedSourceVersionId: z.string().uuid(),
    language: contentLanguageSchema,
    durationMs: revision,
    segments: z.array(transcriptSegmentSchema).min(1).max(1000),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      validateTranscript({
        id: "manual-command",
        parentVersionId: null,
        number: 1,
        masterVersionId: value.expectedSourceVersionId,
        sourceSha256: "0".repeat(64),
        language: value.language,
        revision: 1,
        durationMs: value.durationMs,
        segments: value.segments,
        provenance: {
          provider: "manual",
          model: null,
          promptVersion: null,
          schemaVersion: 1,
          recipeVersion: "manual-v1",
        },
        review: null,
      });
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_TRANSCRIPT" });
    }
  });
export const glossaryCommandSchema = glossaryEntrySchema.omit({ id: true }).strict();
export type ManualTranscriptCommand = z.infer<typeof manualTranscriptCommandSchema>;
export type GlossaryCommand = z.infer<typeof glossaryCommandSchema>;

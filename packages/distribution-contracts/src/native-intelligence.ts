import { INTEGRITY_CHECKS, NATIVE_LANGUAGES } from "@satsang/distribution-domain";
import { z } from "zod";
const id = z.string().min(1).max(128);
const refs = z.array(id).min(1).max(1000);
const ms = z.number().int().min(0).max(86400000);
const probability = z.number().min(0).max(1);
const text = z.string().trim().min(1).max(4000);
export const nativeAnalysisSchema = z
  .object({
    schemaVersion: z.literal(1),
    transcriptVersionId: z.string().uuid(),
    transcriptRevision: z.number().int().positive(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    language: z.enum(NATIVE_LANGUAGES),
    glossaryVersionIds: z.array(z.string().uuid()).max(1000),
    annotations: z
      .array(
        z
          .object({
            segmentId: id,
            confidence: probability,
            speakerId: id,
            speakerName: text,
            languageSpans: z
              .array(
                z
                  .object({
                    startMs: ms,
                    endMs: ms,
                    language: z.enum(["te", "kn", "ta", "sa", "en"]),
                  })
                  .strict(),
              )
              .min(1)
              .max(1000),
            words: z
              .array(z.object({ startMs: ms, endMs: ms, text, confidence: probability }).strict())
              .max(5000),
            englishShadow: text.nullable(),
            uncertainty: z.array(text).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    teachings: z
      .array(
        z
          .object({
            id,
            segmentIds: refs,
            kind: z.enum([
              "introduction",
              "proposition",
              "explanation",
              "story",
              "instruction",
              "qualification",
              "conclusion",
              "blessing",
            ]),
            nativeSummary: text,
            englishShadow: text.nullable(),
            requiredContextIds: z.array(id).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    candidates: z
      .array(
        z
          .object({
            id,
            segmentIds: refs,
            startMs: ms,
            endMs: ms,
            rationale: text,
            attributedSpeakerId: id,
            checks: z
              .array(
                z
                  .object({
                    check: z.enum(INTEGRITY_CHECKS),
                    status: z.enum(["PASS", "REVIEW", "FAIL"]),
                    evidence: text,
                    segmentIds: refs,
                  })
                  .strict(),
              )
              .length(10),
            scores: z
              .object({
                fidelity: probability,
                selfContainment: probability,
                contextCompleteness: probability,
                significance: probability,
                clarity: probability,
                accessibility: probability,
                visualSuitability: probability,
                hook: probability,
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    provenance: z
      .object({ provider: id, model: id, promptVersion: id, schemaVersion: z.literal(1) })
      .strict(),
  })
  .strict();
export const nativeProposalCommandSchema = z
  .object({ requestId: z.string().uuid(), analysis: nativeAnalysisSchema })
  .strict();
export const nativeReviewCommandSchema = z
  .object({
    analysisId: z.string().uuid(),
    candidateId: id,
    expectedRevision: z.number().int().min(0),
    requestId: z.string().uuid(),
    decision: z.enum(["APPROVED", "REJECTED"]),
    reason: text,
    checks: z
      .array(z.object({ check: z.enum(INTEGRITY_CHECKS), evidence: text }).strict())
      .length(10),
  })
  .strict();
export const nativePolicySchema = z
  .object({ version: z.literal(1), flags: z.record(z.boolean()) })
  .strict();

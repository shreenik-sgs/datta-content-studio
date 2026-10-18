import {
  ACTIVATION_PROMISES,
  SOCIAL_LINK_FALLBACK_REASONS,
  SOCIAL_PLACEMENTS,
  TRACKED_LINK_LOCALES,
} from "@satsang/distribution-domain";
import { z } from "zod";
import { makeCtaDefinitionSchema } from "./outreach";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const trackedLinkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const trackedLinkRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: trackedLinkTokenSchema,
    isTest: z.literal(true),
    sequence: revision,
    activationId: z.string().uuid(),
    activationRevision: revision,
    campaignId: z.string().uuid(),
    campaignRevision: revision,
    contentId: z.string().uuid(),
    sourceVersionId: z.string().uuid(),
    derivativeId: z.string().uuid(),
    derivativeRevision: revision,
    title: z.string().trim().min(1).max(200),
    cta: makeCtaDefinitionSchema([]),
    language: z.enum(TRACKED_LINK_LOCALES),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    checkedAt: z.string().datetime(),
    status: z.enum(["ACTIVE", "STOPPED", "STALE"]),
    destinationAvailable: z.boolean(),
    fallbackReason: z.enum(SOCIAL_LINK_FALLBACK_REASONS).nullable().optional(),
    social: z
      .object({
        channel: z.enum(SOCIAL_PLACEMENTS),
        promise: z.enum(ACTIVATION_PROMISES),
        canonicalId: z.string().min(1).max(200),
        canonicalRevision: z.string().min(1).max(200),
        accessMode: z.enum(["PUBLIC", "AUTH_REQUIRED"]),
        fallbackAccessMode: z.enum(["PUBLIC", "AUTH_REQUIRED"]),
        approvalPackageSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.cta.approval?.decision !== "APPROVED" ||
      value.cta.approval.revision !== value.cta.revision
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CTA_NOT_APPROVED" });
    if (value.cta.approval?.reviewerId !== "human-review")
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PRIVATE_REVIEWER_REFUSED" });
    if (value.cta.language !== value.language)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "LANGUAGE_MISMATCH" });
    if (Date.parse(value.startsAt) >= Date.parse(value.endsAt))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_LINK_WINDOW" });
  });
export const signedTrackedLinkRecordSchema = z
  .object({
    keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    payload: trackedLinkRecordSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type SignedTrackedLinkRecord = z.infer<typeof signedTrackedLinkRecordSchema>;

export const destinationEvidenceSchema = z
  .object({
    version: z.literal(1),
    isTest: z.literal(true),
    checkedAt: z.string().datetime(),
    results: z
      .array(
        z
          .object({
            path: z.string().min(1).max(2000),
            available: z.boolean(),
            requiresIdentity: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.results.map((row) => row.path)).size !== value.results.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "DUPLICATE_DESTINATION" });
  });

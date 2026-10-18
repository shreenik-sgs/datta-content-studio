import {
  ACTIVATION_PROMISES,
  CANONICAL_DESTINATION_KINDS,
  SOCIAL_PLACEMENTS,
  validateActivationPackageInput,
} from "@satsang/distribution-domain";
import { z } from "zod";
const result = z
  .object({
    path: z.string().min(1).max(2000),
    available: z.boolean(),
    requiresIdentity: z.boolean(),
    canonicalId: z.string().min(1).max(200).nullable(),
    kind: z.enum(CANONICAL_DESTINATION_KINDS).nullable(),
    accessMode: z.enum(["PUBLIC", "AUTH_REQUIRED", "RESTRICTED"]),
    revision: z.string().min(1).max(200).nullable(),
    reason: z.string().min(1).max(100).nullable(),
  })
  .strict();
export const canonicalDestinationEvidenceSchema = z
  .object({
    version: z.literal(2),
    isTest: z.literal(true),
    checkedAt: z.string().datetime(),
    flags: z
      .object({ tracked_social_deep_links: z.boolean(), universal_content_landing: z.boolean() })
      .strict(),
    results: z.array(result).min(1).max(2),
  })
  .strict();
export const activationPackageInputSchema = z
  .object({
    channel: z.enum(SOCIAL_PLACEMENTS),
    copy: z.string().trim().min(1).max(12000),
    promise: z.enum(ACTIVATION_PROMISES),
    intendedAccess: z.enum(["PUBLIC", "AUTH_REQUIRED"]),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      validateActivationPackageInput(value);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_ACTIVATION_PACKAGE" });
    }
  });
export const activationPackageChangeSchema = z
  .object({
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reviewPackage: activationPackageInputSchema,
  })
  .strict();

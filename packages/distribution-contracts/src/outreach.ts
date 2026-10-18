import {
  CTA_INTENTS,
  MISSION_OUTCOMES,
  validateCta,
  validateCtaDestination,
  validateOutreachCampaign,
} from "@satsang/distribution-domain";
import { z } from "zod";
import { activationPackageInputSchema } from "./activation-package";
import { contentLanguageSchema, distributionChannelSchema } from "./content";
import { editorialReviewSchema } from "./intelligence";
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const instant = z.string().datetime({ offset: true });
const campaignFields = z
  .object({
    name: z.string().trim().min(1).max(200),
    program: z.string().trim().min(1).max(100),
    goal: z.string().trim().min(1).max(1000),
    outcomes: z.array(z.enum(MISSION_OUTCOMES)).min(1).max(MISSION_OUTCOMES.length),
    startsAt: instant,
    endsAt: instant,
    budgetMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const outreachCampaignInputSchema = campaignFields.superRefine((value, context) => {
  try {
    validateOutreachCampaign({
      ...value,
      id: "draft",
      kind: "OUTREACH",
      revision: 1,
      status: "DRAFT",
      approval: null,
    });
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_OUTREACH_CAMPAIGN" });
  }
});
export const outreachCampaignSchema = campaignFields
  .extend({
    id: z.string().uuid(),
    kind: z.literal("OUTREACH"),
    revision,
    status: z.enum(["DRAFT", "APPROVED", "PAUSED", "STOPPED"]),
    approval: editorialReviewSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      validateOutreachCampaign(value);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_OUTREACH_CAMPAIGN" });
    }
  });
const destination = z
  .object({ path: z.string().min(1).max(2000), requiresIdentity: z.boolean() })
  .strict();
const ctaFields = z
  .object({
    intent: z.enum(CTA_INTENTS),
    copy: z.string().trim().min(1).max(120),
    language: contentLanguageSchema,
    destination,
    fallback: destination,
  })
  .strict();
export function makeCtaCommandSchema(allowedOrigins: readonly string[] = []) {
  return ctaFields.superRefine((value, context) => {
    try {
      validateCta({ ...value, id: "draft", revision: 1, approval: null }, allowedOrigins);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_CTA" });
    }
  });
}
export function makeCtaDefinitionSchema(allowedOrigins: readonly string[] = []) {
  return ctaFields
    .extend({ id: z.string().uuid(), revision, approval: editorialReviewSchema.nullable() })
    .strict()
    .superRefine((value, context) => {
      try {
        validateCta(value, allowedOrigins);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_CTA" });
      }
    });
}
const activationFields = z
  .object({
    campaignId: z.string().uuid(),
    campaignRevision: revision,
    ctaId: z.string().uuid(),
    ctaRevision: revision,
    derivativeId: z.string().uuid(),
    derivativeRevision: revision,
    sourceVersionId: z.string().uuid(),
    channelAccountId: z.string().uuid().nullable(),
    channel: distributionChannelSchema,
    scheduledAt: instant,
  })
  .strict();
function accountBinding(
  value: { channel: string; channelAccountId: string | null },
  context: z.RefinementCtx,
) {
  if ((value.channel === "manual_export") !== (value.channelAccountId === null))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_CHANNEL_ACCOUNT" });
}
export const activationInputSchema = activationFields.superRefine(accountBinding);
export const channelActivationSchema = activationFields
  .extend({
    id: z.string().uuid(),
    revision,
    status: z.enum(["DRAFT", "APPROVED", "SCHEDULED", "STOPPED"]),
    approval: editorialReviewSchema.nullable(),
  })
  .strict()
  .superRefine(accountBinding);
export function makeTrackedIntentSchema(allowedOrigins: readonly string[] = []) {
  return z
    .object({
      campaignId: z.string().uuid(),
      contentId: z.string().uuid(),
      ctaId: z.string().uuid(),
      ctaRevision: revision,
      language: contentLanguageSchema,
      destination: z.string().min(1).max(2000),
    })
    .strict()
    .superRefine((value, context) => {
      try {
        validateCtaDestination(value.destination, allowedOrigins);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "UNSAFE_DESTINATION" });
      }
    });
}
export const trackedIntentSchema = makeTrackedIntentSchema();
export const campaignChangeSchema = campaignFields.extend({ expectedRevision: revision }).strict();
export const emergencyStopCommandSchema = z.object({ expectedRevision: revision }).strict();
export type OutreachCampaignInput = z.infer<typeof outreachCampaignInputSchema>;
export type ActivationInput = z.infer<typeof activationInputSchema>;

/** Every edit is a complete authored revision; approval identity/time are server-owned. */
export function makeCtaChangeSchema(allowedOrigins: readonly string[] = []) {
  return ctaFields
    .extend({ expectedRevision: revision })
    .strict()
    .superRefine((value, context) => {
      try {
        validateCta({ ...value, id: "draft", revision: 1, approval: null }, allowedOrigins);
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "INVALID_CTA" });
      }
    });
}
export const outreachReviewCommandSchema = z.object({ expectedRevision: revision }).strict();

/** Source/channel/token/reviewer are looked up server-side, never accepted from a form. */
export const manualActivationCommandSchema = z
  .object({
    campaignId: z.string().uuid(),
    expectedCampaignRevision: revision,
    ctaId: z.string().uuid(),
    expectedCtaRevision: revision,
    artifactId: z.string().uuid(),
    expectedArtifactRevision: revision,
    scheduledAt: instant,
    reviewPackage: activationPackageInputSchema.optional(),
  })
  .strict();

import { SOCIAL_LINK_FALLBACK_REASONS, SOCIAL_PLACEMENTS } from "@satsang/distribution-domain";
import { z } from "zod";
export const socialLinkReceiptSchema = z
  .object({
    version: z.literal(1),
    isTest: z.literal(true),
    id: z.string().uuid(),
    occurredAt: z.string().datetime(),
    name: z.enum([
      "tracked_link_resolved",
      "tracked_link_fallback_used",
      "activation_destination_validated",
    ]),
    activationId: z.string().uuid(),
    campaignId: z.string().uuid(),
    contentId: z.string().uuid(),
    derivativeId: z.string().uuid(),
    ctaId: z.string().uuid(),
    channel: z.enum(SOCIAL_PLACEMENTS),
    canonicalId: z
      .string()
      .regex(
        /^(?:(?:room|event|seva):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|library)$/,
      )
      .nullable(),
    fallbackReason: z.enum(SOCIAL_LINK_FALLBACK_REASONS).nullable(),
  })
  .strict()
  .superRefine((event, context) => {
    if ((event.name === "tracked_link_fallback_used") !== (event.fallbackReason !== null))
      context.addIssue({ code: z.ZodIssueCode.custom, message: "FALLBACK_REASON_REQUIRED" });
  });

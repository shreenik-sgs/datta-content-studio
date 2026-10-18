import { z } from "zod";

export const distributionAuthorityInputSchema = z
  .object({
    userId: z.string().uuid(),
    isTest: z.literal(true),
    capability: z.enum(["content.create", "content.review"]),
  })
  .strict();
export const distributionAuthorityResponseSchema = distributionAuthorityInputSchema
  .extend({
    version: z.literal(1),
    requestId: z.string().uuid(),
    allowed: z.boolean(),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();

import { z } from "zod";
/** Versioned identity-only authority, separate from the legacy TEST service. */
export const studioAuthorityInputSchema = z
  .object({
    userId: z.string().uuid(),
    isTest: z.boolean(),
    capability: z.enum(["content.create", "content.review", "content.publish"]),
  })
  .strict();
export const studioAuthorityRequestSchema = studioAuthorityInputSchema
  .extend({
    version: z.literal(2),
    requestId: z.string().uuid(),
    requestedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const studioAuthorityResponseSchema = studioAuthorityInputSchema
  .extend({
    version: z.literal(2),
    requestId: z.string().uuid(),
    allowed: z.boolean(),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();

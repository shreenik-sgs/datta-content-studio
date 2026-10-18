import { z } from "zod";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
export const channelPublicationIdentitySchema = z
  .object({
    activationId: id,
    activationRevision: z.number().int().positive(),
    accountId: id,
    channel: z.enum(["youtube", "telegram"]),
    world: z.enum(["TEST", "PRODUCTION"]),
    payloadSha256: sha,
  })
  .strict();
export const channelAdoptionSchema = z
  .object({
    channel: z.enum(["youtube", "telegram"]),
    accountId: id,
    world: z.enum(["TEST", "PRODUCTION"]),
    enabled: z.boolean(),
    officialCapabilityEvidence: z.string().trim().min(1).max(2000),
    accountEligibilityEvidence: z.string().trim().min(1).max(2000),
    contractTestEvidence: z.string().trim().min(1).max(2000),
    authorizationExpiresAt: instant,
    verifiedDestination: z.string().min(1).max(128),
    allowedVisibility: z
      .array(z.enum(["private", "unlisted", "public"]))
      .min(1)
      .max(3),
  })
  .strict();
export const youtubePublicationMetadataSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => !/[<>]/.test(value)),
    description: z
      .string()
      .max(5000)
      .refine((value) => !/[<>]/.test(value)),
    categoryId: z.string().regex(/^\d{1,5}$/),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    visibility: z.enum(["private", "unlisted", "public"]),
    madeForKids: z.boolean(),
    containsSyntheticMedia: z.boolean(),
  })
  .strict();
/** Plain text only; payload must already contain the approved tracked CTA. No parse mode. */
export const telegramChannelPostSchema = z
  .object({
    destination: z.string().regex(/^-\d{1,16}$/),
    text: z.string().trim().min(1).max(4096),
  })
  .strict();
export type YoutubePublicationMetadata = z.infer<typeof youtubePublicationMetadataSchema>;
export type TelegramChannelPost = z.infer<typeof telegramChannelPostSchema>;

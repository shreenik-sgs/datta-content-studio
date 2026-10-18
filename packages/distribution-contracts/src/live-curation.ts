import { z } from "zod";
/** Core's studio-live-channels v1 contract is mirrored to keep core independent of Hub packages. */
export const liveChannelsResponseSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    userId: z.string().uuid(),
    isTest: z.boolean(),
    allowed: z.boolean(),
    checkedAt: z.string().datetime({ offset: true }),
    channels: z
      .array(
        z
          .object({
            channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
            name: z.string().min(1).max(200),
            handle: z.string().max(100).nullable(),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
import { contentRightsSchema } from "./content";
export const liveCurationConfigureSchema = z
  .object({
    monitors: z
      .array(
        z
          .object({
            expectedRevision: z.number().int().positive().nullable(),
            settings: z
              .object({
                channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
                channelName: z.string().min(1).max(200),
                enabled: z.boolean(),
                language: z.enum(["te", "kn", "en", "hi", "ta", "ml", "sa"]),
                rights: contentRightsSchema,
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(4)
      .refine(
        (monitors) => new Set(monitors.map((m) => m.settings.channelId)).size === monitors.length,
        "Duplicate channel settings",
      ),
  })
  .strict();

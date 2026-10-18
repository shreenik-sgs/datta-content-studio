import { z } from "zod";

export const distributionStageSchema = z.enum(["OFF", "TEST", "LIMITED", "ON"]);

export const distributionHealthSchema = z.object({
  service: z.enum(["distribution-web", "distribution-worker"]),
  version: z.literal(1),
  stage: distributionStageSchema,
  status: z.enum(["ok", "degraded"]),
});

export const distributionEventSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    type: z.literal("distribution.foundation.checked"),
    occurredAt: z.string().datetime({ offset: true }),
    correlationId: z.string().uuid(),
    payload: z.object({ buildRevision: z.string().min(1).max(128) }).strict(),
  })
  .strict();

export type DistributionHealth = z.infer<typeof distributionHealthSchema>;
export type DistributionEvent = z.infer<typeof distributionEventSchema>;

export * from "./content";

export * from "./intelligence";
export * from "./variants";
export * from "./outreach";

export * from "./ui-copy";
export * from "./tracked-links";

export * from "./native-intelligence";

export * from "./analytics";

export * from "./channel-publishing";

export * from "./content-pack";

export * from "./activation-package";

export * from "./social-link-events";
export * from "./operator-authority";
export * from "./intelligent-content";
export * from "./studio-authority";

export * from "./import-verification";

export * from "./live-curation";

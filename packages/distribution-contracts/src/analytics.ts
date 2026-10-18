import { ANALYTICS_NAMES } from "@satsang/distribution-domain";
import { z } from "zod";
export const analyticsEventSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    name: z.enum(ANALYTICS_NAMES),
    occurredAt: z.string().datetime({ offset: true }),
    correlationId: z.string().uuid(),
    actorKey: z.string().regex(/^[a-f0-9]{64}$/),
    campaignId: z.string().uuid(),
    activationId: z.string().uuid().nullable(),
    contentId: z.string().uuid().nullable(),
    ctaId: z.string().uuid().nullable(),
    consentBasis: z.enum(["explicit_consent", "approved_service_measurement"]),
    consentReceipt: z.string().uuid(),
    source: z.enum(["canonical_core", "signed_link", "operator_fixture"]),
    sourceEventId: z.string().uuid(),
    participationId: z.string().uuid().nullable(),
  })
  .strict();
export const analyticsCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("reconcile_recent"),
      campaignId: z.string().uuid(),
      days: z.number().int().min(1).max(31),
    })
    .strict(),
  z
    .object({
      action: z.literal("approve_policy"),
      requestId: z.string().uuid(),
      retentionDays: z.number().int().min(7).max(90),
      approvalReference: z.string().uuid(),
    })
    .strict(),
  z
    .object({ action: z.literal("ingest"), events: z.array(analyticsEventSchema).min(1).max(500) })
    .strict(),
  z
    .object({
      action: z.literal("reconcile"),
      campaignId: z.string().uuid(),
      windowStart: z.string().datetime(),
      windowEnd: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      action: z.literal("provider_snapshot"),
      id: z.string().uuid(),
      campaignId: z.string().uuid(),
      provider: z.enum(["youtube", "telegram", "manual_fixture"]),
      metric: z.enum(["views", "impressions", "reach", "cost_micros"]),
      value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      currency: z.enum(["USD", "INR", "EUR"]).nullable(),
      observedAt: z.string().datetime(),
      definitionVersion: z.literal(1),
    })
    .strict(),
]);

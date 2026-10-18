import { randomUUID } from "node:crypto";
import {
  type CtaDefinition,
  type DistributionCapability,
  type OutreachCampaign,
  approveCta,
  approveOutreachCampaign,
  pauseOutreachCampaign,
  reviseCta,
  reviseOutreachCampaign,
  stopOutreachCampaign,
  validateCta,
  validateOutreachCampaign,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient } from "pg";
import { invalidateActivations } from "./activation-invalidation.js";
import {
  type DistributionContext,
  distributionWorld,
  requireDistributionCapability,
} from "./repository";
import { requireIndependentPackageReview } from "./review-integrity.js";
export type CampaignDraft = Pick<
  OutreachCampaign,
  "name" | "program" | "goal" | "outcomes" | "startsAt" | "endsAt" | "budgetMicros"
>;
export type CtaDraft = Pick<
  CtaDefinition,
  "intent" | "copy" | "language" | "destination" | "fallback"
>;
export type ExpectedOutreachRevision = { expectedRevision: number };
type EntityKind = "campaign" | "cta";
type Snapshot = OutreachCampaign | CtaDefinition;
const readers: DistributionCapability[] = [
  "campaigns.manage",
  "content.review",
  "operations.manage",
];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const tables = {
  campaign: { head: "outreach_campaign", history: "outreach_campaign_revision", id: "campaign_id" },
  cta: { head: "cta_definition", history: "cta_revision", id: "cta_id" },
} as const;
const campaignFields = (value: CampaignDraft): CampaignDraft => ({
  name: value.name,
  program: value.program,
  goal: value.goal,
  outcomes: value.outcomes,
  startsAt: value.startsAt,
  endsAt: value.endsAt,
  budgetMicros: value.budgetMicros,
});
const ctaFields = (value: CtaDraft): CtaDraft => ({
  intent: value.intent,
  copy: value.copy,
  language: value.language,
  destination: {
    path: value.destination.path,
    requiresIdentity: value.destination.requiresIdentity,
  },
  fallback: { path: value.fallback.path, requiresIdentity: value.fallback.requiresIdentity },
});
function pagination(input: { limit?: number; offset?: number } = {}) {
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new Error("INVALID_PAGINATION");
  return { limit, offset };
}
/** Draft authoring only: no publish, activation, tracked link, analytics or core writes. */
export function createDistributionOutreachRepository(
  pool: Pool,
  options: { allowedOrigins?: readonly string[] } = {},
) {
  const allowedOrigins = [...(options.allowedOrigins ?? [])];
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password)
      throw new Error("UNSAFE_DESTINATION");
  }
  async function run<T>(
    ctx: DistributionContext,
    permissions: readonly DistributionCapability[],
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    distributionWorld(ctx);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await requireDistributionCapability(client, ctx, permissions);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function lock(client: PoolClient, ctx: DistributionContext, kind: EntityKind, id: string) {
    if (!uuid.test(id)) throw new Error("NOT_FOUND");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `distribution:outreach:${kind}:${distributionWorld(ctx)}:${id}`,
    ]);
  }
  async function get<T extends Snapshot>(
    client: PoolClient,
    ctx: DistributionContext,
    kind: EntityKind,
    id: string,
  ): Promise<T> {
    if (!uuid.test(id)) throw new Error("NOT_FOUND");
    const table = tables[kind];
    const result = await client.query(
      `SELECT snapshot FROM distribution.${table.history} WHERE ${table.id}=$1 AND is_test=$2 ORDER BY revision DESC LIMIT 1`,
      [id, distributionWorld(ctx)],
    );
    if (!result.rows[0]) throw new Error("NOT_FOUND");
    return result.rows[0].snapshot as T;
  }
  async function append<T extends Snapshot>(
    client: PoolClient,
    ctx: DistributionContext,
    kind: EntityKind,
    snapshot: T,
    action: string,
  ): Promise<T> {
    const table = tables[kind];
    await client.query(
      `INSERT INTO distribution.${table.history}(${table.id},is_test,revision,snapshot,action,actor_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [snapshot.id, distributionWorld(ctx), snapshot.revision, snapshot, action, ctx.userId],
    );
    if (action !== "CREATED")
      await invalidateActivations(client, {
        isTest: ctx.isTest,
        actorId: ctx.userId,
        reason: `${kind.toUpperCase()}_${action}`,
        ...(kind === "campaign" ? { campaignId: snapshot.id } : { ctaId: snapshot.id }),
      });
    return snapshot;
  }
  async function list<T extends Snapshot>(
    client: PoolClient,
    ctx: DistributionContext,
    kind: EntityKind,
    input: { limit?: number; offset?: number },
  ): Promise<T[]> {
    const table = tables[kind];
    const { limit, offset } = pagination(input);
    const result = await client.query(
      `SELECT r.snapshot FROM distribution.${table.head} h JOIN LATERAL(SELECT snapshot,created_at FROM distribution.${table.history} WHERE ${table.id}=h.id AND is_test=h.is_test ORDER BY revision DESC LIMIT 1) r ON true WHERE h.is_test=$1 ORDER BY r.created_at DESC,h.id LIMIT $2 OFFSET $3`,
      [distributionWorld(ctx), limit, offset],
    );
    return result.rows.map((row) => row.snapshot as T);
  }
  async function history<T extends Snapshot>(
    client: PoolClient,
    ctx: DistributionContext,
    kind: EntityKind,
    id: string,
    input: { limit?: number; offset?: number },
  ): Promise<T[]> {
    await get(client, ctx, kind, id);
    const table = tables[kind];
    const { limit, offset } = pagination(input);
    const result = await client.query(
      `SELECT snapshot FROM distribution.${table.history} WHERE ${table.id}=$1 AND is_test=$2 ORDER BY revision DESC LIMIT $3 OFFSET $4`,
      [id, distributionWorld(ctx), limit, offset],
    );
    return result.rows.map((row) => row.snapshot as T);
  }
  async function reviewTime(client: PoolClient) {
    const result = await client.query("SELECT clock_timestamp() AS now");
    return new Date(result.rows[0].now).toISOString();
  }
  function ctaValid(cta: CtaDefinition) {
    if (!["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"].includes(cta.language))
      throw new Error("INVALID_LANGUAGE");
    validateCta(cta, allowedOrigins);
  }
  return {
    createCampaign: (ctx: DistributionContext, input: CampaignDraft) =>
      run(ctx, ["campaigns.manage"], async (client) => {
        const snapshot: OutreachCampaign = {
          ...campaignFields(input),
          id: randomUUID(),
          kind: "OUTREACH",
          revision: 1,
          status: "DRAFT",
          approval: null,
        };
        validateOutreachCampaign(snapshot);
        await client.query(
          "INSERT INTO distribution.outreach_campaign(id,is_test,created_by) VALUES($1,$2,$3)",
          [snapshot.id, ctx.isTest, ctx.userId],
        );
        return append(client, ctx, "campaign", snapshot, "CREATED");
      }),
    getCampaign: (ctx: DistributionContext, id: string) =>
      run(ctx, readers, (client) => get<OutreachCampaign>(client, ctx, "campaign", id)),
    listCampaigns: (ctx: DistributionContext, input: { limit?: number; offset?: number } = {}) =>
      run(ctx, readers, (client) => list<OutreachCampaign>(client, ctx, "campaign", input)),
    campaignHistory: (
      ctx: DistributionContext,
      id: string,
      input: { limit?: number; offset?: number } = {},
    ) =>
      run(ctx, readers, (client) => history<OutreachCampaign>(client, ctx, "campaign", id, input)),
    updateCampaign: (
      ctx: DistributionContext,
      id: string,
      input: CampaignDraft & ExpectedOutreachRevision,
    ) =>
      run(ctx, ["campaigns.manage"], async (client) => {
        await lock(client, ctx, "campaign", id);
        const source = await get<OutreachCampaign>(client, ctx, "campaign", id);
        return append(
          client,
          ctx,
          "campaign",
          reviseOutreachCampaign(source, input.expectedRevision, campaignFields(input)),
          "EDITED",
        );
      }),
    approveCampaign: (ctx: DistributionContext, id: string, input: ExpectedOutreachRevision) =>
      run(ctx, ["content.review"], async (client) => {
        await lock(client, ctx, "campaign", id);
        const source = await get<OutreachCampaign>(client, ctx, "campaign", id);
        if (source.revision !== input.expectedRevision) throw new Error("REVISION_CONFLICT");
        await requireIndependentPackageReview(client, {
          isTest: ctx.isTest,
          kind: "campaign",
          id,
          revision: source.revision,
          reviewerId: ctx.userId,
        });
        return append(
          client,
          ctx,
          "campaign",
          approveOutreachCampaign(source, {
            ...input,
            reviewerId: ctx.userId,
            reviewedAt: await reviewTime(client),
          }),
          "APPROVED",
        );
      }),
    pauseCampaign: (ctx: DistributionContext, id: string, input: ExpectedOutreachRevision) =>
      run(ctx, ["campaigns.manage", "operations.manage"], async (client) => {
        await lock(client, ctx, "campaign", id);
        const source = await get<OutreachCampaign>(client, ctx, "campaign", id);
        return append(
          client,
          ctx,
          "campaign",
          pauseOutreachCampaign(source, input.expectedRevision),
          "PAUSED",
        );
      }),
    stopCampaign: (ctx: DistributionContext, id: string, input: ExpectedOutreachRevision) =>
      run(ctx, ["campaigns.manage", "operations.manage"], async (client) => {
        await lock(client, ctx, "campaign", id);
        const source = await get<OutreachCampaign>(client, ctx, "campaign", id);
        return append(
          client,
          ctx,
          "campaign",
          stopOutreachCampaign(source, input.expectedRevision),
          "STOPPED",
        );
      }),
    createCta: (ctx: DistributionContext, input: CtaDraft) =>
      run(ctx, ["campaigns.manage"], async (client) => {
        const snapshot: CtaDefinition = {
          ...ctaFields(input),
          id: randomUUID(),
          revision: 1,
          approval: null,
        };
        ctaValid(snapshot);
        await client.query(
          "INSERT INTO distribution.cta_definition(id,is_test,created_by) VALUES($1,$2,$3)",
          [snapshot.id, ctx.isTest, ctx.userId],
        );
        return append(client, ctx, "cta", snapshot, "CREATED");
      }),
    getCta: (ctx: DistributionContext, id: string) =>
      run(ctx, readers, (client) => get<CtaDefinition>(client, ctx, "cta", id)),
    listCtas: (ctx: DistributionContext, input: { limit?: number; offset?: number } = {}) =>
      run(ctx, readers, (client) => list<CtaDefinition>(client, ctx, "cta", input)),
    ctaHistory: (
      ctx: DistributionContext,
      id: string,
      input: { limit?: number; offset?: number } = {},
    ) => run(ctx, readers, (client) => history<CtaDefinition>(client, ctx, "cta", id, input)),
    updateCta: (ctx: DistributionContext, id: string, input: CtaDraft & ExpectedOutreachRevision) =>
      run(ctx, ["campaigns.manage"], async (client) => {
        await lock(client, ctx, "cta", id);
        const source = await get<CtaDefinition>(client, ctx, "cta", id);
        const next = reviseCta(source, input.expectedRevision, ctaFields(input), allowedOrigins);
        ctaValid(next);
        return append(client, ctx, "cta", next, "EDITED");
      }),
    approveCta: (ctx: DistributionContext, id: string, input: ExpectedOutreachRevision) =>
      run(ctx, ["content.review"], async (client) => {
        await lock(client, ctx, "cta", id);
        const source = await get<CtaDefinition>(client, ctx, "cta", id);
        if (source.revision !== input.expectedRevision) throw new Error("REVISION_CONFLICT");
        await requireIndependentPackageReview(client, {
          isTest: ctx.isTest,
          kind: "cta",
          id,
          revision: source.revision,
          reviewerId: ctx.userId,
        });
        ctaValid(source);
        return append(
          client,
          ctx,
          "cta",
          approveCta(
            source,
            { ...input, reviewerId: ctx.userId, reviewedAt: await reviewTime(client) },
            allowedOrigins,
          ),
          "APPROVED",
        );
      }),
  };
}
export type DistributionOutreachRepository = ReturnType<
  typeof createDistributionOutreachRepository
>;

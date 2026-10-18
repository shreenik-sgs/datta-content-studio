import { createHash, randomUUID } from "node:crypto";
import {
  type TelegramChannelPost,
  type YoutubePublicationMetadata,
  channelAdoptionSchema,
  telegramChannelPostSchema,
  youtubePublicationMetadataSchema,
} from "@satsang/distribution-contracts";
import {
  type ChannelAdoption,
  type ChannelProviderOutcome,
  type ChannelPublication,
  type CtaDefinition,
  type OutreachCampaign,
  activationDispatchDecision,
  channelPublicationKey,
  claimChannelPublication,
  contentExportDecision,
  createChannelPublication,
  recordChannelOutcome,
  recoverChannelLease,
  requireSamePublication,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient } from "pg";
import { readActivation } from "./activation-invalidation.js";
import type { DistributionRoleAuthority } from "./operator-authority.js";
import { createDistributionRenderRepository } from "./render-repository.js";
import {
  type DistributionContext,
  distributionWorld,
  requireDistributionCapability,
} from "./repository.js";
import { requireIndependentPackageReview } from "./review-integrity.js";
export type ChannelAccountSnapshot = {
  revision: number;
  adoption: ChannelAdoption;
  secretReference: string;
  emergencyStop: boolean;
  circuitOpen: boolean;
};
export type LocalChannelPayload =
  | { channel: "youtube"; metadata: YoutubePublicationMetadata }
  | { channel: "telegram"; post: TelegramChannelPost };
export type LocalChannelPlan = {
  mode: "LOCAL_SIMULATION";
  accountRevision: number;
  sourceVersionId: string;
  sourceRevision: number;
  artifactId: string;
  artifactRevision: number;
  artifactSha256: string;
  artifactByteSize: number;
  recipeSha256: string;
  campaignId: string;
  campaignRevision: number;
  ctaId: string;
  ctaRevision: number;
  destination: string;
  visibility: "private" | "unlisted" | "public";
  territory: string;
  publicChannelAuthorization: string;
  approvalReason: string;
  payload: LocalChannelPayload;
};
export type LocalChannelPublication = {
  id: string;
  publication: ChannelPublication;
  plan: LocalChannelPlan;
  networkEnabled: false;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
          : v,
      ),
    )
    .digest("hex");
function identifier(value: string) {
  if (!uuid.test(value)) throw new Error("INVALID_CHANNEL_ID");
}
function note(value: string) {
  if (!value.trim() || value.length > 2000) throw new Error("CHANNEL_APPROVAL_REQUIRED");
}
/** Durable local rehearsals only: never obtains credentials, imports transports, or authorizes network dispatch. */
export function createDistributionChannelRepository(
  pool: Pool,
  options: { localLeaseMs?: number; authorize?: DistributionRoleAuthority } = {},
) {
  const localLeaseMs = options.localLeaseMs ?? 90_000;
  if (!Number.isSafeInteger(localLeaseMs) || localLeaseMs < 1000 || localLeaseMs > 90_000)
    throw new Error("INVALID_LOCAL_CHANNEL_LEASE");
  const render = createDistributionRenderRepository(pool, options);
  async function run<T>(
    ctx: DistributionContext,
    permission: "channels.manage" | "content.publish" | "operations.manage",
    fn: (c: PoolClient) => Promise<T>,
  ) {
    if (distributionWorld(ctx) !== true) throw new Error("TEST_WORLD_REQUIRED");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout='5s'");
      await requireDistributionCapability(c, ctx, [permission]);
      const value = await fn(c);
      await c.query("COMMIT");
      return value;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async function clock(c: PoolClient) {
    return new Date((await c.query("SELECT clock_timestamp() AS now")).rows[0].now).toISOString();
  }
  async function lock(c: PoolClient, key: string) {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `distribution:channel:${key}`,
    ]);
  }
  async function account(c: PoolClient, id: string) {
    identifier(id);
    await lock(c, `account:${id}`);
    const rows = await c.query(
      "SELECT snapshot FROM distribution.channel_account_revision WHERE account_id=$1 AND is_test=true ORDER BY revision DESC LIMIT 1",
      [id],
    );
    if (!rows.rows[0]) throw new Error("NOT_FOUND");
    return rows.rows[0].snapshot as ChannelAccountSnapshot;
  }
  async function read(c: PoolClient, id: string): Promise<LocalChannelPublication> {
    identifier(id);
    const rows = await c.query(
      "SELECT p.plan,r.snapshot FROM distribution.channel_publication p JOIN LATERAL (SELECT snapshot FROM distribution.channel_publication_revision WHERE publication_id=p.id AND is_test=p.is_test ORDER BY revision DESC LIMIT 1) r ON true WHERE p.id=$1 AND p.is_test=true",
      [id],
    );
    if (!rows.rows[0]) throw new Error("NOT_FOUND");
    return {
      id,
      plan: rows.rows[0].plan,
      publication: rows.rows[0].snapshot,
      networkEnabled: false,
    };
  }
  async function append(
    c: PoolClient,
    ctx: DistributionContext,
    id: string,
    value: ChannelPublication,
    action: string,
    requestId: string,
    requestHash: string,
  ) {
    await c.query(
      "INSERT INTO distribution.channel_publication_revision(publication_id,is_test,revision,snapshot,action,request_id,request_sha256,actor_id) VALUES($1,true,$2,$3,$4,$5,$6,$7)",
      [id, value.revision, value, action, requestId, requestHash, ctx.userId],
    );
  }
  async function repeated(c: PoolClient, id: string, requestId: string, hash: string) {
    const old = await c.query(
      "SELECT request_sha256 FROM distribution.channel_publication_revision WHERE publication_id=$1 AND is_test=true AND request_id=$2",
      [id, requestId],
    );
    if (!old.rows[0]) return false;
    if (old.rows[0].request_sha256 !== hash) throw new Error("CHANNEL_IDEMPOTENCY_CONFLICT");
    return true;
  }
  async function dependencies(c: PoolClient, activationId: string) {
    identifier(activationId);
    const initial = await readActivation(c, true, activationId);
    // Same global lock order as activation authoring: source, campaign, CTA, activation; account/job come last.
    const media = await render.inspectArtifactInTransaction(c, true, initial.derivativeId);
    for (const [kind, id] of [
      ["campaign", initial.campaignId],
      ["cta", initial.ctaId],
    ])
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `distribution:outreach:${kind}:true:${id}`,
      ]);
    const campaigns = await c.query(
      "SELECT snapshot FROM distribution.outreach_campaign_revision WHERE campaign_id=$1 AND is_test=true ORDER BY revision DESC LIMIT 1",
      [initial.campaignId],
    );
    const ctas = await c.query(
      "SELECT snapshot FROM distribution.cta_revision WHERE cta_id=$1 AND is_test=true ORDER BY revision DESC LIMIT 1",
      [initial.ctaId],
    );
    await c.query(
      "SELECT id FROM distribution.activation WHERE id=$1 AND is_test=true FOR UPDATE",
      [activationId],
    );
    const activation = await readActivation(c, true, activationId);
    if (!campaigns.rows[0] || !ctas.rows[0]) throw new Error("NOT_FOUND");
    for (const [kind, value] of [
      ["activation", activation],
      ["campaign", campaigns.rows[0].snapshot],
      ["cta", ctas.rows[0].snapshot],
    ] as const) {
      if (value.approval?.decision === "APPROVED")
        await requireIndependentPackageReview(c, {
          isTest: true,
          kind,
          id: value.id,
          revision: value.revision,
          reviewerId: value.approval.reviewerId,
        });
    }
    if (!media.eligibility.allowed) throw new Error(media.eligibility.reason);
    if (
      activation.masterId !== media.master.id ||
      activation.sourceRevision !== media.master.revision ||
      activation.sourceVersionId !== media.master.currentVersion.id ||
      activation.recipeSha256 !== media.artifact.recipeSha256 ||
      activation.assetSha256 !== media.artifact.output.video.sha256 ||
      activation.derivativeRevision !== media.artifact.revision
    )
      throw new Error("ACTIVATION_DEPENDENCY_CHANGED");
    return {
      ...media,
      activation,
      campaign: campaigns.rows[0].snapshot as OutreachCampaign,
      cta: ctas.rows[0].snapshot as CtaDefinition,
    };
  }
  function validateDependencies(
    data: Awaited<ReturnType<typeof dependencies>>,
    target: ChannelAdoption["channel"],
    at: string,
    due: boolean,
  ) {
    const decision = activationDispatchDecision({
      activation: data.activation,
      campaign: data.campaign,
      cta: data.cta,
      derivative: {
        id: data.artifact.id,
        revision: data.artifact.revision,
        sourceVersionId: data.master.currentVersion.id,
        approval: data.artifact.approval,
        withdrawn: data.master.state === "WITHDRAWN",
      },
      channelAccount: null,
      sourceRightsAllowed: true,
      audienceAllowed: true,
      now: at,
    });
    if (!decision.allowed && !(decision.reason === "NOT_DUE" && !due))
      throw new Error(decision.reason);
    const rights = contentExportDecision({
      content: data.master,
      channel: target,
      territory: data.job.recipe.territory,
      now: at,
    });
    if (!rights.allowed) throw new Error(rights.reason);
  }
  return {
    saveAccount: (
      ctx: DistributionContext,
      input: {
        requestId: string;
        expectedRevision: number;
        adoption: ChannelAdoption;
        secretReference: string;
        emergencyStop: boolean;
        circuitOpen: boolean;
      },
    ) =>
      run(ctx, "channels.manage", async (c) => {
        identifier(input.requestId);
        const adoption = channelAdoptionSchema.parse(input.adoption);
        identifier(adoption.accountId);
        if (
          adoption.world !== "TEST" ||
          !/^secret-ref:\/\/distribution\/test\/[A-Za-z0-9/_-]{1,256}$/.test(input.secretReference)
        )
          throw new Error("CHANNEL_SECRET_REFERENCE_REQUIRED");
        if (typeof input.emergencyStop !== "boolean" || typeof input.circuitOpen !== "boolean")
          throw new Error("INVALID_CHANNEL_ACCOUNT");
        if (
          adoption.channel === "telegram"
            ? !/^-\d{1,16}$/.test(adoption.verifiedDestination)
            : !/^UC[A-Za-z0-9_-]{20,30}$/.test(adoption.verifiedDestination)
        )
          throw new Error("CHANNEL_DESTINATION_REFUSED");
        await lock(c, `account:${adoption.accountId}`);
        const old = await c.query(
          "SELECT snapshot,request_id FROM distribution.channel_account_revision WHERE account_id=$1 AND is_test=true ORDER BY revision DESC LIMIT 1",
          [adoption.accountId],
        );
        const current = old.rows[0]?.snapshot as ChannelAccountSnapshot | undefined;
        const snapshot: ChannelAccountSnapshot = {
          revision: input.expectedRevision + 1,
          adoption,
          secretReference: input.secretReference,
          emergencyStop: input.emergencyStop,
          circuitOpen: input.circuitOpen,
        };
        const retry = await c.query(
          "SELECT snapshot FROM distribution.channel_account_revision WHERE account_id=$1 AND is_test=true AND request_id=$2",
          [adoption.accountId, input.requestId],
        );
        if (retry.rows[0]) {
          if (fingerprint(retry.rows[0].snapshot) !== fingerprint(snapshot))
            throw new Error("CHANNEL_IDEMPOTENCY_CONFLICT");
          return retry.rows[0].snapshot as ChannelAccountSnapshot;
        }
        if ((current?.revision ?? 0) !== input.expectedRevision)
          throw new Error("CHANNEL_REVISION_CONFLICT");
        if (current && current.adoption.channel !== adoption.channel)
          throw new Error("CHANNEL_ACCOUNT_MISMATCH");
        if (!current)
          await c.query(
            "INSERT INTO distribution.channel_account(id,is_test,channel,created_by) VALUES($1,true,$2,$3)",
            [adoption.accountId, adoption.channel, ctx.userId],
          );
        await c.query(
          "INSERT INTO distribution.channel_account_revision(account_id,is_test,revision,snapshot,request_id,actor_id) VALUES($1,true,$2,$3,$4,$5)",
          [adoption.accountId, snapshot.revision, snapshot, input.requestId, ctx.userId],
        );
        return snapshot;
      }),
    prepareLocal: (
      ctx: DistributionContext,
      input: {
        requestId: string;
        activationId: string;
        expectedActivationRevision: number;
        accountId: string;
        expectedAccountRevision: number;
        payload: LocalChannelPayload;
        publicChannelAuthorization: string;
        approvalReason: string;
      },
    ) =>
      run(ctx, "content.publish", async (c) => {
        identifier(input.requestId);
        note(input.publicChannelAuthorization);
        note(input.approvalReason);
        const data = await dependencies(c, input.activationId);
        const held = await account(c, input.accountId);
        const at = await clock(c);
        if (
          data.activation.revision !== input.expectedActivationRevision ||
          held.revision !== input.expectedAccountRevision
        )
          throw new Error("CHANNEL_REVISION_CONFLICT");
        const payload: LocalChannelPayload =
          input.payload.channel === "youtube"
            ? {
                channel: "youtube",
                metadata: youtubePublicationMetadataSchema.parse(input.payload.metadata),
              }
            : { channel: "telegram", post: telegramChannelPostSchema.parse(input.payload.post) };
        if (
          payload.channel !== held.adoption.channel ||
          (payload.channel === "telegram" &&
            payload.post.destination !== held.adoption.verifiedDestination)
        )
          throw new Error("CHANNEL_ACCOUNT_MISMATCH");
        validateDependencies(data, payload.channel, at, false);
        const plan: LocalChannelPlan = {
          mode: "LOCAL_SIMULATION",
          accountRevision: held.revision,
          sourceVersionId: data.master.currentVersion.id,
          sourceRevision: data.master.revision,
          artifactId: data.artifact.id,
          artifactRevision: data.artifact.revision,
          artifactSha256: data.artifact.output.video.sha256,
          artifactByteSize: data.artifact.output.video.byteSize,
          recipeSha256: data.artifact.recipeSha256,
          campaignId: data.campaign.id,
          campaignRevision: data.campaign.revision,
          ctaId: data.cta.id,
          ctaRevision: data.cta.revision,
          destination: held.adoption.verifiedDestination,
          visibility: payload.channel === "youtube" ? payload.metadata.visibility : "public",
          territory: data.job.recipe.territory,
          publicChannelAuthorization: input.publicChannelAuthorization,
          approvalReason: input.approvalReason,
          payload,
        };
        const publication = createChannelPublication({
          activationId: input.activationId,
          activationRevision: input.expectedActivationRevision,
          accountId: input.accountId,
          channel: payload.channel,
          world: "TEST",
          payloadSha256: fingerprint(plan),
        });
        const key = channelPublicationKey(publication.identity);
        await lock(c, `publication:${key}`);
        const existing = await c.query(
          "SELECT id FROM distribution.channel_publication WHERE publication_key=$1 AND is_test=true",
          [key],
        );
        if (existing.rows[0]) {
          const result = await read(c, existing.rows[0].id);
          requireSamePublication(result.publication, publication.identity);
          return result;
        }
        const id = randomUUID();
        await c.query(
          "INSERT INTO distribution.channel_publication(id,is_test,account_id,activation_id,activation_revision,publication_key,payload_sha256,plan,simulation_only,approved_by) VALUES($1,true,$2,$3,$4,$5,$6,$7,true,$8)",
          [
            id,
            input.accountId,
            input.activationId,
            input.expectedActivationRevision,
            key,
            publication.identity.payloadSha256,
            plan,
            ctx.userId,
          ],
        );
        await append(c, ctx, id, publication, "PREPARED", input.requestId, fingerprint(input));
        return { id, publication, plan, networkEnabled: false as const };
      }),
    claimLocal: (
      ctx: DistributionContext,
      id: string,
      input: { requestId: string; expectedRevision: number; attemptId: string },
    ) =>
      run(ctx, "operations.manage", async (c) => {
        identifier(input.requestId);
        const initial = await read(c, id);
        const data = await dependencies(c, initial.publication.identity.activationId);
        const held = await account(c, initial.publication.identity.accountId);
        await lock(c, `job:${id}`);
        const current = await read(c, id);
        const hash = fingerprint(input);
        if (await repeated(c, id, input.requestId, hash)) return { ...current, claimed: false };
        const at = await clock(c);
        validateDependencies(data, current.publication.identity.channel, at, true);
        const plan = current.plan;
        if (
          held.revision !== plan.accountRevision ||
          data.activation.revision !== current.publication.identity.activationRevision ||
          data.artifact.revision !== plan.artifactRevision ||
          data.artifact.output.video.sha256 !== plan.artifactSha256 ||
          data.campaign.revision !== plan.campaignRevision ||
          data.cta.revision !== plan.ctaRevision
        )
          throw new Error("CHANNEL_DEPENDENCY_CHANGED");
        const claimed = claimChannelPublication({
          publication: current.publication,
          expectedRevision: input.expectedRevision,
          attemptId: input.attemptId,
          now: at,
          adoption: held.adoption,
          policy: {
            accountId: held.adoption.accountId,
            channel: held.adoption.channel,
            world: "TEST",
            destination: plan.destination,
            visibility: plan.visibility,
            checkedAt: at,
            activationAllowed: true,
            emergencyStop: held.emergencyStop,
            circuitOpen: held.circuitOpen,
            quotaAvailable: true,
            audience: {
              kind: "PUBLIC_CHANNEL",
              authorized: true,
              authorizationId: plan.publicChannelAuthorization,
            },
          },
        });
        if (claimed.dispatch) {
          claimed.publication.leaseUntil = new Date(Date.parse(at) + localLeaseMs).toISOString();
          await append(c, ctx, id, claimed.publication, "CLAIMED", input.requestId, hash);
        }
        return {
          ...current,
          publication: claimed.publication,
          claimed: claimed.dispatch,
          networkEnabled: false as const,
        };
      }),
    recordLocalResult: (
      ctx: DistributionContext,
      id: string,
      input: {
        requestId: string;
        expectedRevision: number;
        attemptId: string;
        outcome: ChannelProviderOutcome;
      },
    ) =>
      run(ctx, "operations.manage", async (c) => {
        identifier(input.requestId);
        await lock(c, `job:${id}`);
        const current = await read(c, id);
        const hash = fingerprint(input);
        if (await repeated(c, id, input.requestId, hash)) return current;
        // Real provider results cannot be mislabeled as this rehearsal's evidence.
        if (
          input.outcome.kind === "COMPLETE" &&
          (!input.outcome.receipt.remoteId.startsWith("fixture") ||
            input.outcome.receipt.remoteDestination !== current.plan.destination ||
            input.outcome.receipt.visibility !== current.plan.visibility)
        )
          throw new Error("CHANNEL_SYNTHETIC_RECEIPT_REQUIRED");
        if (input.outcome.kind === "SESSION_READY" || input.outcome.kind === "RESUME") {
          if (
            new URL(input.outcome.checkpoint.sessionUrl).searchParams.get("upload_id") !==
            "synthetic"
          )
            throw new Error("CHANNEL_SYNTHETIC_SESSION_REQUIRED");
          if (
            input.outcome.checkpoint.artifactSha256 !== current.plan.artifactSha256 ||
            input.outcome.checkpoint.totalBytes !== current.plan.artifactByteSize
          )
            throw new Error("CHANNEL_ARTIFACT_CHANGED");
        }
        const publication = recordChannelOutcome({
          publication: current.publication,
          expectedRevision: input.expectedRevision,
          attemptId: input.attemptId,
          outcome: input.outcome,
          now: await clock(c),
        });
        if (publication !== current.publication)
          await append(c, ctx, id, publication, "SIMULATED_RESULT", input.requestId, hash);
        return { ...current, publication };
      }),
    recoverLocal: (ctx: DistributionContext, id: string) =>
      run(ctx, "operations.manage", async (c) => {
        await lock(c, `job:${id}`);
        const current = await read(c, id);
        const publication = recoverChannelLease(current.publication, await clock(c));
        if (publication !== current.publication)
          await append(
            c,
            ctx,
            id,
            publication,
            "RECOVERED",
            randomUUID(),
            fingerprint({ action: "RECOVERED", revision: publication.revision }),
          );
        return { ...current, publication };
      }),
    getLocal: (ctx: DistributionContext, id: string) =>
      run(ctx, "operations.manage", (c) => read(c, id)),
    listLocal: (ctx: DistributionContext, limit = 50) =>
      run(ctx, "operations.manage", async (c) => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new Error("INVALID_PAGINATION");
        const rows = await c.query(
          "SELECT p.id,p.activation_id,p.account_id,p.created_at,p.plan->'payload'->>'channel' as channel,r.snapshot->>'state' as state,r.snapshot->>'leaseUntil' as lease_until,r.snapshot->>'retryAt' as retry_at FROM distribution.channel_publication p JOIN LATERAL (SELECT snapshot FROM distribution.channel_publication_revision WHERE publication_id=p.id AND is_test=p.is_test ORDER BY revision DESC LIMIT 1) r ON true WHERE p.is_test=true ORDER BY p.created_at DESC,p.id LIMIT $1",
          [limit],
        );
        return {
          mode: "LOCAL_SIMULATION" as const,
          networkEnabled: false as const,
          publications: rows.rows,
        };
      }),
  };
}

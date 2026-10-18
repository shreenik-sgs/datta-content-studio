import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type ActivationPackageInput,
  type CanonicalDestinationEvidence,
  type CtaDefinition,
  type DistributionCapability,
  type OutreachCampaign,
  type TrackedLinkRecord,
  activationDispatchDecision,
  approveChannelActivation,
  canonicalActivationApproval,
  createManualActivation,
  isEditorialApproved,
  requireContentRevision,
  sameActivationDestination,
  stopChannelActivation,
  validateActivationDestination,
  validateActivationPackageInput,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient } from "pg";
import {
  type PersistedActivation,
  appendActivation,
  enqueueLink,
  readActivation,
} from "./activation-invalidation.js";
import type { DistributionRoleAuthority } from "./operator-authority.js";
import { createDistributionRenderRepository } from "./render-repository.js";
import {
  type DistributionContext,
  distributionWorld,
  requireDistributionCapability,
} from "./repository.js";
import { requireIndependentPackageReview } from "./review-integrity.js";
export type { PersistedActivation } from "./activation-invalidation.js";
export type DestinationEvidence =
  | CanonicalDestinationEvidence
  | {
      version: 1;
      isTest: true;
      checkedAt: string;
      results: { path: string; available: boolean; requiresIdentity: boolean }[];
    };
export type ManualActivationDraft = {
  campaignId: string;
  expectedCampaignRevision: number;
  ctaId: string;
  expectedCtaRevision: number;
  artifactId: string;
  expectedArtifactRevision: number;
  scheduledAt: string;
  reviewPackage?: ActivationPackageInput | undefined;
};
const readers: DistributionCapability[] = [
  "campaigns.manage",
  "content.review",
  "content.publish",
  "operations.manage",
];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Local TEST manual exports only. No provider dispatch and no recipient/analytics collection. */
export function createDistributionActivationRepository(
  pool: Pool,
  options: { authorize?: DistributionRoleAuthority } = {},
) {
  const render = createDistributionRenderRepository(pool, options);
  async function run<T>(
    ctx: DistributionContext,
    permissions: readonly DistributionCapability[],
    fn: (client: PoolClient) => Promise<T>,
  ) {
    const world = distributionWorld(ctx);
    if (world !== true) throw new Error("TEST_WORLD_REQUIRED");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await requireDistributionCapability(c, ctx, permissions);
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  async function internal<T>(isTest: boolean, fn: (c: PoolClient) => Promise<T>) {
    if (isTest !== true) throw new Error("TEST_WORLD_REQUIRED");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const v = await fn(c);
      await c.query("COMMIT");
      return v;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async function now(c: PoolClient) {
    return new Date((await c.query("SELECT clock_timestamp() AS now")).rows[0].now).toISOString();
  }
  async function snapshots(c: PoolClient, isTest: boolean, campaignId: string, ctaId: string) {
    for (const [kind, id] of [
      ["campaign", campaignId],
      ["cta", ctaId],
    ]) {
      if (!uuid.test(id as string)) throw new Error("NOT_FOUND");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `distribution:outreach:${kind}:${isTest}:${id}`,
      ]);
    }
    const a = await c.query(
      "SELECT snapshot FROM distribution.outreach_campaign_revision WHERE campaign_id=$1 AND is_test=$2 ORDER BY revision DESC LIMIT 1",
      [campaignId, isTest],
    );
    const b = await c.query(
      "SELECT snapshot FROM distribution.cta_revision WHERE cta_id=$1 AND is_test=$2 ORDER BY revision DESC LIMIT 1",
      [ctaId, isTest],
    );
    if (!a.rows[0] || !b.rows[0]) throw new Error("NOT_FOUND");
    for (const [kind, value] of [
      ["campaign", a.rows[0].snapshot],
      ["cta", b.rows[0].snapshot],
    ] as const) {
      if (value.approval?.decision === "APPROVED")
        await requireIndependentPackageReview(c, {
          isTest,
          kind,
          id: value.id,
          revision: value.revision,
          reviewerId: value.approval.reviewerId,
        });
    }
    return {
      campaign: a.rows[0].snapshot as OutreachCampaign,
      cta: b.rows[0].snapshot as CtaDefinition,
    };
  }
  async function locked(c: PoolClient, isTest: boolean, id: string) {
    if (!uuid.test(id)) throw new Error("NOT_FOUND");
    const initial = await readActivation(c, isTest, id);
    // Global order: source master (also fences artifact/editorial review), campaign, CTA, activation.
    const dependencies = await render.inspectArtifactInTransaction(c, isTest, initial.derivativeId);
    const values = await snapshots(c, isTest, initial.campaignId, initial.ctaId);
    await c.query("SELECT id FROM distribution.activation WHERE id=$1 AND is_test=$2 FOR UPDATE", [
      id,
      isTest,
    ]);
    const activation = await readActivation(c, isTest, id);
    if (activation.approval?.decision === "APPROVED")
      await requireIndependentPackageReview(c, {
        isTest,
        kind: "activation",
        id,
        revision: activation.revision,
        reviewerId: activation.approval.reviewerId,
      });
    return { activation, ...dependencies, ...values };
  }
  function evidence(
    cta: CtaDefinition,
    input: DestinationEvidence,
    at: string,
    primaryRequired: boolean,
  ) {
    if (
      ![1, 2].includes(input.version) ||
      input.isTest !== true ||
      !Number.isFinite(Date.parse(input.checkedAt)) ||
      Date.parse(at) - Date.parse(input.checkedAt) > 30000 ||
      Date.parse(input.checkedAt) - Date.parse(at) > 2000
    )
      throw new Error("DESTINATION_CHECK_STALE");
    if (input.results.length !== 2) throw new Error("DESTINATION_UNAVAILABLE");
    for (const [index, destination] of [cta.destination, cta.fallback].entries()) {
      const matches = input.results.filter((x) => x.path === destination.path);
      const found = matches[0];
      if (
        matches.length !== 1 ||
        !found ||
        ((index === 1 || primaryRequired) && !found.available) ||
        (found.requiresIdentity && !destination.requiresIdentity)
      )
        throw new Error("DESTINATION_UNAVAILABLE");
    }
  }
  type Locked = Awaited<ReturnType<typeof locked>>;
  function current(data: Locked) {
    const { activation: a, master, artifact, eligibility, campaign, cta, job } = data;
    if (!eligibility.allowed) throw new Error(eligibility.reason);
    if (a.reviewPackage && master.rights?.privacyClass !== "PUBLIC")
      throw new Error("RIGHTS_REFUSED");
    if (
      a.masterId !== master.id ||
      a.sourceRevision !== master.revision ||
      a.sourceVersionId !== master.currentVersion.id ||
      a.recipeSha256 !== artifact.recipeSha256 ||
      a.assetSha256 !== artifact.output.video.sha256 ||
      a.derivativeRevision !== artifact.revision ||
      job.recipe.channel !== "manual_export"
    )
      throw new Error("ACTIVATION_DEPENDENCY_CHANGED");
    if (
      campaign.id !== a.campaignId ||
      campaign.revision !== a.campaignRevision ||
      campaign.status !== "APPROVED" ||
      !isEditorialApproved(campaign.approval, campaign.revision)
    )
      throw new Error("CAMPAIGN_NOT_APPROVED");
    if (
      cta.id !== a.ctaId ||
      cta.revision !== a.ctaRevision ||
      !isEditorialApproved(cta.approval, cta.revision)
    )
      throw new Error("CTA_NOT_APPROVED");
  }
  function packageCheck(data: Locked, input: DestinationEvidence, at: string, requireTest = true) {
    const pkg = data.activation.reviewPackage;
    if (!pkg) return null;
    if (input.version !== 2) throw new Error("DESTINATION_TEST_REQUIRED");
    const tested = validateActivationDestination(pkg, data.cta, input, at);
    if (
      requireTest &&
      (!pkg.destinationTest || !sameActivationDestination(pkg.destinationTest, tested))
    )
      throw new Error("DESTINATION_TEST_REQUIRED");
    return tested;
  }
  function approvalSeal(a: PersistedActivation): string {
    if (!a.reviewPackage?.destinationTest) throw new Error("DESTINATION_TEST_REQUIRED");
    return createHash("sha256")
      .update(
        canonicalActivationApproval({
          activationId: a.id,
          activationRevision: a.revision,
          masterId: a.masterId,
          sourceVersionId: a.sourceVersionId,
          sourceRevision: a.sourceRevision,
          derivativeId: a.derivativeId,
          derivativeRevision: a.derivativeRevision,
          recipeSha256: a.recipeSha256,
          assetSha256: a.assetSha256,
          cta: a.pinnedCta,
          reviewPackage: a.reviewPackage,
        }),
      )
      .digest("hex");
  }
  function dispatch(data: Locked, at: string) {
    current(data);
    if (
      data.activation.reviewPackage &&
      data.activation.approvalPackageSha256 !== approvalSeal(data.activation)
    )
      throw new Error("ACTIVATION_PACKAGE_CHANGED");
    const { activation, master, artifact, campaign, cta } = data;
    const decision = activationDispatchDecision({
      activation,
      campaign,
      cta,
      derivative: {
        id: artifact.id,
        revision: artifact.revision,
        sourceVersionId: master.currentVersion.id,
        approval: artifact.approval,
        withdrawn: master.state === "WITHDRAWN",
      },
      channelAccount: null,
      sourceRightsAllowed: true,
      audienceAllowed: true,
      now: at,
    });
    if (!decision.allowed) throw new Error(decision.reason);
  }
  function binding(a: PersistedActivation, at: string): TrackedLinkRecord {
    return {
      schemaVersion: 1,
      token: a.token,
      isTest: true,
      sequence: 1,
      activationId: a.id,
      activationRevision: a.revision,
      campaignId: a.campaignId,
      campaignRevision: a.campaignRevision,
      contentId: a.masterId,
      sourceVersionId: a.sourceVersionId,
      derivativeId: a.derivativeId,
      derivativeRevision: a.derivativeRevision,
      title: a.title,
      cta: {
        ...a.pinnedCta,
        approval: a.pinnedCta.approval
          ? { ...a.pinnedCta.approval, reviewerId: "human-review" }
          : null,
      },
      language: a.language as TrackedLinkRecord["language"],
      startsAt: new Date(
        Math.max(Date.parse(a.pinnedCampaign.startsAt), Date.parse(a.scheduledAt)),
      ).toISOString(),
      endsAt: new Date(a.pinnedCampaign.endsAt).toISOString(),
      checkedAt: at,
      status: "ACTIVE",
      destinationAvailable: true,
      ...(a.reviewPackage?.destinationTest && a.approvalPackageSha256
        ? {
            social: {
              channel: a.reviewPackage.channel,
              promise: a.reviewPackage.promise,
              canonicalId: a.reviewPackage.destinationTest.destination.canonicalId as string,
              canonicalRevision: a.reviewPackage.destinationTest.destination.revision as string,
              accessMode: a.reviewPackage.destinationTest.destination.accessMode as
                | "PUBLIC"
                | "AUTH_REQUIRED",
              fallbackAccessMode: a.reviewPackage.destinationTest.fallback.accessMode as
                | "PUBLIC"
                | "AUTH_REQUIRED",
              approvalPackageSha256: a.approvalPackageSha256,
            },
          }
        : {}),
    };
  }
  return {
    choices: (ctx: DistributionContext) =>
      run(ctx, readers, async (c) => {
        const rows = await c.query(
          "SELECT a.id FROM distribution.render_artifact a WHERE a.is_test=$1 ORDER BY a.created_at DESC,a.id LIMIT 50",
          [ctx.isTest],
        );
        const options: { id: string; revision: number; title: string; language: string }[] = [];
        // Read-only selection. Revalidated with ordered locks when creating an activation.
        for (const row of rows.rows) {
          const value = await render.inspectArtifactInTransaction(c, ctx.isTest, row.id, false);
          if (value.eligibility.allowed && value.job.recipe.channel === "manual_export")
            options.push({
              id: row.id,
              revision: value.artifact.revision,
              title: value.master.title,
              language: value.job.recipe.language,
            });
        }
        return options;
      }),
    create: (ctx: DistributionContext, input: ManualActivationDraft) =>
      run(ctx, ["campaigns.manage"], async (c) => {
        const dep = await render.inspectArtifactInTransaction(c, ctx.isTest, input.artifactId);
        if (!dep.eligibility.allowed) throw new Error(dep.eligibility.reason);
        const { campaign, cta } = await snapshots(c, ctx.isTest, input.campaignId, input.ctaId);
        requireContentRevision(campaign.revision, input.expectedCampaignRevision);
        requireContentRevision(cta.revision, input.expectedCtaRevision);
        requireContentRevision(dep.artifact.revision, input.expectedArtifactRevision);
        if (
          campaign.status !== "APPROVED" ||
          !isEditorialApproved(campaign.approval, campaign.revision)
        )
          throw new Error("CAMPAIGN_NOT_APPROVED");
        if (!isEditorialApproved(cta.approval, cta.revision)) throw new Error("CTA_NOT_APPROVED");
        if (!["en", "hi", "te", "kn", "ta", "ml", "gu"].includes(cta.language))
          throw new Error("UNSUPPORTED_LINK_LANGUAGE");
        if (!cta.destination.path.startsWith("/") || !cta.fallback.path.startsWith("/"))
          throw new Error("UNSAFE_DESTINATION");
        if (dep.job.recipe.channel !== "manual_export") throw new Error("CHANNEL_UNAVAILABLE");
        if (
          Date.parse(input.scheduledAt) < Date.parse(campaign.startsAt) ||
          Date.parse(input.scheduledAt) >= Date.parse(campaign.endsAt)
        )
          throw new Error("CAMPAIGN_OUTSIDE_WINDOW");
        if (input.reviewPackage) {
          validateActivationPackageInput(input.reviewPackage);
          if (dep.master.rights?.privacyClass !== "PUBLIC") throw new Error("RIGHTS_REFUSED");
        }
        const a: PersistedActivation = {
          ...createManualActivation({
            id: randomUUID(),
            campaignId: campaign.id,
            campaignRevision: campaign.revision,
            ctaId: cta.id,
            ctaRevision: cta.revision,
            derivativeId: dep.artifact.id,
            derivativeRevision: dep.artifact.revision,
            sourceVersionId: dep.master.currentVersion.id,
            channelAccountId: null,
            channel: "manual_export",
            scheduledAt: input.scheduledAt,
          }),
          masterId: dep.master.id,
          sourceRevision: dep.master.revision,
          title: dep.master.title,
          language: cta.language,
          recipeSha256: dep.artifact.recipeSha256,
          assetSha256: dep.artifact.output.video.sha256,
          token: randomBytes(32).toString("base64url"),
          pinnedCampaign: campaign,
          pinnedCta: cta,
          linkBinding: null,
          invalidatedReason: null,
          ...(input.reviewPackage
            ? {
                reviewPackage: {
                  ...input.reviewPackage,
                  schemaVersion: 1 as const,
                  source: {
                    startMs: dep.job.recipe.startMs,
                    endMs: dep.job.recipe.endMs,
                    transcriptVersionId: dep.job.recipe.transcriptVersionId,
                    transcriptRevision: dep.job.recipe.transcriptRevision,
                    hasCaptions: Boolean(dep.artifact.output.captions),
                    aspect: dep.job.recipe.aspect,
                    nativeApproval: dep.job.recipe.nativeApproval ?? null,
                  },
                  destinationTest: null,
                },
              }
            : {}),
        };
        await c.query(
          "INSERT INTO distribution.activation(id,is_test,master_id,campaign_id,cta_id,artifact_id,token,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            a.id,
            ctx.isTest,
            a.masterId,
            a.campaignId,
            a.ctaId,
            a.derivativeId,
            a.token,
            ctx.userId,
          ],
        );
        return appendActivation(c, ctx.isTest, a, ctx.userId, "CREATED");
      }),
    get: (ctx: DistributionContext, id: string) =>
      run(ctx, readers, (c) => readActivation(c, ctx.isTest, id)),
    list: (
      ctx: DistributionContext,
      input: { campaignId?: string; limit?: number; offset?: number } = {},
    ) =>
      run(ctx, readers, async (c) => {
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
        const rows = await c.query(
          "SELECT r.snapshot FROM distribution.activation a JOIN LATERAL(SELECT snapshot FROM distribution.activation_revision WHERE activation_id=a.id AND is_test=a.is_test ORDER BY revision DESC LIMIT 1) r ON true WHERE a.is_test=$1 AND ($2::uuid IS NULL OR a.campaign_id=$2) ORDER BY a.created_at DESC,a.id LIMIT $3 OFFSET $4",
          [ctx.isTest, input.campaignId ?? null, limit, offset],
        );
        return rows.rows.map((row) => row.snapshot as PersistedActivation);
      }),
    revisePackage: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        reviewPackage: ActivationPackageInput;
      },
    ) =>
      run(ctx, ["campaigns.manage"], async (c) => {
        const data = await locked(c, ctx.isTest, id);
        const before = data.activation;
        requireContentRevision(before.revision, input.expectedRevision);
        current(data);
        if (before.status === "STOPPED") throw new Error("ACTIVATION_STOPPED");
        validateActivationPackageInput(input.reviewPackage);
        if (data.master.rights?.privacyClass !== "PUBLIC") throw new Error("RIGHTS_REFUSED");
        const reviewPackage = {
          ...input.reviewPackage,
          schemaVersion: 1 as const,
          source: {
            startMs: data.job.recipe.startMs,
            endMs: data.job.recipe.endMs,
            transcriptVersionId: data.job.recipe.transcriptVersionId,
            transcriptRevision: data.job.recipe.transcriptRevision,
            hasCaptions: Boolean(data.artifact.output.captions),
            aspect: data.job.recipe.aspect,
            nativeApproval: data.job.recipe.nativeApproval ?? null,
          },
          destinationTest: null,
        };
        if (before.status === "DRAFT")
          return appendActivation(
            c,
            ctx.isTest,
            {
              ...before,
              reviewPackage,
              revision: before.revision + 1,
              approval: null,
            },
            ctx.userId,
            "EDITED",
          );
        // Approved packages retain their exact history and token. A revision gets a fresh identity;
        // the old activation is stopped in the same transaction and cannot be silently reopened.
        const stopped = { ...before, ...stopChannelActivation(before, before.revision) };
        await appendActivation(c, ctx.isTest, stopped, ctx.userId, "STOPPED");
        if (before.linkBinding)
          await enqueueLink(c, ctx.isTest, id, {
            ...before.linkBinding,
            status: "STOPPED",
            destinationAvailable: false,
          });
        const { approvalPackageSha256: _oldSeal, ...unsealed } = before;
        const replacement: PersistedActivation = {
          ...unsealed,
          id: randomUUID(),
          revision: 1,
          status: "DRAFT",
          approval: null,
          token: randomBytes(32).toString("base64url"),
          linkBinding: null,
          invalidatedReason: null,
          reviewPackage,
          supersedesActivationId: before.id,
        };
        await c.query(
          "INSERT INTO distribution.activation(id,is_test,master_id,campaign_id,cta_id,artifact_id,token,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            replacement.id,
            ctx.isTest,
            replacement.masterId,
            replacement.campaignId,
            replacement.ctaId,
            replacement.derivativeId,
            replacement.token,
            ctx.userId,
          ],
        );
        return appendActivation(c, ctx.isTest, replacement, ctx.userId, "CREATED");
      }),
    validateDestination: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        destinations: CanonicalDestinationEvidence;
      },
    ) =>
      run(ctx, ["campaigns.manage", "content.review"], async (c) => {
        const data = await locked(c, ctx.isTest, id);
        requireContentRevision(data.activation.revision, input.expectedRevision);
        current(data);
        if (data.activation.status !== "DRAFT") throw new Error("ACTIVATION_NOT_DRAFT");
        const pkg = data.activation.reviewPackage;
        if (!pkg) throw new Error("INVALID_ACTIVATION_PACKAGE");
        const tested = packageCheck(data, input.destinations, await now(c), false);
        return appendActivation(
          c,
          ctx.isTest,
          {
            ...data.activation,
            revision: data.activation.revision + 1,
            reviewPackage: { ...pkg, destinationTest: tested },
          },
          ctx.userId,
          "DESTINATION_VALIDATED",
        );
      }),
    approve: (
      ctx: DistributionContext,
      id: string,
      input: { expectedRevision: number; destinations: DestinationEvidence },
    ) =>
      run(ctx, ["content.review"], async (c) => {
        const data = await locked(c, ctx.isTest, id);
        // Report the stale review before testing the contents of somebody else's revision.
        requireContentRevision(data.activation.revision, input.expectedRevision);
        await requireIndependentPackageReview(c, {
          isTest: ctx.isTest,
          kind: "activation",
          id,
          revision: data.activation.revision,
          reviewerId: ctx.userId,
        });
        current(data);
        const at = await now(c);
        evidence(data.cta, input.destinations, at, true);
        packageCheck(data, input.destinations, at);
        const a: PersistedActivation = {
          ...data.activation,
          ...approveChannelActivation(data.activation, {
            expectedRevision: input.expectedRevision,
            reviewerId: ctx.userId,
            reviewedAt: at,
          }),
        };
        if (Date.parse(a.pinnedCampaign.endsAt) <= Date.parse(at))
          throw new Error("CAMPAIGN_OUTSIDE_WINDOW");
        if (a.reviewPackage) a.approvalPackageSha256 = approvalSeal(a);
        a.linkBinding = await enqueueLink(
          c,
          ctx.isTest,
          a.id,
          binding(a, input.destinations.checkedAt),
        );
        return appendActivation(c, ctx.isTest, a, ctx.userId, "APPROVED");
      }),
    stop: (ctx: DistributionContext, id: string, input: { expectedRevision: number }) =>
      run(ctx, ["campaigns.manage", "operations.manage"], async (c) => {
        // Stops depend on no source availability; they acquire only activation, always last in the order.
        await c.query(
          "SELECT id FROM distribution.activation WHERE id=$1 AND is_test=$2 FOR UPDATE",
          [id, ctx.isTest],
        );
        const before = await readActivation(c, ctx.isTest, id);
        const a = { ...before, ...stopChannelActivation(before, input.expectedRevision) };
        if (before.linkBinding)
          await enqueueLink(c, ctx.isTest, id, {
            ...before.linkBinding,
            status: "STOPPED",
            destinationAvailable: false,
          });
        return appendActivation(c, ctx.isTest, a, ctx.userId, "STOPPED");
      }),
    getExport: (
      ctx: DistributionContext,
      id: string,
      input: { expectedRevision: number; destinations: DestinationEvidence; recordAudit?: boolean },
    ) =>
      run(ctx, ["content.publish"], async (c) => {
        const data = await locked(c, ctx.isTest, id);
        requireContentRevision(data.activation.revision, input.expectedRevision);
        const at = await now(c);
        dispatch(data, at);
        evidence(data.cta, input.destinations, at, true);
        packageCheck(data, input.destinations, at);
        if (input.recordAudit !== false)
          await c.query(
            "INSERT INTO distribution.audit_event(master_id,is_test,actor_id,action,revision) VALUES($1,$2,$3,'ACTIVATION_MANUAL_EXPORT',$4)",
            [data.master.id, ctx.isTest, ctx.userId, data.master.revision],
          );
        return {
          activation: data.activation,
          artifact: data.artifact,
          renderContext: {
            masterId: data.job.masterId,
            sourceVersionId: data.job.sourceVersionId,
            recipe: data.job.recipe,
          },
        };
      }),
    // Internal worker only: private fixed origin destination checks must precede this call.
    refreshCandidates: (input: { isTest: boolean; limit?: number }) =>
      internal(input.isTest, async (c) => {
        const limit = input.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
          throw new Error("INVALID_PAGINATION");
        const rows = await c.query(
          "SELECT r.snapshot FROM distribution.activation a JOIN LATERAL(SELECT snapshot FROM distribution.activation_revision WHERE activation_id=a.id AND is_test=a.is_test ORDER BY revision DESC LIMIT 1) r ON true WHERE a.is_test=$1 AND r.snapshot->>'status'='APPROVED' ORDER BY (SELECT max(created_at) FROM distribution.link_outbox WHERE activation_id=a.id AND is_test=a.is_test) ASC NULLS FIRST,a.id LIMIT $2",
          [input.isTest, limit],
        );
        return rows.rows.map((row) => row.snapshot as PersistedActivation);
      }),
    refresh: (input: { isTest: boolean; id: string; destinations: DestinationEvidence }) =>
      internal(input.isTest, async (c) => {
        const data = await locked(c, input.isTest, input.id);
        const a = data.activation;
        if (a.status !== "APPROVED" || !a.linkBinding) return null;
        const at = await now(c);
        let reason: string | null = null;
        try {
          current(data);
          if (a.reviewPackage) packageCheck(data, input.destinations, at);
          if (Date.parse(at) >= Date.parse(a.pinnedCampaign.endsAt))
            throw new Error("CAMPAIGN_OUTSIDE_WINDOW");
          evidence(data.cta, input.destinations, at, false);
        } catch (error) {
          reason = error instanceof Error ? error.message : "ACTIVATION_DEPENDENCY_CHANGED";
        }
        if (reason) {
          const stopped = {
            ...a,
            ...stopChannelActivation(a, a.revision),
            invalidatedReason: reason,
          };
          await appendActivation(c, input.isTest, stopped, "materializer", "INVALIDATED");
          return enqueueLink(c, input.isTest, a.id, {
            ...a.linkBinding,
            status: "STALE",
            destinationAvailable: false,
            fallbackReason:
              reason === "FEATURE_UNAVAILABLE"
                ? "FEATURE_UNAVAILABLE"
                : reason === "DESTINATION_UNAVAILABLE"
                  ? "DESTINATION_UNAVAILABLE"
                  : reason === "CAMPAIGN_OUTSIDE_WINDOW"
                    ? "CAMPAIGN_OUTSIDE_WINDOW"
                    : "SOURCE_OR_ACTIVATION_WITHDRAWN",
          });
        }
        return enqueueLink(c, input.isTest, a.id, {
          ...a.linkBinding,
          checkedAt: input.destinations.checkedAt,
          status: "ACTIVE",
          destinationAvailable:
            input.destinations.results.find((r) => r.path === data.cta.destination.path)
              ?.available === true,
        });
      }),
    deliverNext: (input: {
      isTest: boolean;
      publish: (record: TrackedLinkRecord) => Promise<unknown>;
    }) =>
      internal(input.isTest, async (c) => {
        // Only activation lock is required here. An invalidation cannot commit between selection and atomic cache publication.
        const rows = await c.query(
          "SELECT a.id FROM distribution.activation a WHERE a.is_test=$1 AND EXISTS(SELECT 1 FROM distribution.link_outbox o WHERE o.activation_id=a.id AND o.is_test=a.is_test AND o.delivered_at IS NULL) ORDER BY a.id FOR UPDATE SKIP LOCKED LIMIT 1",
          [input.isTest],
        );
        if (!rows.rows[0]) return null;
        const id = rows.rows[0].id;
        const pending = await c.query(
          "SELECT record,sequence FROM distribution.link_outbox WHERE activation_id=$1 AND is_test=$2 AND delivered_at IS NULL ORDER BY sequence DESC LIMIT 1",
          [id, input.isTest],
        );
        const record = pending.rows[0].record as TrackedLinkRecord;
        const a = await readActivation(c, input.isTest, id);
        if (record.status === "ACTIVE" && a.status !== "APPROVED")
          throw new Error("STALE_MATERIALIZATION");
        await input.publish(record);
        await c.query(
          "UPDATE distribution.link_outbox SET delivered_at=clock_timestamp() WHERE activation_id=$1 AND is_test=$2 AND sequence<=$3 AND delivered_at IS NULL",
          [id, input.isTest, record.sequence],
        );
        return record;
      }),
  };
}
export type DistributionActivationRepository = ReturnType<
  typeof createDistributionActivationRepository
>;

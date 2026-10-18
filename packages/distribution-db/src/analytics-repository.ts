import { createHash, randomUUID } from "node:crypto";
import {
  type AnalyticsAggregate,
  type AnalyticsEvent,
  type OutreachCampaign,
  aggregateAnalytics,
  isEditorialApproved,
  validateAnalyticsEvent,
  validateOutreachCampaign,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient } from "pg";
import {
  type DistributionContext,
  distributionWorld,
  requireDistributionCapability,
} from "./repository.js";
const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
          : v,
      ),
    )
    .digest("hex");
export type ProviderMetricInput = {
  id: string;
  campaignId: string;
  provider: "youtube" | "telegram" | "manual_fixture";
  metric: "views" | "impressions" | "reach" | "cost_micros";
  value: number;
  currency: "USD" | "INR" | "EUR" | null;
  definitionVersion: 1;
  observedAt: string;
};
export function createDistributionAnalyticsRepository(pool: Pool) {
  async function run<T>(
    ctx: DistributionContext,
    capability: "analytics.view" | "operations.manage",
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    distributionWorld(ctx);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='5s'");
      await requireDistributionCapability(client, ctx, [capability]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function policy(client: PoolClient, ctx: DistributionContext) {
    const rows = await client.query(
      "SELECT *,clock_timestamp() as now FROM distribution.analytics_policy WHERE is_test=$1",
      [distributionWorld(ctx)],
    );
    if (!rows.rows[0]) throw new Error("ANALYTICS_POLICY_REQUIRED");
    return rows.rows[0] as { retention_days: number; now: Date };
  }
  async function campaign(client: PoolClient, ctx: DistributionContext, id: string) {
    const rows = await client.query(
      "SELECT r.snapshot FROM distribution.outreach_campaign c JOIN distribution.outreach_campaign_revision r ON r.campaign_id=c.id AND r.is_test=c.is_test WHERE c.id=$1 AND c.is_test=$2 AND r.action='APPROVED' ORDER BY r.revision DESC LIMIT 1",
      [id, distributionWorld(ctx)],
    );
    const approved = rows.rows[0]?.snapshot as OutreachCampaign | undefined;
    if (
      !approved ||
      approved.status !== "APPROVED" ||
      !isEditorialApproved(approved.approval, approved.revision)
    )
      throw new Error("ANALYTICS_CAMPAIGN_DEFINITION_REQUIRED");
    validateOutreachCampaign(approved);
    return approved;
  }
  async function lineage(client: PoolClient, ctx: DistributionContext, event: AnalyticsEvent) {
    if (!event.activationId && !event.contentId && !event.ctaId) return;
    const matched = await client.query(
      "SELECT 1 FROM distribution.activation WHERE is_test=$1 AND campaign_id=$2 AND ($3::uuid IS NULL OR id=$3) AND ($4::uuid IS NULL OR master_id=$4) AND ($5::uuid IS NULL OR cta_id=$5) LIMIT 1",
      [distributionWorld(ctx), event.campaignId, event.activationId, event.contentId, event.ctaId],
    );
    if (!matched.rowCount) throw new Error("INVALID_ANALYTICS_LINEAGE");
  }
  return {
    approvePolicy: (
      ctx: DistributionContext,
      input: { requestId: string; retentionDays: number; approvalReference: string },
    ) =>
      run(ctx, "operations.manage", async (client) => {
        if (!ctx.isTest) throw new Error("TEST_WORLD_REQUIRED");
        if (
          !Number.isSafeInteger(input.retentionDays) ||
          input.retentionDays < 7 ||
          input.retentionDays > 90
        )
          throw new Error("INVALID_ANALYTICS_POLICY");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('analytics-policy:'||$1,0))",
          [String(ctx.isTest)],
        );
        const existing = await client.query(
          "SELECT * FROM distribution.analytics_policy WHERE is_test=$1",
          [ctx.isTest],
        );
        const old = existing.rows[0];
        if (old?.request_id === input.requestId) {
          if (
            old.retention_days !== input.retentionDays ||
            old.approval_reference !== input.approvalReference
          )
            throw new Error("IDEMPOTENCY_CONFLICT");
          return;
        }
        if (old) throw new Error("ANALYTICS_POLICY_ALREADY_APPROVED");
        await client.query(
          "INSERT INTO distribution.analytics_policy(is_test,request_id,retention_days,approval_reference,approved_by) VALUES($1,$2,$3,$4,$5)",
          [ctx.isTest, input.requestId, input.retentionDays, input.approvalReference, ctx.userId],
        );
      }),
    ingest: (ctx: DistributionContext, events: readonly AnalyticsEvent[]) =>
      run(ctx, "operations.manage", async (client) => {
        if (!ctx.isTest) throw new Error("TEST_WORLD_REQUIRED");
        const approved = await policy(client, ctx);
        if (!events.length || events.length > 500) throw new Error("INVALID_ANALYTICS_BATCH");
        // Match reconciliation's lock order. This makes received_at a reliable
        // publication watermark even when ingestion transactions overlap a rebuild.
        for (const campaignId of [...new Set(events.map((event) => event.campaignId))].sort()) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `analytics-reconcile:${ctx.isTest}:${campaignId}`,
          ]);
        }
        let inserted = 0;
        let duplicates = 0;
        for (const event of events) {
          validateAnalyticsEvent(event, approved.now.getTime());
          if (event.source !== "operator_fixture")
            throw new Error("ANALYTICS_PRODUCER_NOT_ADOPTED");
          if (
            Date.parse(event.occurredAt) <
            approved.now.getTime() - approved.retention_days * 86400000
          )
            throw new Error("ANALYTICS_RETENTION_WINDOW");
          await campaign(client, ctx, event.campaignId);
          // Every supplied identifier must describe one actual campaign activation.
          await lineage(client, ctx, event);
          const hash = fingerprint(event);
          const receipt = await client.query(
            "INSERT INTO distribution.analytics_receipt(id,is_test,source,source_event_id,name,fingerprint) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",
            [event.id, ctx.isTest, event.source, event.sourceEventId, event.name, hash],
          );
          if (!receipt.rowCount) {
            const held = await client.query(
              "SELECT id,fingerprint FROM distribution.analytics_receipt WHERE is_test=$1 AND (id=$2 OR (source=$3 AND source_event_id=$4 AND name=$5))",
              [ctx.isTest, event.id, event.source, event.sourceEventId, event.name],
            );
            if (
              held.rows.length !== 1 ||
              held.rows[0].id !== event.id ||
              held.rows[0].fingerprint !== hash
            )
              throw new Error("IDEMPOTENCY_CONFLICT");
            duplicates++;
            continue;
          }
          await client.query(
            "INSERT INTO distribution.analytics_event(id,is_test,campaign_id,occurred_at,event,received_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())",
            [event.id, ctx.isTest, event.campaignId, event.occurredAt, event],
          );
          inserted++;
        }
        return { inserted, duplicates };
      }),
    reconcile: (
      ctx: DistributionContext,
      input:
        | { campaignId: string; windowStart: string; windowEnd: string }
        | { campaignId: string; days: number },
    ) =>
      run(ctx, "operations.manage", async (client) => {
        if (!ctx.isTest) throw new Error("TEST_WORLD_REQUIRED");
        // Serialize publication before reading source rows, so a late-event rebuild
        // cannot be overtaken by an older concurrent snapshot of the same campaign.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `analytics-reconcile:${ctx.isTest}:${input.campaignId}`,
        ]);
        const approved = await policy(client, ctx);
        const definition = await campaign(client, ctx, input.campaignId);
        if (
          "days" in input &&
          (!Number.isInteger(input.days) ||
            input.days < 1 ||
            input.days > 31 ||
            input.days > approved.retention_days)
        )
          throw new Error("INVALID_ANALYTICS_WINDOW");
        const windowStart =
          "days" in input
            ? new Date(approved.now.getTime() - input.days * 86400000).toISOString()
            : input.windowStart;
        const windowEnd = "days" in input ? approved.now.toISOString() : input.windowEnd;
        const start = Date.parse(windowStart);
        const end = Date.parse(windowEnd);
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start >= end ||
          end - start > 31 * 86400000 ||
          start < approved.now.getTime() - approved.retention_days * 86400000 ||
          end > approved.now.getTime() + 300000
        )
          throw new Error("INVALID_ANALYTICS_WINDOW");
        // A bounded work unit with no partial publication. Late voids outside the display window remain relevant.
        const rows = await client.query(
          "SELECT e.event,r.fingerprint FROM distribution.analytics_event e JOIN distribution.analytics_receipt r ON r.id=e.id AND r.is_test=e.is_test WHERE e.is_test=$1 AND e.campaign_id=$2 AND ((e.occurred_at >= $3 AND e.occurred_at < $4) OR e.event->>'name'='practice.voided') ORDER BY e.id LIMIT 10001",
          [ctx.isTest, input.campaignId, windowStart, windowEnd],
        );
        if (rows.rows.length > 10000) throw new Error("ANALYTICS_REBUILD_LIMIT");
        const sourceFingerprint = fingerprint({
          definition,
          windowStart: windowStart,
          windowEnd: windowEnd,
          events: rows.rows.map((r) => r.fingerprint),
        });
        const report = aggregateAnalytics(
          rows.rows.map((r) => r.event),
          {
            start: windowStart,
            end: windowEnd,
            now: approved.now.toISOString(),
            outcomes: definition.outcomes,
          },
        );
        const saved = await client.query(
          "INSERT INTO distribution.aggregate_snapshot(id,is_test,campaign_id,window_start,window_end,source_fingerprint,report,generated_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()) ON CONFLICT(is_test,campaign_id,window_start,window_end,source_fingerprint) DO NOTHING RETURNING id",
          [
            randomUUID(),
            ctx.isTest,
            input.campaignId,
            windowStart,
            windowEnd,
            sourceFingerprint,
            report,
          ],
        );
        if (!saved.rowCount) {
          const old = await client.query(
            "SELECT report FROM distribution.aggregate_snapshot WHERE is_test=$1 AND campaign_id=$2 AND window_start=$3 AND window_end=$4 AND source_fingerprint=$5",
            [ctx.isTest, input.campaignId, windowStart, windowEnd, sourceFingerprint],
          );
          return old.rows[0].report as AnalyticsAggregate;
        }
        return report;
      }),
    providerSnapshot: (ctx: DistributionContext, input: ProviderMetricInput) =>
      run(ctx, "operations.manage", async (client) => {
        if (!ctx.isTest || input.provider !== "manual_fixture")
          throw new Error("ANALYTICS_PRODUCER_NOT_ADOPTED");
        const approved = await policy(client, ctx);
        await campaign(client, ctx, input.campaignId);
        if (
          !Number.isSafeInteger(input.value) ||
          input.value < 0 ||
          !Number.isFinite(Date.parse(input.observedAt)) ||
          Date.parse(input.observedAt) <
            approved.now.getTime() - approved.retention_days * 86400000 ||
          Date.parse(input.observedAt) > approved.now.getTime() + 300000 ||
          input.definitionVersion !== 1 ||
          !["views", "impressions", "reach", "cost_micros"].includes(input.metric) ||
          (input.metric === "cost_micros"
            ? !["USD", "INR", "EUR"].includes(input.currency ?? "")
            : input.currency !== null)
        )
          throw new Error("INVALID_PROVIDER_METRIC");
        const hash = fingerprint(input);
        const saved = await client.query(
          "INSERT INTO distribution.provider_metric_snapshot(id,is_test,campaign_id,provider,metric,value,currency,definition_version,observed_at,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id",
          [
            input.id,
            ctx.isTest,
            input.campaignId,
            input.provider,
            input.metric,
            input.value,
            input.currency,
            input.definitionVersion,
            input.observedAt,
            hash,
          ],
        );
        if (!saved.rowCount) {
          const held = await client.query(
            "SELECT fingerprint FROM distribution.provider_metric_snapshot WHERE id=$1 AND is_test=$2",
            [input.id, ctx.isTest],
          );
          if (held.rows[0]?.fingerprint !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
        }
      }),
    dashboard: (ctx: DistributionContext) =>
      run(ctx, "analytics.view", async (client) => {
        const policies = await client.query(
          "SELECT retention_days,approval_reference,approved_at FROM distribution.analytics_policy WHERE is_test=$1",
          [ctx.isTest],
        );
        const latest = await client.query(
          "SELECT DISTINCT ON(s.campaign_id) s.campaign_id,s.report,s.generated_at,EXISTS(SELECT 1 FROM distribution.analytics_event e WHERE e.is_test=s.is_test AND e.campaign_id=s.campaign_id AND e.received_at>s.generated_at AND ((e.occurred_at>=s.window_start AND e.occurred_at<s.window_end) OR e.event->>'name'='practice.voided')) as stale FROM distribution.aggregate_snapshot s WHERE s.is_test=$1 ORDER BY s.campaign_id,s.generated_at DESC,s.id DESC LIMIT 100",
          [ctx.isTest],
        );
        const approvedCampaigns = await client.query(
          "SELECT c.id,r.snapshot->>'name' as name FROM distribution.outreach_campaign c JOIN LATERAL(SELECT snapshot FROM distribution.outreach_campaign_revision WHERE campaign_id=c.id AND is_test=c.is_test AND action='APPROVED' ORDER BY revision DESC LIMIT 1) r ON true WHERE c.is_test=$1 ORDER BY c.id LIMIT 100",
          [ctx.isTest],
        );
        const providers = await client.query(
          "SELECT DISTINCT ON(campaign_id,provider,metric,currency) campaign_id,provider,metric,value::text,currency,definition_version,observed_at,retrieved_at FROM distribution.provider_metric_snapshot WHERE is_test=$1 ORDER BY campaign_id,provider,metric,currency,observed_at DESC,retrieved_at DESC LIMIT 100",
          [ctx.isTest],
        );
        const health = await client.query(
          "SELECT (SELECT count(*)::int FROM distribution.render_job WHERE is_test=$1 AND status='QUEUED') as queued_renders,(SELECT count(*)::int FROM distribution.render_job WHERE is_test=$1 AND status='FAILED') as failed_renders,(SELECT count(*)::int FROM distribution.analytics_event WHERE is_test=$1 AND received_at<clock_timestamp()-(SELECT retention_days FROM distribution.analytics_policy WHERE is_test=$1)*interval '1 day') as retention_alerts",
          [ctx.isTest],
        );
        const clock = await client.query("SELECT clock_timestamp() AS now");
        return {
          policy: policies.rows[0] ?? null,
          campaigns: approvedCampaigns.rows as { id: string; name: string }[],
          snapshots: latest.rows.map((row) => {
            const {
              sourceEvents: _sourceEvents,
              unmatchedCompletions: _unmatchedCompletions,
              ...report
            } = row.report as AnalyticsAggregate;
            return {
              campaign_id: String(row.campaign_id),
              generated_at: row.generated_at as Date,
              stale: Boolean(row.stale),
              report,
            };
          }),
          providerSnapshots: providers.rows,
          health: health.rows[0],
          asOf: (clock.rows[0].now as Date).toISOString(),
          productionCollectionEnabled: false,
        };
      }),
  };
}

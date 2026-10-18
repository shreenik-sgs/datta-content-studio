import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AnalyticsEvent } from "@satsang/distribution-domain";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDistributionAnalyticsRepository } from "./analytics-repository";
import { createDistributionOutreachRepository } from "./outreach-repository";
import { createDistributionRepository, provisionDistributionCapabilities } from "./repository";
const suite = process.env.DISTRIBUTION_RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("R6 governed analytics on an isolated local runtime role", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `distribution_r6_${suffix}`;
  const migrateRole = `distribution_r6_m_${suffix}`;
  const runtimeRole = `distribution_r6_r_${suffix}`;
  const ctx = {
    userId: `analytics-operator-${suffix}@example.test`,
    isTest: true,
    roles: ["SUPER_ADMIN", "CONTENT_APPROVER"],
  };
  const viewer = {
    userId: `analytics-reader-${suffix}@example.test`,
    isTest: true,
    roles: ["TECH_SUPER_ADMIN"],
  };
  const author = {
    userId: `analytics-campaign-author-${suffix}@example.test`,
    isTest: true,
    roles: ["TECH_SUPER_ADMIN"],
  };
  const creator = {
    userId: `analytics-content-author-${suffix}@example.test`,
    isTest: true,
    roles: ["CONTENT_COORDINATOR"],
  };
  let admin: Pool;
  let migration: Pool;
  let runtime: Pool;
  let repo: ReturnType<typeof createDistributionAnalyticsRepository>;
  let outreach: ReturnType<typeof createDistributionOutreachRepository>;
  let now: number;
  const policyRequest = {
    requestId: randomUUID(),
    retentionDays: 7,
    approvalReference: randomUUID(),
  };
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const draft = () => ({
    name: `Synthetic analytics ${randomUUID()}`,
    program: "Meditation",
    goal: "Invite practice",
    outcomes: ["PRACTICE_COMPLETED" as const],
    startsAt: at(-1440),
    endsAt: at(1440),
    budgetMicros: 0,
  });
  beforeAll(async () => {
    const base = new URL(process.env.DISTRIBUTION_TEST_ADMIN_URL ?? "");
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      !base.pathname.startsWith("/content_studio_separation_test_")
    )
      throw new Error("LOCAL_DATABASE_REQUIRED");
    admin = new Pool({ connectionString: base.toString() });
    const mp = randomUUID();
    const rp = randomUUID();
    await admin.query(
      `CREATE ROLE ${migrateRole} LOGIN PASSWORD '${mp}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await admin.query(
      `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${rp}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await admin.query(`CREATE DATABASE ${database} OWNER ${migrateRole}`);
    const url = new URL(base);
    url.pathname = `/${database}`;
    url.username = migrateRole;
    url.password = mp;
    migration = new Pool({ connectionString: url.toString() });
    await migrate(drizzle(migration), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      migrationsSchema: "distribution_migrations",
      migrationsTable: "__distribution_migrations",
    });
    await migration.query(
      (await readFile(new URL("../ops/runtime-grants.sql", import.meta.url), "utf8")).replaceAll(
        ":'distribution_runtime_role'",
        `'${runtimeRole}'`,
      ),
    );
    url.username = runtimeRole;
    url.password = rp;
    runtime = new Pool({ connectionString: url.toString(), max: 6 });
    repo = createDistributionAnalyticsRepository(runtime);
    outreach = createDistributionOutreachRepository(runtime);
    now = new Date(
      (await migration.query("SELECT clock_timestamp() AS now")).rows[0].now,
    ).getTime();
    for (const world of [true, false]) {
      await provisionDistributionCapabilities(
        migration,
        ctx.userId,
        world,
        ["operations.manage", "analytics.view", "campaigns.manage"],
        "isolated-test",
      );
      await provisionDistributionCapabilities(
        migration,
        author.userId,
        world,
        ["campaigns.manage"],
        "isolated-test",
      );
      await provisionDistributionCapabilities(
        migration,
        viewer.userId,
        world,
        ["analytics.view"],
        "isolated-test",
      );
    }
    await repo.approvePolicy(ctx, policyRequest);
  }, 30_000);
  afterAll(async () => {
    await runtime?.end();
    await migration?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
      await admin.query(`DROP ROLE IF EXISTS ${migrateRole}`);
      await admin.end();
    }
  });
  async function campaign(approve = true) {
    const created = await outreach.createCampaign(author, draft());
    return approve ? outreach.approveCampaign(ctx, created.id, { expectedRevision: 1 }) : created;
  }
  function event(
    campaignId: string,
    name: AnalyticsEvent["name"] = "tracked_link.opened",
    person = 1,
    minutes = -90,
    participationId: string | null = null,
  ): AnalyticsEvent {
    return {
      version: 1,
      id: randomUUID(),
      name,
      occurredAt: at(minutes),
      correlationId: randomUUID(),
      actorKey: person.toString(16).padStart(64, "0"),
      campaignId,
      activationId: null,
      contentId: null,
      ctaId: null,
      consentBasis: "explicit_consent",
      consentReceipt: randomUUID(),
      source: "operator_fixture",
      sourceEventId: randomUUID(),
      participationId,
    };
  }
  const window = (campaignId: string) => ({
    campaignId,
    windowStart: at(-120),
    windowEnd: at(-30),
  });
  it("deduplicates concurrent batches and refuses changed replay payloads or source IDs", async () => {
    const c = await campaign();
    const e = event(c.id);
    const results = await Promise.all([repo.ingest(ctx, [e]), repo.ingest(ctx, [e])]);
    expect(results.map((r) => r.inserted).sort()).toEqual([0, 1]);
    expect(results.map((r) => r.duplicates).sort()).toEqual([0, 1]);
    await expect(repo.ingest(ctx, [{ ...e, actorKey: "a".repeat(64) }])).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
    await expect(repo.ingest(ctx, [{ ...e, id: randomUUID() }])).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
    expect(
      (
        await runtime.query(
          "SELECT count(*)::int AS n FROM distribution.analytics_event WHERE campaign_id=$1",
          [c.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("rejects missing consent evidence, unknown private text and unadopted producers atomically", async () => {
    const c = await campaign();
    const e = event(c.id);
    await expect(repo.ingest(ctx, [e, { ...event(c.id), consentReceipt: "" }])).rejects.toThrow(
      "INVALID_ANALYTICS_EVENT",
    );
    await expect(
      repo.ingest(ctx, [{ ...e, messageText: "private fixture" } as AnalyticsEvent]),
    ).rejects.toThrow("INVALID_ANALYTICS_EVENT");
    await expect(repo.ingest(ctx, [{ ...e, source: "canonical_core" }])).rejects.toThrow(
      "ANALYTICS_PRODUCER_NOT_ADOPTED",
    );
    expect(
      (
        await runtime.query(
          "SELECT count(*)::int AS n FROM distribution.analytics_receipt WHERE id=$1",
          [e.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("uses an approved immutable campaign definition and ignores later unapproved edits", async () => {
    const c = await campaign(false);
    await expect(repo.ingest(ctx, [event(c.id)])).rejects.toThrow(
      "ANALYTICS_CAMPAIGN_DEFINITION_REQUIRED",
    );
    await outreach.approveCampaign(ctx, c.id, { expectedRevision: 1 });
    await outreach.updateCampaign(author, c.id, { ...draft(), expectedRevision: 2 });
    expect((await repo.ingest(ctx, [event(c.id)])).inserted).toBe(1);
    const dashboard = await repo.dashboard(viewer);
    expect(dashboard.campaigns.find((row) => row.id === c.id)?.name).toBe(c.name);
  });
  it("reconciles late voids, reports staleness, and returns exact snapshot retries", async () => {
    const c = await campaign();
    const entries: AnalyticsEvent[] = [];
    for (let actor = 1; actor <= 10; actor++) {
      const participation = randomUUID();
      entries.push(
        event(c.id, "practice.started", actor, -100, participation),
        event(c.id, "practice.completed", actor, -90, participation),
      );
    }
    await repo.ingest(ctx, entries);
    const first = await repo.reconcile(ctx, window(c.id));
    expect(first.metrics.find((m) => m.key === "practice_completion")?.rate).toBe(1);
    expect(await repo.reconcile(ctx, window(c.id))).toEqual(first);
    const voids = entries
      .filter((e) => e.name === "practice.completed")
      .map((e) =>
        event(c.id, "practice.voided", Number.parseInt(e.actorKey, 16), -10, e.participationId),
      );
    await repo.ingest(ctx, voids);
    expect(
      (await repo.dashboard(viewer)).snapshots.find((row) => row.campaign_id === c.id)?.stale,
    ).toBe(true);
    const second = await repo.reconcile(ctx, window(c.id));
    expect(second.metrics.find((m) => m.key === "practice_completion")?.rate).toBe(0);
    const dashboard = await repo.dashboard(viewer);
    const snapshot = dashboard.snapshots.find((row) => row.campaign_id === c.id);
    expect(snapshot?.stale).toBe(false);
    expect(snapshot?.report).not.toHaveProperty("sourceEvents");
    expect(snapshot?.report).not.toHaveProperty("unmatchedCompletions");
    expect(snapshot?.report).not.toHaveProperty("actorKey");
  });
  it("builds recent windows and dashboard timestamps from the database clock", async () => {
    const c = await campaign();
    await repo.ingest(ctx, [event(c.id)]);
    const before = new Date(
      (await migration.query("SELECT clock_timestamp() AS now")).rows[0].now,
    ).getTime();
    const recent = await repo.reconcile(ctx, { campaignId: c.id, days: 7 });
    const dashboard = await repo.dashboard(viewer);
    const after = new Date(
      (await migration.query("SELECT clock_timestamp() AS now")).rows[0].now,
    ).getTime();
    expect(Date.parse(recent.windowEnd)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(recent.windowEnd)).toBeLessThanOrEqual(after);
    expect(Date.parse(recent.windowEnd) - Date.parse(recent.windowStart)).toBe(7 * 86400000);
    expect(recent.generatedAt).toBe(recent.windowEnd);
    expect(Date.parse(dashboard.asOf)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(dashboard.asOf)).toBeLessThanOrEqual(after);
    for (const days of [0, 1.5, 8, 32]) {
      await expect(repo.reconcile(ctx, { campaignId: c.id, days })).rejects.toThrow(
        "INVALID_ANALYTICS_WINDOW",
      );
    }
    expect((await repo.reconcile(ctx, window(c.id))).windowStart).toBe(window(c.id).windowStart);
  });
  it("hides small distinct-actor cohorts even when event counts exceed ten", async () => {
    const c = await campaign();
    const entries: AnalyticsEvent[] = [];
    for (let n = 0; n < 20; n++) {
      const participation = randomUUID();
      entries.push(
        event(c.id, "practice.started", 1, -100, participation),
        event(c.id, "practice.completed", 1, -90, participation),
      );
    }
    await repo.ingest(ctx, entries);
    await repo.reconcile(ctx, window(c.id));
    const report = (await repo.dashboard(viewer)).snapshots.find(
      (row) => row.campaign_id === c.id,
    )?.report;
    expect(report?.metrics.find((m) => m.key === "practice_completion")).toMatchObject({
      status: "suppressed",
      numerator: null,
      denominator: null,
    });
    expect(report).not.toHaveProperty("sourceEvents");
    expect(report).not.toHaveProperty("unmatchedCompletions");
  });
  it("checks optional lineage against one actual activation in its campaign and world", async () => {
    const c = await campaign();
    const other = await campaign();
    const content = createDistributionRepository(runtime);
    const master = await content.create(creator, {
      title: "Synthetic lineage fixture",
      language: "en",
      category: "other",
      asset: {
        storageKey: `distribution/masters/${randomUUID()}`,
        sha256: "a".repeat(64),
        byteSize: 10,
        mimeType: "video/mp4",
        originalName: "synthetic.mp4",
      },
    });
    const cta = await outreach.createCta(author, {
      intent: "PRACTICE",
      copy: "Synthetic practice",
      language: "en",
      destination: { path: "/practice/test", requiresIdentity: true },
      fallback: { path: "/practice/synthetic-fallback", requiresIdentity: true },
    });
    // Fixture-only immutable lineage, without running an encoder or publishing a link.
    const job = randomUUID();
    const artifact = randomUUID();
    const activation = randomUUID();
    const hash = randomBytes(32).toString("hex");
    await migration.query(
      "INSERT INTO distribution.render_job(id,is_test,master_id,source_version_id,recipe_sha256,recipe,requested_by) VALUES($1,true,$2,$3,$4,'{}',$5)",
      [job, master.id, master.currentVersion.id, hash, ctx.userId],
    );
    await migration.query(
      "INSERT INTO distribution.render_artifact(id,job_id,is_test,recipe_sha256,asset_sha256,output) VALUES($1,$2,true,$3,$3,'{}')",
      [artifact, job, hash],
    );
    await migration.query(
      "INSERT INTO distribution.activation(id,is_test,master_id,campaign_id,cta_id,artifact_id,token,created_by) VALUES($1,true,$2,$3,$4,$5,$6,$7)",
      [
        activation,
        master.id,
        c.id,
        cta.id,
        artifact,
        randomBytes(32).toString("base64url"),
        ctx.userId,
      ],
    );
    const linked = {
      ...event(c.id),
      activationId: activation,
      contentId: master.id,
      ctaId: cta.id,
    };
    expect((await repo.ingest(ctx, [linked])).inserted).toBe(1);
    await expect(
      repo.ingest(ctx, [{ ...event(c.id), activationId: activation, contentId: randomUUID() }]),
    ).rejects.toThrow("INVALID_ANALYTICS_LINEAGE");
    await expect(
      repo.ingest(ctx, [{ ...event(other.id), activationId: activation }]),
    ).rejects.toThrow("INVALID_ANALYTICS_LINEAGE");
    expect(
      (await repo.ingest(ctx, [{ ...event(c.id), contentId: master.id, ctaId: cta.id }])).inserted,
    ).toBe(1);
  });
  it("enforces provider timestamp bounds, governed metadata and exact retries", async () => {
    const c = await campaign();
    const input = {
      id: randomUUID(),
      campaignId: c.id,
      provider: "manual_fixture" as const,
      metric: "views" as const,
      value: 40,
      currency: null,
      definitionVersion: 1 as const,
      observedAt: at(-10),
    };
    await repo.providerSnapshot(ctx, input);
    await repo.providerSnapshot(ctx, input);
    await expect(repo.providerSnapshot(ctx, { ...input, value: 41 })).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
    await expect(
      repo.providerSnapshot(ctx, { ...input, id: randomUUID(), observedAt: at(6) }),
    ).rejects.toThrow("INVALID_PROVIDER_METRIC");
    await expect(
      repo.providerSnapshot(ctx, { ...input, id: randomUUID(), observedAt: at(-8 * 1440) }),
    ).rejects.toThrow("INVALID_PROVIDER_METRIC");
    await expect(
      repo.providerSnapshot(ctx, { ...input, id: randomUUID(), provider: "youtube" }),
    ).rejects.toThrow("ANALYTICS_PRODUCER_NOT_ADOPTED");
  });
  it("isolates permissions and worlds without enabling production collection", async () => {
    const c = await campaign();
    await expect(repo.ingest(viewer, [event(c.id)])).rejects.toThrow("FORBIDDEN");
    await expect(repo.ingest({ ...ctx, roles: [] }, [event(c.id)])).rejects.toThrow("FORBIDDEN");
    await expect(repo.dashboard({ ...viewer, roles: ["CONTENT_COORDINATOR"] })).rejects.toThrow(
      "FORBIDDEN",
    );
    await expect(repo.dashboard({ ...viewer, userId: "unapproved@example.test" })).rejects.toThrow(
      "FORBIDDEN",
    );
    await expect(repo.ingest({ ...ctx, isTest: false }, [event(c.id)])).rejects.toThrow(
      "TEST_WORLD_REQUIRED",
    );
    await expect(repo.reconcile({ ...ctx, isTest: false }, window(c.id))).rejects.toThrow(
      "TEST_WORLD_REQUIRED",
    );
    const other = await repo.dashboard({ ...viewer, isTest: false });
    expect(other.campaigns).toEqual([]);
    expect(other.snapshots).toEqual([]);
    expect(other.productionCollectionEnabled).toBe(false);
  });
  it("uses the actual seven-day policy and refuses edits to raw rows and dedupe receipts", async () => {
    const c = await campaign();
    const e = event(c.id);
    await repo.ingest(ctx, [e]);
    await expect(
      runtime.query("UPDATE distribution.analytics_event SET event='{}' WHERE id=$1", [e.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtime.query("DELETE FROM distribution.analytics_event WHERE id=$1", [e.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtime.query(
        "UPDATE distribution.analytics_receipt SET fingerprint='different' WHERE id=$1",
        [e.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtime.query("DELETE FROM distribution.analytics_receipt WHERE id=$1", [e.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      repo.ingest(ctx, [event(c.id, "tracked_link.opened", 1, -8 * 1440)]),
    ).rejects.toThrow("ANALYTICS_RETENTION_WINDOW");
    const old = event(c.id, "tracked_link.opened", 2, -8 * 1440);
    await migration.query(
      "INSERT INTO distribution.analytics_event(id,is_test,campaign_id,occurred_at,received_at,event) VALUES($1,true,$2,$3,$3,$4)",
      [old.id, c.id, old.occurredAt, old],
    );
    expect((await repo.dashboard(viewer)).health.retention_alerts).toBe(1);
    await repo.approvePolicy(ctx, policyRequest);
    await expect(repo.approvePolicy(ctx, { ...policyRequest, retentionDays: 30 })).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
  });
});

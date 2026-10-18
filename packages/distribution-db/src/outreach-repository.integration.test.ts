import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDistributionOutreachRepository } from "./outreach-repository";
import { provisionDistributionCapabilities } from "./repository";
const suite = process.env.DISTRIBUTION_RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("DS-DIST-R4 local campaign and CTA authoring", () => {
  let admin: Pool;
  let migration: Pool;
  let runtime: Pool;
  let second: Pool;
  let repo: ReturnType<typeof createDistributionOutreachRepository>;
  let worker2: ReturnType<typeof createDistributionOutreachRepository>;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `distribution_r4_${suffix}`;
  const migrateRole = `distribution_r4_m_${suffix}`;
  const runtimeRole = `distribution_r4_r_${suffix}`;
  const ctx = {
    userId: "outreach-reviewer@example.test",
    isTest: true,
    roles: ["SUPER_ADMIN", "CONTENT_APPROVER"],
  };
  const author = {
    userId: "outreach-author@example.test",
    isTest: true,
    roles: ["TECH_SUPER_ADMIN", "CONTENT_APPROVER"],
  };
  const ops = { userId: "outreach-ops@example.test", isTest: true, roles: ["TECH_SUPER_ADMIN"] };
  const draft = () => ({
    name: `Local campaign ${randomUUID()}`,
    program: "Meditation",
    goal: "Invite practice",
    outcomes: ["PRACTICE_COMPLETED" as const],
    startsAt: "2026-09-29T00:00:00Z",
    endsAt: "2026-10-30T00:00:00Z",
    budgetMicros: 0,
  });
  const cta = () => ({
    intent: "MEDITATE" as const,
    copy: "Begin a meditation",
    language: "en",
    destination: { path: "/practice/flute-meditation", requiresIdentity: true },
    fallback: { path: "/practice/koti-parayana", requiresIdentity: true },
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
    runtime = new Pool({ connectionString: url.toString(), max: 4 });
    second = new Pool({ connectionString: url.toString(), max: 4 });
    repo = createDistributionOutreachRepository(runtime);
    worker2 = createDistributionOutreachRepository(second);
    for (const world of [true, false]) {
      await provisionDistributionCapabilities(
        migration,
        ctx.userId,
        world,
        ["campaigns.manage"],
        "local-test",
      );
      await provisionDistributionCapabilities(
        migration,
        ops.userId,
        world,
        ["operations.manage"],
        "local-test",
      );
      await provisionDistributionCapabilities(
        migration,
        author.userId,
        world,
        ["campaigns.manage"],
        "local-test",
      );
    }
  }, 20000);
  afterAll(async () => {
    await second?.end();
    await runtime?.end();
    await migration?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}; DROP ROLE IF EXISTS ${migrateRole}`);
      await admin.end();
    }
  });

  it("DS-DIST-R4-CAMPAIGN stores immutable revisions, exact human approval and invalidates edits", async () => {
    const first = await repo.createCampaign(author, draft());
    expect(first.kind).toBe("OUTREACH");
    expect(first.status).toBe("DRAFT");
    expect(first.approval).toBeNull();
    const approved = await repo.approveCampaign(ctx, first.id, { expectedRevision: 1 });
    expect(approved.status).toBe("APPROVED");
    expect(approved.approval?.reviewerId).toBe(ctx.userId);
    expect(approved.approval?.revision).toBe(2);
    const edited = await repo.updateCampaign(author, first.id, { ...draft(), expectedRevision: 2 });
    expect(edited.status).toBe("DRAFT");
    expect(edited.approval).toBeNull();
    expect((await repo.campaignHistory(ctx, first.id)).map((item) => item.revision)).toEqual([
      3, 2, 1,
    ]);
    await expect(
      runtime.query(
        "UPDATE distribution.outreach_campaign_revision SET snapshot='{}' WHERE campaign_id=$1",
        [first.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtime.query("DELETE FROM distribution.outreach_campaign_revision WHERE campaign_id=$1", [
        first.id,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
  it("DS-DIST-R4-CAMPAIGN keeps worlds isolated on every read and write", async () => {
    const first = await repo.createCampaign(author, draft());
    const button = await repo.createCta(author, cta());
    const other = { ...ctx, isTest: false };
    expect(await repo.listCampaigns(other)).toEqual([]);
    expect(await repo.listCtas(other)).toEqual([]);
    await expect(repo.getCampaign(other, first.id)).rejects.toThrow("NOT_FOUND");
    await expect(repo.campaignHistory(other, first.id)).rejects.toThrow("NOT_FOUND");
    await expect(repo.approveCampaign(other, first.id, { expectedRevision: 1 })).rejects.toThrow(
      "NOT_FOUND",
    );
    await expect(repo.getCta(other, button.id)).rejects.toThrow("NOT_FOUND");
    await expect(repo.ctaHistory(other, button.id)).rejects.toThrow("NOT_FOUND");
    await expect(
      repo.updateCta(other, button.id, { ...cta(), expectedRevision: 1 }),
    ).rejects.toThrow("NOT_FOUND");
  });
  it("DS-DIST-R4-CAMPAIGN requires current administrator authority, independent review and current ancillary grants", async () => {
    const first = await repo.createCampaign(author, draft());
    const button = await repo.createCta(author, cta());
    await expect(repo.approveCampaign(author, first.id, { expectedRevision: 1 })).rejects.toThrow(
      "INDEPENDENT_REVIEW_REQUIRED",
    );
    await expect(repo.approveCta(author, button.id, { expectedRevision: 1 })).rejects.toThrow(
      "INDEPENDENT_REVIEW_REQUIRED",
    );
    await expect(
      repo.approveCampaign({ ...ctx, roles: [] }, first.id, { expectedRevision: 1 }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      repo.approveCta({ ...ctx, roles: ["CONTENT_COORDINATOR"] }, button.id, {
        expectedRevision: 1,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      repo.createCampaign({ ...author, roles: ["CONTENT_COORDINATOR"] }, draft()),
    ).rejects.toThrow("FORBIDDEN");
    await expect(repo.createCampaign(ops, draft())).rejects.toThrow("FORBIDDEN");
    const denied = { userId: randomUUID(), isTest: true, roles: [] };
    await expect(repo.listCampaigns(denied)).rejects.toThrow("FORBIDDEN");
    await expect(repo.listCtas(denied)).rejects.toThrow("FORBIDDEN");
    const temporary = { userId: randomUUID(), isTest: true, roles: ["SUPER_ADMIN"] };
    await provisionDistributionCapabilities(
      migration,
      temporary.userId,
      true,
      ["campaigns.manage"],
      "local-test",
    );
    const own = await repo.createCampaign(temporary, draft());
    await provisionDistributionCapabilities(migration, temporary.userId, true, [], "local-test");
    await expect(
      repo.updateCampaign(temporary, own.id, { ...draft(), expectedRevision: 1 }),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("DS-DIST-R4-CAMPAIGN serializes overlapping edits and approvals across workers", async () => {
    const first = await repo.createCampaign(author, draft());
    const results = await Promise.allSettled([
      repo.approveCampaign(ctx, first.id, { expectedRevision: 1 }),
      worker2.updateCampaign(author, first.id, { ...draft(), expectedRevision: 1 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === "rejected")
        .map((result) => (result as PromiseRejectedResult).reason.message),
    ).toEqual(["REVISION_CONFLICT"]);
    expect((await repo.getCampaign(ctx, first.id)).revision).toBe(2);
    const button = await repo.createCta(author, cta());
    const ctas = await Promise.allSettled([
      repo.approveCta(ctx, button.id, { expectedRevision: 1 }),
      worker2.updateCta(author, button.id, {
        ...cta(),
        copy: "Another invitation",
        expectedRevision: 1,
      }),
    ]);
    expect(ctas.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await repo.getCta(ctx, button.id)).revision).toBe(2);
  });
  it("DS-DIST-R4-STOP operations can pause and stop, and stopped campaigns cannot resurrect", async () => {
    const first = await repo.createCampaign(author, draft());
    const approved = await repo.approveCampaign(ctx, first.id, { expectedRevision: 1 });
    const paused = await repo.pauseCampaign(ops, first.id, { expectedRevision: approved.revision });
    expect(paused.status).toBe("PAUSED");
    expect(paused.approval).toBeNull();
    const stopped = await repo.stopCampaign(ops, first.id, { expectedRevision: paused.revision });
    expect(stopped.status).toBe("STOPPED");
    await expect(
      repo.updateCampaign(author, first.id, { ...draft(), expectedRevision: stopped.revision }),
    ).rejects.toThrow("CAMPAIGN_STOPPED");
    await expect(
      repo.approveCampaign(ctx, first.id, { expectedRevision: stopped.revision }),
    ).rejects.toThrow();
    await expect(
      repo.stopCampaign(ops, first.id, { expectedRevision: paused.revision }),
    ).rejects.toThrow("REVISION_CONFLICT");
  });
  it("DS-DIST-R4-DESTINATION protects exact destinations and explicit fallback revisions", async () => {
    const first = await repo.createCta(author, cta());
    const approved = await repo.approveCta(ctx, first.id, { expectedRevision: 1 });
    expect(approved.approval?.revision).toBe(2);
    const edited = await repo.updateCta(author, first.id, {
      ...cta(),
      expectedRevision: 2,
      copy: "Listen with devotion",
    });
    expect(edited.approval).toBeNull();
    expect((await repo.ctaHistory(ctx, first.id)).map((item) => item.revision)).toEqual([3, 2, 1]);
    for (const path of [
      "/",
      "/home",
      "//evil.example",
      "/practice/../../admin",
      "https://evil.example/path",
    ])
      await expect(
        repo.createCta(author, { ...cta(), fallback: { path, requiresIdentity: false } }),
      ).rejects.toThrow();
    await expect(repo.createCta(author, { ...cta(), fallback: cta().destination })).rejects.toThrow(
      "INVALID_CTA",
    );
    const approvedOrigin = createDistributionOutreachRepository(runtime, {
      allowedOrigins: ["https://dattapeetham.org"],
    });
    const external = await approvedOrigin.createCta(author, {
      ...cta(),
      destination: { path: "https://dattapeetham.org/pujas", requiresIdentity: false },
    });
    expect(external.destination.path).toBe("https://dattapeetham.org/pujas");
    await expect(
      approvedOrigin.createCta(author, {
        ...cta(),
        destination: {
          path: "https://dattapeetham.org/pujas?next=https://evil.example",
          requiresIdentity: false,
        },
      }),
    ).rejects.toThrow("UNSAFE_DESTINATION");
    await expect(
      runtime.query("UPDATE distribution.cta_revision SET snapshot='{}' WHERE cta_id=$1", [
        first.id,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});

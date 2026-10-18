import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLiveCurationRepository } from "./live-repository";
import { createIntelligentContentRepository } from "./studio-repository";
const suite = process.env.DISTRIBUTION_RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("live curation on isolated local PostgreSQL", () => {
  let admin: Pool;
  let migration: Pool;
  let runtime: Pool;
  let live: ReturnType<typeof createLiveCurationRepository>;
  let studio: ReturnType<typeof createIntelligentContentRepository>;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `distribution_live_${suffix}`;
  const migrateRole = `dist_live_m_${suffix}`;
  const runtimeRole = `dist_live_r_${suffix}`;
  const roles = new Map<string, readonly string[]>();
  const authority = async (input: {
    userId: string;
    isTest: boolean;
    capability: "content.create" | "content.review" | "content.publish";
  }) =>
    (roles.get(`${input.isTest}:${input.userId}`) ?? []).includes(
      input.capability === "content.create" ? "CONTENT_COORDINATOR" : "CONTENT_APPROVER",
    );
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
    runtime = new Pool({ connectionString: url.toString(), max: 8 });
    live = createLiveCurationRepository(runtime, authority);
    studio = createIntelligentContentRepository(runtime, { authorize: authority });
  }, 20000);
  afterAll(async () => {
    await runtime?.end();
    await migration?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}; DROP ROLE IF EXISTS ${migrateRole}`);
      await admin.end();
    }
  });

  const ctx = { userId: randomUUID(), isTest: true, roles: ["CONTENT_COORDINATOR"] };
  const channel = { channelId: `UC${"a".repeat(22)}`, name: "Fixture live channel", enabled: true };
  const settings = {
    channelId: channel.channelId,
    channelName: channel.name,
    enabled: true,
    language: "te",
    rights: {
      owner: "Synthetic owner",
      authorizationBasis: "Synthetic future broadcast fixture permission",
      channels: ["youtube" as const],
      territories: ["WORLDWIDE"],
      privacyClass: "PUBLIC" as const,
      releaseAt: null,
      expiresAt: null,
    },
  };
  it("requires a live worker heartbeat and isolates it by world", async () => {
    expect(await live.ready(true)).toBe(false);
    await live.heartbeat(true);
    expect(await live.ready(true)).toBe(true);
    expect(await live.ready(false)).toBe(false);
    await migration.query(
      "UPDATE distribution.module_state SET updated_at=now()-interval '2 minutes' WHERE id=$1",
      ["live-curation-worker:true"],
    );
    expect(await live.ready(true)).toBe(false);
  });
  it("persists capture cursors and queues each overlapping section exactly once without approval/publication", async () => {
    roles.set(`true:${ctx.userId}`, ctx.roles);
    await expect(
      live.configure(
        { ...ctx, roles: ["CONTENT_APPROVER"] },
        { settings, expectedRevision: null },
        [channel],
      ),
    ).rejects.toThrow();
    const monitor = await live.configure(ctx, { settings, expectedRevision: null }, [channel]);
    await expect(
      live.configure(ctx, { settings, expectedRevision: null }, [channel]),
    ).rejects.toThrow("REVISION_CONFLICT");
    const claim = await live.claim(true);
    if (!claim) throw Error("missing claim");
    expect(await live.claim(true)).toBeNull();
    expect(await live.claim(false)).toBeNull();
    const broadcast = await live.begin(claim, {
      id: "abcdefghijk",
      title: "Synthetic live teaching",
      capturedFrom: null,
    });
    expect(
      (
        await live.begin(claim, {
          id: "abcdefghijk",
          title: "Repeated metadata",
          capturedFrom: null,
        })
      ).id,
    ).toBe(broadcast.id);
    const fragments = Array.from({ length: 300 }, (_, i) => ({
      sequence: 100 + i,
      durationMs: 2000,
      sha256: "a".repeat(64),
      byteSize: 188,
      key: `distribution/live/${broadcast.id}/${100 + i}.ts`,
    }));
    await live.append(claim, broadcast.id, fragments, "2026-10-14T12:00:00.000Z");
    await expect(
      live.append(
        claim,
        broadcast.id,
        [
          fragments[0] ??
            (() => {
              throw Error("missing fragment");
            })(),
        ],
        null,
      ),
    ).rejects.toThrow("LIVE_CAPTURE_GAP");
    await live.release(claim);
    const restarted = createLiveCurationRepository(runtime, authority);
    await migration.query("UPDATE distribution.live_monitor SET available_at=now() WHERE id=$1", [
      monitor.id,
    ]);
    const resumed = await restarted.claim(true);
    if (!resumed) throw Error("missing resumed claim");
    const active = await restarted.active(resumed);
    expect(active?.state.nextSequence).toBe(400);
    const asset = () => ({
      storageKey: `distribution/masters/${randomUUID()}`,
      sha256: randomUUID().replaceAll("-", "").repeat(2),
      byteSize: 100,
      mimeType: "video/mp4",
      originalName: "live-fixture.mp4",
    });
    const saved = await restarted.saveWindow(resumed, broadcast.id, {
      asset: asset(),
      ended: false,
      expectedNumber: 0,
    });
    expect(saved.consumed).toHaveLength(210);
    expect(saved.broadcast.state.buffers).toHaveLength(90);
    expect(saved.broadcast.state.offsetMs).toBe(420000);
    await expect(
      restarted.saveWindow(resumed, broadcast.id, {
        asset: asset(),
        ended: false,
        expectedNumber: 0,
      }),
    ).rejects.toThrow("LIVE_LEASE_LOST");
    expect(await studio.queueLiveWindow(true)).toBe(true);
    expect(await studio.queueLiveWindow(true)).toBe(false);
    expect(await studio.queueLiveWindow(false)).toBe(false);
    const listing = await live.list(ctx);
    const window = listing.broadcasts[0]?.windows[0];
    expect(window?.packageId).toBeTruthy();
    const pkg = (
      await runtime.query(
        "SELECT snapshot FROM distribution.studio_revision WHERE package_id=$1 ORDER BY revision DESC LIMIT 1",
        [window?.packageId],
      )
    ).rows[0].snapshot;
    expect(pkg.status).toBe("QUEUED");
    expect(pkg.approval).toBeNull();
    expect(pkg.outputs).toEqual([]);
    expect(pkg.source.liveWindow).toMatchObject({ broadcastId: broadcast.id, ownedEndMs: 420000 });
    expect(pkg.request).toMatchObject({
      channels: ["youtube"],
      languages: ["en"],
      captions: true,
      allCompleteMessages: true,
    });
    expect(
      (await runtime.query("SELECT count(*)::int n FROM distribution.studio_publication_attempt"))
        .rows[0].n,
    ).toBe(0);
    const final = await live.saveWindow(resumed, broadcast.id, {
      asset: asset(),
      ended: true,
      expectedNumber: 1,
    });
    expect(final.broadcast.state.buffers).toHaveLength(0);
    await live.end(resumed, broadcast.id);
    await live.configure(
      ctx,
      { settings: { ...settings, enabled: false }, expectedRevision: monitor.revision },
      [],
    );
    await expect(live.renew(resumed)).rejects.toThrow("LIVE_LEASE_LOST");
    await live.release(resumed, "LIVE_CAPTURE_UNAVAILABLE", broadcast.id);
    expect((await live.list(ctx)).monitors[0]?.enabled).toBe(false);
    expect(await studio.queueLiveWindow(true)).toBe(false);
    expect((await live.list({ ...ctx, isTest: false })).broadcasts).toEqual([]);
  });
  it("rechecks current curator authority and refuses expired permissions", async () => {
    const prior = (await live.list(ctx)).monitors[0];
    if (!prior) throw Error("missing monitor");
    await expect(
      live.configure(
        ctx,
        {
          settings: {
            ...settings,
            rights: { ...settings.rights, expiresAt: "2020-01-01T00:00:00Z" },
          },
          expectedRevision: prior.revision,
        },
        [channel],
      ),
    ).rejects.toThrow("LIVE_CURATION_RIGHTS_REQUIRED");
    await live.configure(ctx, { settings, expectedRevision: prior.revision }, [channel]);
    const claim = await live.claim(true);
    if (!claim) throw Error("missing claim");
    roles.set(`true:${ctx.userId}`, []);
    await expect(live.renew(claim)).rejects.toThrow("REQUESTER_ROLE_REVOKED");
  });
});

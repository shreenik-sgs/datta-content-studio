import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOnlineImportRepository } from "./online-import-repository";
import { createDistributionRepository } from "./repository";
import { createStorageCleanupRepository } from "./storage-cleanup";
const suite = process.env.DISTRIBUTION_RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("storage cleanup on isolated local PostgreSQL", () => {
  let admin: Pool;
  let migration: Pool;
  let runtime: Pool;
  let live: ReturnType<typeof createStorageCleanupRepository>;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `distribution_cleanup_${suffix}`;
  const migrateRole = `dist_cleanup_m_${suffix}`;
  const runtimeRole = `dist_cleanup_r_${suffix}`;
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
    live = createStorageCleanupRepository(runtime, authority);
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

  async function fixture(status = "DRAFT") {
    const ctx = {
      userId: `cleanup-${randomUUID()}@example.test`,
      isTest: true,
      roles: ["CONTENT_COORDINATOR"],
    };
    roles.set(`true:${ctx.userId}`, ctx.roles);
    const content = createDistributionRepository(runtime, { authorize: authority });
    const asset = {
      storageKey: `distribution/masters/${randomUUID()}`,
      sha256: randomUUID().replaceAll("-", "").repeat(2),
      byteSize: 128,
      mimeType: "video/mp4",
      originalName: "fixture.mp4",
    };
    const master = await content.create(ctx, {
      title: "Cleanup fixture",
      language: "en",
      category: "other",
      asset,
    });
    const id = randomUUID();
    const output = {
      storageKey: `distribution/studio/${master.id}/${master.currentVersion.id}/${id}/${randomUUID()}/fixture.mp4`,
      sha256: "b".repeat(64),
      byteSize: 256,
      mimeType: "video/mp4",
    };
    await migration.query(
      "INSERT INTO distribution.studio_package(id,is_test,master_id,source_version_id,creation_key,created_by) VALUES($1,true,$2,$3,$4,$5)",
      [
        id,
        master.id,
        master.currentVersion.id,
        randomUUID().replaceAll("-", "").repeat(2),
        ctx.userId,
      ],
    );
    await migration.query(
      "INSERT INTO distribution.studio_revision(package_id,is_test,revision,snapshot,actor_id,action) VALUES($1,true,1,$2,$3,'CREATED')",
      [
        id,
        { id, source: { title: master.title }, status, outputs: [{ asset: output }] },
        ctx.userId,
      ],
    );
    return {
      ctx,
      master,
      id,
      asset,
      output,
      content,
      selection: { kind: "master" as const, id: master.id, mode: "all" as const },
    };
  }
  it("previews exact bytes, tombstones atomically and resumes file deletion without removing audit rows", async () => {
    const f = await fixture();
    const p = await live.preview(f.ctx, f.selection);
    expect(p.blockers).toEqual([]);
    expect(p.bytes).toBe(384);
    expect(p.fileCount).toBe(2);
    await expect(live.request(f.ctx, f.selection, "outdated")).rejects.toThrow("CLEANUP_CHANGED");
    expect((await f.content.get(f.ctx, f.master.id)).id).toBe(f.master.id);
    const job = await live.request(f.ctx, f.selection, p.token);
    await expect(f.content.get(f.ctx, f.master.id)).rejects.toThrow("NOT_FOUND");
    const removed: string[] = [];
    expect(
      await live.processOne(false, async () => {
        throw Error();
      }),
    ).toBe(false);
    while (
      await live.processOne(true, async (file) => {
        removed.push(file.storageKey);
      })
    ) {
      /* drain */
    }
    expect(removed).toEqual(expect.arrayContaining([f.asset.storageKey, f.output.storageKey]));
    expect((await live.list(f.ctx)).find((r) => r.id === job.id)?.status).toBe("COMPLETE");
    expect(
      (
        await migration.query(
          "SELECT count(*)::int n FROM distribution.studio_revision WHERE package_id=$1",
          [f.id],
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(
      runtime.query("UPDATE distribution.content_master SET title='Revive' WHERE id=$1", [
        f.master.id,
      ]),
    ).rejects.toThrow("CONTENT_REMOVED");
    const replacement = await f.content.create(f.ctx, {
      title: "Reupload",
      language: "en",
      category: "other",
      asset: { ...f.asset, storageKey: `distribution/masters/${randomUUID()}` },
    });
    expect(replacement.id).not.toBe(f.master.id);
  });
  it("keeps the master and shared physical output when deleting only one package", async () => {
    const f = await fixture();
    const other = await fixture();
    await migration.query(
      "UPDATE distribution.studio_revision SET snapshot=jsonb_set(snapshot,'{outputs}',$2) WHERE package_id=$1",
      [other.id, JSON.stringify([{ asset: f.output }])],
    );
    const selection = { kind: "package" as const, id: f.id, mode: "generated" as const };
    const p = await live.preview(f.ctx, selection);
    expect(p.masterCount).toBe(0);
    expect(p.bytes).toBe(0);
    expect(p.sharedFileCount).toBe(1);
    await live.request(f.ctx, selection, p.token);
    expect((await f.content.get(f.ctx, f.master.id)).id).toBe(f.master.id);
  });
  it("requires an approver for submitted/approved content and rejects wrong worlds and revoked roles", async () => {
    const f = await fixture("APPROVED");
    expect((await live.preview(f.ctx, f.selection)).blockers.join()).toContain("Content Approver");
    await expect(live.preview({ ...f.ctx, isTest: false }, f.selection)).rejects.toThrow();
    roles.set(`true:${f.ctx.userId}`, []);
    await expect(live.preview(f.ctx, f.selection)).rejects.toThrow("FORBIDDEN");
    roles.set(`true:${f.ctx.userId}`, ["CONTENT_APPROVER"]);
    expect(
      (await live.preview({ ...f.ctx, roles: ["CONTENT_APPROVER"] }, f.selection)).blockers,
    ).toEqual([]);
  });
  it("blocks active jobs and invalidates previews if another package is created", async () => {
    const f = await fixture();
    const p = await live.preview(f.ctx, f.selection);
    await migration.query(
      "INSERT INTO distribution.studio_generation_job(package_id,is_test,package_revision,requested_by,status) VALUES($1,true,1,$2,'RUNNING')",
      [f.id, f.ctx.userId],
    );
    expect((await live.preview(f.ctx, f.selection)).blockers.join()).toContain("active");
    await expect(live.request(f.ctx, f.selection, p.token)).rejects.toThrow("CLEANUP_BLOCKED");
  });
  it("allows playlist deletion/reimport and blocks removal of shared playlist members", async () => {
    const f = await fixture();
    const imports = createOnlineImportRepository(runtime, authority);
    const root = await imports.enqueue(f.ctx, {
      url: "https://www.youtube.com/playlist?list=PLcleanupfixture1",
      includePlaylist: true,
      language: "en",
      category: "other",
    });
    const child = await imports.enqueue(f.ctx, {
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      language: "en",
      category: "other",
    });
    await migration.query(
      "UPDATE distribution.online_import SET status='COMPLETE',child_ids=$2 WHERE id=$1",
      [root.id, JSON.stringify([child.id])],
    );
    await migration.query(
      "UPDATE distribution.online_import SET status='COMPLETE',master_id=$2,parent_id=$3 WHERE id=$1",
      [child.id, f.master.id, root.id],
    );
    await migration.query("UPDATE distribution.online_import SET curation=$2 WHERE id=$1", [
      root.id,
      { items: { [child.id]: { packageId: f.id } }, requestedBy: f.ctx.userId },
    ]);
    const generated = { kind: "playlist" as const, id: root.id, mode: "generated" as const };
    const generatedPreview = await live.preview(f.ctx, generated);
    await live.request(f.ctx, generated, generatedPreview.token);
    let saved = (await imports.list(f.ctx, { rootId: root.id })).find((i) => i.id === root.id);
    expect(saved?.curation?.pausedForCleanup).toBe(true);
    expect(saved?.curation?.items[child.id]?.error).toBe("CONTENT_REMOVED");
    expect((await f.content.get(f.ctx, f.master.id)).id).toBe(f.master.id);
    await imports.retryPlaylist(f.ctx, root.id);
    saved = (await imports.list(f.ctx, { rootId: root.id })).find((i) => i.id === root.id);
    expect(saved?.curation?.pausedForCleanup).toBeUndefined();
    expect(saved?.curation?.items[child.id]).toBeUndefined();
    const selection = { kind: "playlist" as const, id: root.id, mode: "all" as const };
    const p = await live.preview(f.ctx, selection);
    expect(p.masterCount).toBe(1);
    expect(p.blockers).toEqual([]);
    await live.request(f.ctx, selection, p.token);
    expect((await imports.list(f.ctx)).find((i) => i.id === root.id)).toBeUndefined();
    const again = await imports.enqueue(f.ctx, {
      url: root.source.url,
      includePlaylist: true,
      language: "en",
      category: "other",
    });
    expect(again.id).not.toBe(root.id);
  });
  it("does not eagerly return child metadata in playlist overview", async () => {
    const f = await fixture();
    const imports = createOnlineImportRepository(runtime, authority);
    const root = await imports.enqueue(f.ctx, {
      url: "https://www.youtube.com/playlist?list=PLcleanupfixture2",
      includePlaylist: true,
      language: "en",
      category: "other",
    });
    const child = await imports.enqueue(f.ctx, {
      url: "https://www.youtube.com/watch?v=klmnopqrst0",
      language: "en",
      category: "other",
    });
    await migration.query(
      "UPDATE distribution.online_import SET status='COMPLETE',child_ids=$2 WHERE id=$1",
      [root.id, JSON.stringify([child.id])],
    );
    await migration.query("UPDATE distribution.online_import SET parent_id=$2 WHERE id=$1", [
      child.id,
      root.id,
    ]);
    expect((await imports.list(f.ctx, { summaries: true })).some((i) => i.id === child.id)).toBe(
      false,
    );
    expect((await imports.list(f.ctx, { rootId: root.id })).map((i) => i.id)).toEqual(
      expect.arrayContaining([root.id, child.id]),
    );
  });
  it("rejects a stale writer trying to attach erased assets to a different package", async () => {
    const f = await fixture();
    const other = await fixture();
    const p = await live.preview(f.ctx, f.selection);
    await live.request(f.ctx, f.selection, p.token);
    await expect(
      runtime.query(
        "INSERT INTO distribution.studio_revision(package_id,is_test,revision,snapshot,actor_id,action) VALUES($1,true,2,$2,$3,'UPDATED')",
        [other.id, { outputs: [{ asset: f.output }] }, other.ctx.userId],
      ),
    ).rejects.toThrow("CONTENT_REMOVED");
  });

  it("finds every series containing a reused master, excludes deleted membership and isolates TEST", async () => {
    const f = await fixture();
    const imports = createOnlineImportRepository(runtime, authority);
    const child = await imports.enqueue(f.ctx, {
      url: "https://www.youtube.com/watch?v=seriesnav01",
      language: "en",
      category: "other",
    });
    const roots = [];
    for (const list of ["PLseriesnavigation1", "PLseriesnavigation2"]) {
      const root = await imports.enqueue(f.ctx, {
        url: `https://www.youtube.com/playlist?list=${list}`,
        includePlaylist: true,
        language: "en",
        category: "other",
      });
      await migration.query(
        "UPDATE distribution.online_import SET child_ids=$2,title=$3 WHERE id=$1",
        [root.id, JSON.stringify([child.id]), list],
      );
      roots.push(root);
    }
    await migration.query(
      "UPDATE distribution.online_import SET master_id=$2,parent_id=$3 WHERE id=$1",
      [child.id, f.master.id, roots[0]?.id],
    );
    expect((await imports.bundlesForMaster(f.ctx, f.master.id)).map((bundle) => bundle.id)).toEqual(
      expect.arrayContaining(roots.map((root) => root.id)),
    );
    expect(await imports.bundlesForMaster({ ...f.ctx, isTest: false }, f.master.id)).toEqual([]);
    await expect(imports.bundlesForMaster({ ...f.ctx, roles: [] }, f.master.id)).rejects.toThrow();
    await migration.query("UPDATE distribution.online_import SET deleted_at=now() WHERE id=$1", [
      roots[0]?.id,
    ]);
    expect(await imports.bundlesForMaster(f.ctx, f.master.id)).toEqual([
      { id: roots[1]?.id, title: "PLseriesnavigation2", recordings: 1 },
    ]);
    await migration.query("UPDATE distribution.online_import SET deleted_at=now() WHERE id=$1", [
      child.id,
    ]);
    expect(await imports.bundlesForMaster(f.ctx, f.master.id)).toEqual([]);
  });
  it("downloads one initial playlist recording, then at most three ahead of generation after shared setup", async () => {
    await migration.query(
      "UPDATE distribution.online_import SET status='FAILED' WHERE deleted_at IS NULL",
    );
    const f = await fixture();
    const imports = createOnlineImportRepository(runtime, authority);
    const root = await imports.enqueue(f.ctx, {
      url: "https://www.youtube.com/playlist?list=PLboundedfixture",
      includePlaylist: true,
      language: "en",
      category: "other",
    });
    const claim = await imports.claim(true);
    if (!claim) throw Error("Missing playlist claim");
    await imports.expand(
      claim,
      Array.from({ length: 8 }, (_, n) => ({
        provider: "youtube" as const,
        kind: "video" as const,
        id: `bounded000${n}`,
        url: `https://www.youtube.com/watch?v=bounded000${n}`,
      })),
      "Large synthetic bundle",
    );
    const first = await imports.claim(true);
    if (!first) throw Error("Missing first download");
    expect(first.source.id).toBe("bounded0000");
    await imports.complete(first, {
      title: "First",
      asset: {
        ...f.asset,
        storageKey: `distribution/masters/${randomUUID()}`,
        sha256: randomUUID().replaceAll("-", "").repeat(2),
      },
    });
    expect(await imports.claim(true)).toBeNull();
    await migration.query("UPDATE distribution.online_import SET curation=$2 WHERE id=$1", [
      root.id,
      { items: {}, requestedBy: f.ctx.userId },
    ]);
    for (let n = 0; n < 2; n++) {
      const next = await imports.claim(true);
      if (!next) throw Error("Missing buffer download");
      await imports.complete(next, {
        title: "Buffer",
        asset: {
          ...f.asset,
          storageKey: `distribution/masters/${randomUUID()}`,
          sha256: randomUUID().replaceAll("-", "").repeat(2),
        },
      });
    }
    expect(await imports.claim(true)).toBeNull();
    const rows = await imports.list(f.ctx, { rootId: root.id });
    expect(rows.filter((r) => r.source.kind === "video" && r.status === "COMPLETE")).toHaveLength(
      3,
    );
    expect(rows.filter((r) => r.source.kind === "video" && r.status === "QUEUED")).toHaveLength(5);
  });
  it("protects a master reused by a separate online source outside the chosen playlist", async () => {
    const f = await fixture();
    const imports = createOnlineImportRepository(runtime, authority);
    const root = await imports.enqueue(f.ctx, {
      url: "https://www.youtube.com/playlist?list=PLsharedfixture",
      includePlaylist: true,
      language: "en",
      category: "other",
    });
    const one = await imports.enqueue(f.ctx, {
      url: "https://www.youtube.com/watch?v=shared00001",
      language: "en",
      category: "other",
    });
    const two = await imports.enqueue(f.ctx, {
      url: "https://www.youtube.com/watch?v=shared00002",
      language: "en",
      category: "other",
    });
    await migration.query(
      "UPDATE distribution.online_import SET status='COMPLETE',master_id=$2 WHERE id=ANY($1::uuid[])",
      [[one.id, two.id], f.master.id],
    );
    await migration.query(
      "UPDATE distribution.online_import SET status='COMPLETE',child_ids=$2 WHERE id=$1",
      [root.id, JSON.stringify([one.id])],
    );
    expect(
      (await live.preview(f.ctx, { kind: "playlist", id: root.id, mode: "all" })).blockers.join(),
    ).toContain("outside this playlist");
  });
});

import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDistributionRepository } from "./repository";
import { type StudioProviderConfig, sealStudioProviderConfig } from "./studio-provider-config";
import { loadDatabaseStudioSettings } from "./studio-settings-database";
import { promoteGbadptClone } from "./studio-world-promotion";

const suite = process.env.DISTRIBUTION_RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("GBADPT isolated TEST-to-live clone promotion", () => {
  let admin: Pool;
  let db: Pool;
  let created = false;
  let packageId: string;
  const database = "datta_content_studio_gbadpt_live";
  const key = "ab".repeat(32);
  const config: StudioProviderConfig = {
    version: 1,
    trustedMediaOrigins: [],
    accounts: [
      {
        id: "guru",
        platform: "youtube",
        transport: "buffer",
        providerAccountId: "fake-channel",
        world: "PRODUCTION",
        isDefault: true,
        enabled: true,
        eligibilityVerified: true,
        channelUrl: "https://www.youtube.com/@gurubhavana",
        accessToken: "synthetic-test-only",
      },
    ],
  };
  const payload = {
    isTest: true,
    status: "IN_REVIEW",
    outputs: [
      {
        id: "first",
        title: "My edited title",
        trimStart: 2,
        captions: [{ language: "en", cues: [{ text: "Edited translation", start: 0, end: 2 }] }],
        asset: { storageKey: "distribution/derived/preserved.mp4", sha256: "a".repeat(64) },
      },
    ],
    feedback: [{ comment: "Keep this human review", createdAt: "2026-10-24T00:00:00Z" }],
  };
  beforeAll(async () => {
    const url = new URL(process.env.DISTRIBUTION_TEST_ADMIN_URL ?? "");
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.pathname.startsWith("/content_studio_separation_test_")
    )
      throw Error("DISPOSABLE_TEST_DATABASE_REQUIRED");
    admin = new Pool({ connectionString: url.toString() });
    // Intentionally refuse if a database with this name already exists. Never drop someone else's database.
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    url.pathname = `/${database}`;
    db = new Pool({ connectionString: url.toString() });
    await migrate(drizzle(db), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      migrationsSchema: "distribution_migrations",
      migrationsTable: "__distribution_migrations",
    });
  }, 20000);
  afterAll(async () => {
    await db?.end();
    if (created) await admin.query(`DROP DATABASE ${database}`);
    await admin?.end();
  });
  beforeEach(async () => {
    const tables = (
      await db.query("SELECT tablename FROM pg_tables WHERE schemaname='distribution'")
    ).rows
      .map((r) => `distribution.\"${r.tablename}\"`)
      .join(",");
    await db.query(`TRUNCATE ${tables} CASCADE`);
    const operator = randomUUID();
    await db.query(
      "INSERT INTO distribution.operator(id,email,display_name,password_hash,roles,is_test) VALUES($1,'curator@example.test','Curator','preserved-hash','[\"CONTENT_COORDINATOR\"]',true)",
      [operator],
    );
    await db.query(
      "INSERT INTO distribution.operator_session(token_hash,operator_id,expires_at) VALUES('test-session',$1,now()+interval '1 hour')",
      [operator],
    );
    const master = await createDistributionRepository(db, { authorize: async () => true }).create(
      { userId: operator, isTest: true, roles: ["CONTENT_COORDINATOR"] },
      {
        title: "My source",
        language: "te",
        category: "pravachanams",
        asset: {
          storageKey: `distribution/masters/${randomUUID()}`,
          sha256: "b".repeat(64),
          byteSize: 128,
          mimeType: "video/mp4",
          originalName: "original.mp4",
        },
      },
    );
    packageId = randomUUID();
    await db.query(
      "INSERT INTO distribution.studio_package(id,is_test,master_id,source_version_id,creation_key,created_by,generation_checkpoint) VALUES($1,true,$2,$3,$4,$5,$6)",
      [
        packageId,
        master.id,
        master.currentVersion.id,
        "c".repeat(64),
        operator,
        { section1: { fingerprint: "d".repeat(64), value: { completed: true } } },
      ],
    );
    await db.query(
      "INSERT INTO distribution.studio_revision(package_id,is_test,revision,snapshot,actor_id,action) VALUES($1,true,1,$2,$3,'SUBMITTED')",
      [packageId, payload, operator],
    );
    await db.query(
      "INSERT INTO distribution.studio_generation_job(package_id,is_test,package_revision,requested_by,status) VALUES($1,true,1,$2,'QUEUED')",
      [packageId, operator],
    );
    const worldKey = createHmac("sha256", Buffer.from(key, "hex"))
      .update("studio-settings-world:true")
      .digest("hex");
    await db.query("INSERT INTO distribution.studio_settings(is_test,sealed) VALUES(true,$1)", [
      sealStudioProviderConfig(config, worldKey),
    ]);
  });
  async function promote(apply = true) {
    const client = await db.connect();
    try {
      return await promoteGbadptClone(client, { key, apply });
    } finally {
      client.release();
    }
  }
  it("preserves edits, captions, asset hashes, review state, passwords and generation checkpoints; revokes TEST sessions", async () => {
    const before = (await db.query("SELECT generation_checkpoint FROM distribution.studio_package"))
      .rows;
    const result = await promote();
    expect(result).toMatchObject({ applied: true, sessionsRevoked: 1, publicationJobs: 0 });
    expect(
      (await db.query("SELECT snapshot FROM distribution.studio_revision")).rows[0].snapshot,
    ).toEqual({ ...payload, isTest: false });
    expect(
      (await db.query("SELECT generation_checkpoint FROM distribution.studio_package")).rows,
    ).toEqual(before);
    expect(
      (await db.query("SELECT password_hash,is_test FROM distribution.operator")).rows[0],
    ).toEqual({ password_hash: "preserved-hash", is_test: false });
    expect((await db.query("SELECT * FROM distribution.operator_session")).rowCount).toBe(0);
    expect((await db.query("SELECT * FROM distribution.studio_publication_job")).rowCount).toBe(0);
    expect(
      await loadDatabaseStudioSettings(
        false,
        { DISTRIBUTION_DATABASE_URL: db.options.connectionString },
        key,
      ),
    ).toEqual(config);
    await expect(promote()).rejects.toThrow("PROMOTION_REQUIRES_TEST_ONLY_CLONE");
  });
  it("rehearses and rolls back without altering the original TEST clone", async () => {
    expect((await promote(false)).applied).toBe(false);
    expect(
      (await db.query("SELECT snapshot FROM distribution.studio_revision")).rows[0].snapshot,
    ).toEqual(payload);
    expect((await db.query("SELECT * FROM distribution.operator_session")).rowCount).toBe(1);
  });
  it("resets only known TEST worker heartbeat records without treating them as live readiness", async () => {
    await db.query(
      "INSERT INTO distribution.module_state(id) VALUES('online-import-worker:true'),('live-curation-worker:true')",
    );
    expect((await promote(false)).workerHeartbeatsReset).toBe(2);
    expect((await db.query("SELECT * FROM distribution.module_state")).rowCount).toBe(2);
    expect((await promote()).workerHeartbeatsReset).toBe(2);
    expect((await db.query("SELECT * FROM distribution.module_state")).rowCount).toBe(0);
  });
  it("refuses unrecognized module state instead of silently clearing it", async () => {
    await db.query("INSERT INTO distribution.module_state(id) VALUES('unrecognized-state')");
    await expect(promote()).rejects.toThrow("PROMOTION_UNKNOWN_MODULE_STATE");
    expect((await db.query("SELECT * FROM distribution.module_state")).rowCount).toBe(1);
  });
  it("preserves removal tombstones and restores erasure guards before releasing the clone", async () => {
    await db.query("UPDATE distribution.studio_package SET deleted_at=now() WHERE id=$1", [
      packageId,
    ]);
    const removedAt = (
      await db.query("SELECT deleted_at FROM distribution.studio_package WHERE id=$1", [packageId])
    ).rows[0].deleted_at;
    await promote(false);
    await expect(
      db.query("UPDATE distribution.studio_package SET deleted_at=NULL WHERE id=$1", [packageId]),
    ).rejects.toThrow("CONTENT_REMOVED");
    await promote();
    const after = (
      await db.query("SELECT deleted_at,is_test FROM distribution.studio_package WHERE id=$1", [
        packageId,
      ])
    ).rows[0];
    expect(after).toEqual({ deleted_at: removedAt, is_test: false });
    await expect(
      db.query("UPDATE distribution.studio_package SET deleted_at=NULL WHERE id=$1", [packageId]),
    ).rejects.toThrow("CONTENT_REMOVED");
    expect(
      (
        await db.query(
          "SELECT DISTINCT tgenabled FROM pg_trigger WHERE tgname='guard_erased_content'",
        )
      ).rows,
    ).toEqual([{ tgenabled: "O" }]);
  });
  it("rejects outstanding publication records instead of turning a simulation into an upload", async () => {
    await db.query(
      "INSERT INTO distribution.studio_publication_job(package_id,is_test,package_revision,output_id,channel,requested_by,status) VALUES($1,true,1,$2,'youtube','test','SIMULATED')",
      [packageId, randomUUID()],
    );
    await expect(promote()).rejects.toThrow("PROMOTION_UNSUPPORTED_TABLE_studio_publication_job");
  });
  it("rejects active workers and mixed-world data", async () => {
    await db.query("UPDATE distribution.studio_generation_job SET status='RUNNING'");
    await expect(promote()).rejects.toThrow("PROMOTION_WORKERS_MUST_BE_DRAINED");
    await db.query(
      "UPDATE distribution.studio_generation_job SET status='QUEUED'; UPDATE distribution.operator SET is_test=false",
    );
    await expect(promote()).rejects.toThrow("PROMOTION_REQUIRES_TEST_ONLY_CLONE");
  });
  it("rejects unknown populated tables", async () => {
    await db.query(
      "CREATE TABLE distribution.unreviewed (is_test boolean); INSERT INTO distribution.unreviewed VALUES(true)",
    );
    try {
      await expect(promote()).rejects.toThrow("PROMOTION_UNSUPPORTED_TABLE_unreviewed");
    } finally {
      await db.query("DROP TABLE distribution.unreviewed");
    }
  });
  it("detects any nested content change and rolls back all changes", async () => {
    await db.query(`CREATE FUNCTION distribution.promotion_test_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.snapshot=jsonb_set(NEW.snapshot,'{outputs,0,title}','"unexpected edit"'); RETURN NEW; END $$;
      CREATE TRIGGER promotion_test_change BEFORE UPDATE ON distribution.studio_revision FOR EACH ROW EXECUTE FUNCTION distribution.promotion_test_change()`);
    try {
      await expect(promote()).rejects.toThrow("PROMOTION_CONTENT_CHANGED_studio_revision");
      expect(
        (await db.query("SELECT snapshot FROM distribution.studio_revision")).rows[0].snapshot,
      ).toEqual(payload);
      expect((await db.query("SELECT is_test FROM distribution.operator")).rows[0].is_test).toBe(
        true,
      );
    } finally {
      await db.query(
        "DROP TRIGGER promotion_test_change ON distribution.studio_revision; DROP FUNCTION distribution.promotion_test_change()",
      );
    }
  });
  it("refuses to modify a source/staging database", async () => {
    const client = await admin.connect();
    try {
      await expect(promoteGbadptClone(client, { key, apply: true })).rejects.toThrow(
        "PROMOTION_WRONG_DATABASE",
      );
    } finally {
      client.release();
    }
  });
});

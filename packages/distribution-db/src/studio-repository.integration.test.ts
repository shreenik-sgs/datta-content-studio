import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  STUDIO_BRAND_NAME,
  STUDIO_MEDIA_DEFAULTS,
  type StudioChannel,
  type StudioLanguage,
  type StudioOutput,
  type StudioPackage,
  type StudioProvenance,
  studioAssetName,
  studioClosingCardPlan,
} from "@satsang/distribution-domain";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDistributionEditorialRepository } from "./editorial-repository";
import { createDistributionRepository } from "./repository";
import type { StudioProviderConfig } from "./studio-provider-config";
import { createIntelligentContentRepository } from "./studio-repository";
import { studioSettingsRevision } from "./studio-settings";
import { loadDatabaseStudioSettings, saveDatabaseStudioSettings } from "./studio-settings-database";
const suite = process.env.DISTRIBUTION_RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("durable intelligent Studio on isolated local PostgreSQL", () => {
  let admin: Pool;
  let migration: Pool;
  let runtime: Pool;
  let content: ReturnType<typeof createDistributionRepository>;
  let editorial: ReturnType<typeof createDistributionEditorialRepository>;
  let studio: ReturnType<typeof createIntelligentContentRepository>;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `distribution_studio_${suffix}`;
  const migrateRole = `dist_studio_m_${suffix}`;
  const runtimeRole = `dist_studio_r_${suffix}`;
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
    content = createDistributionRepository(runtime, { authorize: authority });
    editorial = createDistributionEditorialRepository(runtime);
    studio = createIntelligentContentRepository(runtime, { authorize: authority });
  }, 20000);
  it("persists encrypted settings with atomic revisions and cryptographic world separation", async () => {
    const env = { DISTRIBUTION_DATABASE_URL: runtime.options.connectionString };
    const key = "ab".repeat(32);
    const empty: StudioProviderConfig = { version: 1, accounts: [], trustedMediaOrigins: [] };
    const config: StudioProviderConfig = {
      ...empty,
      accounts: [
        {
          id: "x",
          platform: "x",
          transport: "buffer",
          providerAccountId: "x-1",
          world: "PRODUCTION",
          enabled: false,
          eligibilityVerified: false,
          accessToken: "synthetic-database-secret",
        },
      ],
    };
    expect(await loadDatabaseStudioSettings(false, env, key)).toEqual(empty);
    const results = await Promise.allSettled(
      [config, { ...config, trustedMediaOrigins: ["https://ashrama.example"] }].map((config) =>
        saveDatabaseStudioSettings({
          isTest: false,
          env,
          key,
          expectedRevision: studioSettingsRevision(empty),
          config,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const row = (
      await runtime.query("SELECT sealed FROM distribution.studio_settings WHERE is_test=false")
    ).rows[0];
    expect(row.sealed).not.toContain("synthetic-database-secret");
    expect((await loadDatabaseStudioSettings(false, env, key)).accounts).toEqual(config.accounts);
    await expect(loadDatabaseStudioSettings(false, env, "cd".repeat(32))).rejects.toThrow(
      "STUDIO_PROVIDER_CONFIG_INVALID",
    );
    expect(await loadDatabaseStudioSettings(true, env, key)).toEqual(empty);
    await runtime.query(
      "INSERT INTO distribution.studio_settings(is_test,sealed) VALUES(true,$1)",
      [row.sealed],
    );
    await expect(loadDatabaseStudioSettings(true, env, key)).rejects.toThrow(
      "STUDIO_PROVIDER_CONFIG_INVALID",
    );
  });
  afterAll(async () => {
    await runtime?.end();
    await migration?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}; DROP ROLE IF EXISTS ${migrateRole}`);
      await admin.end();
    }
  });
  function identity(isTest = true, adminRole = false) {
    const ctx = {
      userId: `studio-${randomUUID()}@example.test`,
      isTest,
      roles: [adminRole ? "CONTENT_APPROVER" : "CONTENT_COORDINATOR"],
    };
    roles.set(`${isTest}:${ctx.userId}`, ctx.roles);
    return ctx;
  }
  async function fixture(
    input: {
      isTest?: boolean;
      approved?: boolean;
      language?: "en" | "te";
      channels?: StudioChannel[];
      outputLanguages?: StudioLanguage[];
      allCompleteMessages?: boolean;
    } = {},
  ) {
    const ctx = identity(input.isTest ?? true);
    const reviewer = identity(ctx.isTest, true);
    let master = await content.create(ctx, {
      title: "Synthetic source teaching",
      language: input.language ?? "en",
      category: "other",
      asset: {
        storageKey: `distribution/masters/${randomUUID()}`,
        sha256: randomUUID().replaceAll("-", "").repeat(2),
        byteSize: 100,
        mimeType: "video/mp4",
        originalName: "synthetic.mp4",
      },
    });
    master = await content.attestRights(ctx, master.id, {
      expectedRevision: master.revision,
      rights: {
        owner: "SGS",
        territories: ["WORLDWIDE"],
        channels: ["x", "website", "youtube"],
        authorizationBasis: "Synthetic local test",
        privacyClass: "PUBLIC",
        releaseAt: null,
        expiresAt: null,
      },
    });
    if (input.approved !== false)
      master = await content.approve(reviewer, master.id, { expectedRevision: master.revision });
    const pkg = await studio.create(ctx, {
      masterId: master.id,
      expectedSourceRevision: master.revision,
      request: {
        languages: input.outputLanguages ?? [input.language ?? "en"],
        channels: input.channels ?? ["x", "website"],
        captions: false,
        instructions: "Synthetic tests only",
        ...(input.allCompleteMessages ? { allCompleteMessages: true } : {}),
      },
    });
    return { ctx, reviewer, master, pkg };
  }
  it("persists and deduplicates per-package subscription and speaker settings", async () => {
    const f = await fixture({ channels: ["youtube"] });
    const request: StudioPackage["request"] = {
      ...f.pkg.request,
      sourceBranding: "bala-swamiji",
      youtubeClosing: { label: " Gurubhavana ADPT ", url: "https://youtube.com/@gurubhavanaadpt/" },
    };
    const create = () =>
      studio.create(f.ctx, {
        masterId: f.master.id,
        expectedSourceRevision: f.master.revision,
        request,
      });
    const custom = await create();
    expect(custom.id).not.toBe(f.pkg.id);
    expect((await create()).id).toBe(custom.id);
    expect((await studio.get(f.ctx, custom.id)).request).toMatchObject({
      sourceBranding: "bala-swamiji",
      youtubeClosing: {
        label: "Gurubhavana ADPT",
        url: "https://www.youtube.com/@gurubhavanaadpt",
      },
    });
    const lease = await claim(custom);
    expect(lease.package.request).toEqual(custom.request);
    await studio.failGeneration(lease, "STUDIO_PROVIDER_TIMEOUT");
    await migration.query(
      "UPDATE distribution.studio_generation_job SET status='SUCCEEDED' WHERE package_id=ANY($1::uuid[])",
      [[custom.id, f.pkg.id]],
    );
  });
  async function claim(pkg: StudioPackage, leaseMs?: number) {
    const row = (
      await migration.query(
        "SELECT id FROM distribution.studio_generation_job WHERE package_id=$1 AND is_test=$2 AND package_revision=$3",
        [pkg.id, pkg.isTest, pkg.revision],
      )
    ).rows[0];
    const claimOnce = () =>
      studio.claimGeneration({
        isTest: pkg.isTest,
        workerId: "studio-test",
        jobId: row.id,
        ...(leaseMs ? { leaseMs } : {}),
      });
    let result = await claimOnce();
    // A claim is a nonblocking queue poll, not a guarantee of immediate ownership.
    // Match the worker's bounded polling without changing availability or bypassing leases.
    for (let attempt = 0; !result && attempt < 10; attempt++) {
      const state = await migration.query(
        "SELECT status FROM distribution.studio_generation_job WHERE id=$1",
        [row.id],
      );
      if (state.rows[0]?.status !== "QUEUED") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = await claimOnce();
    }
    if (!result) {
      const state = await migration.query(
        "SELECT status,last_error FROM distribution.studio_generation_job WHERE id=$1",
        [row.id],
      );
      throw new Error(`MISSING_CLAIM:${JSON.stringify(state.rows[0])}`);
    }
    return result;
  }
  function generated(pkg: StudioPackage): {
    outputs: StudioOutput[];
    provenance: StudioProvenance;
  } {
    const provenance: StudioProvenance = {
      provider: "local",
      model: "source-excerpt-v1",
      promptVersion: "test-v1",
      generatedAt: new Date().toISOString(),
      brandName: STUDIO_BRAND_NAME,
      brandLogoSha256: "b".repeat(64),
      transcript: {
        language: pkg.source.language,
        durationMs: 2000,
        segments: [{ id: "one", startMs: 0, endMs: 2000, text: "Synthetic teaching." }],
        provenance: "MACHINE_TRANSCRIPT",
        sourceTranscriptId: null,
      },
      skippedChannels: [],
    };
    const outputs: StudioOutput[] = pkg.request.channels.map((channel) => {
      const id = randomUUID();
      const format =
        channel === "youtube"
          ? ("short" as const)
          : channel === "website"
            ? ("blog" as const)
            : ("post" as const);
      const aspect =
        channel === "youtube"
          ? ("9:16" as const)
          : channel === "website"
            ? ("prose" as const)
            : ("1:1" as const);
      const names = studioAssetName(
        {
          masterId: pkg.source.masterId,
          sourceVersionId: pkg.source.versionId,
          packageId: pkg.id,
          outputId: id,
          channel,
          format,
          language: pkg.request.languages[0] ?? "en",
          aspect,
        },
        channel === "youtube" ? "mp4" : channel === "website" ? "md" : "png",
      );
      return {
        id,
        ...(pkg.request.allCompleteMessages ? { messageId: "fixture-message" } : {}),
        channel,
        format,
        aspect,
        language: pkg.request.languages[0] ?? "en",
        title: "Synthetic teaching",
        body: "Synthetic teaching.\n\n@sgsswamiji",
        rationale: "Source-based test",
        included: true,
        sourceSegmentIds: ["one"],
        startMs: channel === "youtube" ? 0 : null,
        endMs: channel === "youtube" ? 2000 : null,
        asset: {
          ...names,
          sha256: "c".repeat(64),
          byteSize: 100,
          mimeType:
            channel === "youtube"
              ? "video/mp4"
              : channel === "website"
                ? "text/markdown"
                : "image/png",
        },
        captions: [],
        warnings: [],
      };
    });
    return { outputs, provenance };
  }
  async function draft(f: Awaited<ReturnType<typeof fixture>>) {
    const c = await claim(f.pkg);
    const result = await studio.completeGeneration(c, generated(f.pkg));
    if (!result.accepted) throw new Error(result.reason);
    return result.package;
  }
  async function approved(f: Awaited<ReturnType<typeof fixture>>) {
    let pkg = await draft(f);
    pkg = await studio.submit(f.ctx, pkg.id, {
      expectedRevision: pkg.revision,
      comment: "Ready for independent review",
    });
    return studio.review(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "APPROVED",
      confirmTranscript: true,
      confirmTeachingIntegrity: true,
    });
  }

  it("queues additional discovery separately, preserves existing drafts and rejects mutation during completion", async () => {
    const f = await fixture({ channels: ["youtube"], allCompleteMessages: true });
    const original = await draft(f);
    await expect(
      studio.enqueueGeneration(f.reviewer, original.id, {
        expectedRevision: original.revision,
        mode: "discover",
      }),
    ).rejects.toThrow();
    await expect(
      studio.enqueueGeneration(f.ctx, original.id, {
        expectedRevision: original.revision,
        mode: "discover",
        outputIds: [original.outputs[0]?.id ?? ""],
      }),
    ).rejects.toThrow("STUDIO_SELECT_OUTPUTS");
    const queued = await studio.enqueueGeneration(f.ctx, original.id, {
      expectedRevision: original.revision,
      mode: "discover",
    });
    expect(queued.outputs).toEqual(original.outputs);
    expect(queued.generation).toEqual({ mode: "discover", outputIds: [] });
    const lease = await claim(queued);
    if (!original.provenance) throw Error("Expected original provenance");
    await expect(
      studio.completeGeneration(lease, {
        outputs: original.outputs.map((o) => ({ ...o, title: "Tampered" })),
        provenance: original.provenance,
      }),
    ).rejects.toThrow("STUDIO_DISCOVERY_ISOLATION_REQUIRED");
    const finished = await studio.completeGeneration(lease, {
      outputs: original.outputs,
      provenance: original.provenance,
    });
    if (!finished.accepted) throw Error(finished.reason);
    expect(finished.package.outputs).toEqual(original.outputs);
    expect(finished.package.status).toBe("DRAFT");
    expect(finished.package.approval).toBeNull();
    const lockedFixture = await fixture();
    const locked = await approved(lockedFixture);
    await expect(
      studio.enqueueGeneration(lockedFixture.ctx, locked.id, {
        expectedRevision: locked.revision,
        mode: "discover",
      }),
    ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
  });

  it("adds a missed teaching without touching existing files, and requires generation and review", async () => {
    const f = await fixture({ channels: ["youtube"] });
    const result = generated(f.pkg);
    for (const output of result.outputs) output.messageId = "original-teaching";
    result.provenance.transcript.durationMs = 4000;
    result.provenance.transcript.segments.push({
      id: "two",
      startMs: 2000,
      endMs: 4000,
      text: "Serve with kindness.",
    });
    const completed = await studio.completeGeneration(await claim(f.pkg), result);
    if (!completed.accepted) throw Error(completed.reason);
    const original = completed.package;
    const message = {
      messageId: "seva",
      channel: "youtube" as const,
      format: "short" as const,
      language: "en" as const,
      title: "Serve with kindness",
      body: "Serve with kindness.\n\n@sgsswamiji",
      rationale: "Another complete teaching",
      sourceSegmentIds: ["two"],
      captionCues: [{ id: "two", startMs: 2000, endMs: 4000, text: "Serve with kindness." }],
    };
    await expect(
      studio.appendMessage(f.reviewer, original.id, {
        expectedRevision: original.revision,
        message,
        comment: "Add",
      }),
    ).rejects.toThrow();
    await expect(
      studio.appendMessage(f.ctx, original.id, {
        expectedRevision: original.revision,
        message: { ...message, captionCues: [] },
        comment: "Add",
      }),
    ).rejects.toThrow("INVALID_STUDIO_CAPTIONS");
    await expect(
      studio.appendMessage(f.ctx, original.id, {
        expectedRevision: original.revision,
        message: {
          ...message,
          sourceSegmentIds: ["one"],
          captionCues: [{ id: "one", startMs: 0, endMs: 2000, text: "Synthetic teaching." }],
        },
        comment: "Duplicate passage under another identity",
      }),
    ).rejects.toThrow("DUPLICATE_STUDIO_PASSAGE");
    const next = await studio.appendMessage(f.ctx, original.id, {
      expectedRevision: original.revision,
      message,
      comment: "Include a missed teaching",
    });
    expect(next.outputs[0]).toEqual(original.outputs[0]);
    expect(next.outputs[1]).toMatchObject({ asset: null, captions: [], messageId: "seva" });
    expect(next.outputs[1]?.aiReview).toBeUndefined();
    expect(next.generation).toEqual({ mode: "render", outputIds: [next.outputs[1]?.id] });
    expect(next.status).toBe("QUEUED");
    await expect(
      studio.submit(f.ctx, next.id, { expectedRevision: next.revision }),
    ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
    await expect(
      studio.appendMessage(f.ctx, next.id, {
        expectedRevision: next.revision,
        message,
        comment: "Duplicate",
      }),
    ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
    const approvedFixture = await fixture();
    const locked = await approved(approvedFixture);
    await expect(
      studio.appendMessage(approvedFixture.ctx, locked.id, {
        expectedRevision: locked.revision,
        message,
        comment: "Add",
      }),
    ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
  });

  it("pages immutable revision history with original file metadata and current role/world checks", async () => {
    const f = await fixture();
    const original = await draft(f);
    const originalOutput = original.outputs[0];
    if (!originalOutput) throw new Error("MISSING_OUTPUT");
    const edited = await studio.revise(f.ctx, original.id, {
      expectedRevision: original.revision,
      outputs: original.outputs.map((output) => ({
        id: output.id,
        title: output.title,
        body: `${output.body} A revised explanation.`,
        included: output.included,
      })),
      comment: "Refine the wording.",
    });
    const firstPage = await studio.history(f.ctx, original.id, { limit: 2 });
    expect(firstPage.revisions.map((entry) => entry.revision)).toEqual([3, 2]);
    expect(firstPage.nextOffset).toBe(2);
    expect(firstPage.revisions[0]).toMatchObject({
      action: "REVISED",
      actorId: f.ctx.userId,
      package: { revision: edited.revision, outputs: [{ asset: null }, { asset: null }] },
    });
    expect(firstPage.revisions[1]?.package.outputs[0]).toEqual(originalOutput);
    expect(firstPage.revisions.every((entry) => Number.isFinite(Date.parse(entry.createdAt)))).toBe(
      true,
    );
    expect(
      firstPage.revisions.every(
        (entry) => entry.package.source.versionId === f.pkg.source.versionId,
      ),
    ).toBe(true);
    const lastPage = await studio.history(f.reviewer, original.id, { limit: 2, offset: 2 });
    expect(lastPage.revisions.map((entry) => entry.revision)).toEqual([1]);
    expect(lastPage.revisions[0]).toMatchObject({ action: "CREATED", package: { outputs: [] } });
    expect(lastPage.nextOffset).toBeNull();
    expect(await studio.history(f.ctx, original.id, { offset: 3 })).toEqual({
      revisions: [],
      nextOffset: null,
    });
    await expect(studio.history({ ...f.ctx, isTest: false }, original.id)).rejects.toThrow(
      "NOT_FOUND",
    );
    await expect(studio.history({ ...f.ctx, roles: [] }, original.id)).rejects.toThrow("FORBIDDEN");
    await expect(studio.history(f.ctx, randomUUID())).rejects.toThrow("NOT_FOUND");
    await expect(studio.history(f.ctx, original.id, { limit: 51 })).rejects.toThrow(
      "INVALID_PAGINATION",
    );
    await expect(studio.history(f.ctx, original.id, { offset: -1 })).rejects.toThrow(
      "INVALID_PAGINATION",
    );
    expect(await studio.get(f.ctx, original.id)).toEqual(edited);
  });
  it("retains discarded and withdrawn revision metadata without restoring access to media", async () => {
    const f = await fixture();
    const original = await draft(f);
    const output = original.outputs[0];
    if (!output) throw new Error("MISSING_OUTPUT");
    const discarded = await studio.discard(f.reviewer, original.id, {
      expectedRevision: original.revision,
      comment: "Keep the history but drop the package.",
    });
    const history = await studio.history(f.ctx, original.id);
    expect(history.revisions[0]?.package.status).toBe("DISCARDED");
    expect(history.revisions[1]?.package.outputs).toEqual(original.outputs);
    await expect(
      studio.getOutputAsset(f.ctx, original.id, output.id, { kind: "asset" }),
    ).rejects.toThrow("STUDIO_DISCARDED");
    await content.withdraw(f.reviewer, f.master.id, { expectedRevision: f.master.revision });
    expect((await studio.history(f.reviewer, original.id)).revisions[0]?.revision).toBe(
      discarded.revision,
    );
    await expect(
      studio.getOutputAsset(f.reviewer, original.id, output.id, {
        kind: "asset",
        forExport: true,
      }),
    ).rejects.toThrow("STUDIO_DISCARDED");
  });
  it("queues creation idempotently and separates roles, worlds and lease secrets", async () => {
    const f = await fixture();
    expect(
      (
        await studio.create(f.ctx, {
          masterId: f.master.id,
          expectedSourceRevision: f.master.revision,
          request: f.pkg.request,
        })
      ).id,
    ).toBe(f.pkg.id);
    await expect(
      studio.create(f.reviewer, {
        masterId: f.master.id,
        expectedSourceRevision: f.master.revision,
        request: f.pkg.request,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(studio.get({ ...f.ctx, isTest: false }, f.pkg.id)).rejects.toThrow("NOT_FOUND");
    expect(await studio.list({ ...f.ctx, isTest: false })).toEqual([]);
    const c = await claim(f.pkg);
    expect(c.source.masterId).toBe(f.master.id);
    expect((await studio.get(f.ctx, f.pkg.id)).status).toBe("GENERATING");
    expect(await studio.get(f.ctx, f.pkg.id)).not.toHaveProperty("leaseToken");
    await studio.failGeneration(c, "synthetic provider detail with secret");
    expect((await studio.get(f.ctx, f.pkg.id)).failure).toBe("GENERATION_FAILED");
  });
  it("checkpoints are private, fenced by the lease, and reused across explicit retries without revisions", async () => {
    const f = await fixture();
    const c = await claim(f.pkg);
    const before = (await studio.history(f.ctx, f.pkg.id)).revisions.length;
    const progress = {
      phase: "drafting" as const,
      provider: "gemini" as const,
      completed: 2,
      total: 4,
    };
    await studio.checkpointGeneration(c, {
      key: "transcript",
      fingerprint: "a".repeat(64),
      value: { privateText: "synthetic" },
    });
    await studio.checkpointGeneration(c, { progress });
    const visible = await studio.get(f.ctx, f.pkg.id);
    expect(visible.generationProgress).toEqual(progress);
    expect(JSON.stringify(visible)).not.toContain("privateText");
    expect((await studio.history(f.ctx, f.pkg.id)).revisions).toHaveLength(before);
    await expect(
      studio.checkpointGeneration({ ...c, leaseToken: randomUUID() }, { progress }),
    ).rejects.toThrow("STUDIO_LEASE_LOST");
    expect(await studio.deferGeneration(c, "STUDIO_PROVIDER_RATE_LIMITED", 60000, progress)).toBe(
      true,
    );
    expect(
      await studio.claimGeneration({ isTest: true, workerId: "studio-test", jobId: c.id }),
    ).toBeNull();
    expect((await studio.get(f.ctx, f.pkg.id)).generationProgress?.errorCode).toBe(
      "STUDIO_PROVIDER_RATE_LIMITED",
    );
    await migration.query(
      "UPDATE distribution.studio_generation_job SET available_at=clock_timestamp() WHERE id=$1",
      [c.id],
    );
    const retry = await claim(f.pkg);
    expect(retry.checkpoint?.transcript?.value).toEqual({ privateText: "synthetic" });
    await studio.failGeneration(retry, "STUDIO_PROVIDER_OUTPUT_LIMIT");
    const failed = await studio.get(f.ctx, f.pkg.id);
    const next = await studio.enqueueGeneration(f.ctx, failed.id, {
      expectedRevision: failed.revision,
    });
    const explicit = await claim(next);
    expect(explicit.checkpoint?.transcript?.fingerprint).toBe("a".repeat(64));
    await studio.completeGeneration(explicit, generated(f.pkg));
    await expect(studio.checkpointGeneration(explicit, { progress })).rejects.toThrow(
      "STUDIO_LEASE_LOST",
    );
  });
  it("hides withdrawn masters from normal package lists while retaining explicit history access", async () => {
    const f = await fixture();
    expect((await studio.list(f.ctx, { masterId: f.master.id })).map((item) => item.id)).toEqual([
      f.pkg.id,
    ]);
    await content.withdraw(f.reviewer, f.master.id, { expectedRevision: f.master.revision });
    expect(await studio.list(f.ctx, { masterId: f.master.id })).toEqual([]);
    expect(await studio.list(f.ctx, { masterId: f.master.id, includeWithdrawn: false })).toEqual(
      [],
    );
    expect(
      (await studio.list(f.ctx, { masterId: f.master.id, includeWithdrawn: true })).map(
        (item) => item.id,
      ),
    ).toEqual([f.pkg.id]);
    expect(
      await studio.list(
        { ...f.ctx, isTest: false },
        { masterId: f.master.id, includeWithdrawn: true },
      ),
    ).toEqual([]);
    expect((await studio.get(f.ctx, f.pkg.id)).id).toBe(f.pkg.id);
    expect((await studio.history(f.ctx, f.pkg.id)).revisions[0]?.package.id).toBe(f.pkg.id);
  });
  const externalGenerationCases = [
    {
      label: "OpenAI drafting",
      provider: "openai" as const,
      model: "synthetic-openai",
      recognition: undefined,
    },
    {
      label: "Gemini drafting with Sarvam recognition",
      provider: "gemini" as const,
      model: "synthetic-gemini",
      recognition: { provider: "sarvam" as const, model: "saaras:v4" },
    },
    {
      label: "local drafting after Sarvam recognition",
      provider: "local" as const,
      model: "source-excerpt-v1",
      recognition: { provider: "sarvam" as const, model: "saaras:v4" },
    },
    {
      label: "local drafting after OpenAI recognition",
      provider: "local" as const,
      model: "source-excerpt-v1",
      recognition: { provider: "openai" as const, model: "whisper-1" },
    },
  ];
  function externalGenerated(pkg: StudioPackage, mode: (typeof externalGenerationCases)[number]) {
    const result = generated(pkg);
    result.provenance.provider = mode.provider;
    result.provenance.model = mode.model;
    result.provenance.inputMode =
      mode.provider === "gemini" ? "transcript_and_audio" : "transcript";
    if (mode.recognition) result.provenance.transcript.recognition = mode.recognition;
    return result;
  }
  it.each(externalGenerationCases)(
    "persists $label provenance only while explicit public rights remain current",
    async (mode) => {
      const f = await fixture();
      const c = await claim(f.pkg);
      expect(c.externalProcessing).toEqual({ allowed: true, reason: null });
      expect(await studio.renewGeneration(c)).toBe(true);
      const result = externalGenerated(f.pkg, mode);
      expect((await studio.completeGeneration(c, result)).accepted).toBe(true);
      const saved = await studio.get(f.ctx, f.pkg.id);
      expect(saved.status).toBe("DRAFT");
      expect(saved.approval).toBeNull();
      expect(saved.provenance).toEqual(result.provenance);
      expect(saved.outputs.map((output) => output.sourceSegmentIds)).toEqual([["one"], ["one"]]);
    },
  );
  it.each(externalGenerationCases)(
    "revoked public rights stop renewal and completion for $label",
    async (mode) => {
      const f = await fixture();
      const c = await claim(f.pkg);
      expect(c.externalProcessing).toEqual({ allowed: true, reason: null });
      if (!f.master.rights) throw new Error("MISSING_RIGHTS");
      await content.attestRights(f.ctx, f.master.id, {
        expectedRevision: f.master.revision,
        rights: { ...f.master.rights, privacyClass: "INTERNAL" },
      });
      expect(await studio.renewGeneration(c)).toBe(false);
      expect(await studio.completeGeneration(c, externalGenerated(f.pkg, mode))).toEqual({
        accepted: false,
        reason: "STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED",
      });
      const saved = await studio.get(f.ctx, f.pkg.id);
      expect(saved).toMatchObject({
        status: "FAILED",
        failure: "STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED",
        outputs: [],
        provenance: null,
        approval: null,
      });
    },
  );
  it.each(externalGenerationCases)(
    "refuses $label results if external processing was never authorized for the claim",
    async (mode) => {
      const f = await fixture({ approved: false });
      if (!f.master.rights) throw new Error("MISSING_RIGHTS");
      await content.attestRights(f.ctx, f.master.id, {
        expectedRevision: f.master.revision,
        rights: { ...f.master.rights, channels: ["manual_export"] },
      });
      const c = await claim(f.pkg);
      expect(c.externalProcessing).toEqual({ allowed: false, reason: "CHANNEL_NOT_PERMITTED" });
      // The repository enforces this independently even if a worker supplies externally made results.
      expect(await studio.completeGeneration(c, externalGenerated(f.pkg, mode))).toEqual({
        accepted: false,
        reason: "STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED",
      });
      const saved = await studio.get(f.ctx, f.pkg.id);
      expect(saved.outputs).toEqual([]);
      expect(saved.provenance).toBeNull();
    },
  );
  it("retains local source drafting when external processing is not authorized", async () => {
    const local = await fixture({ approved: false });
    if (!local.master.rights) throw new Error("MISSING_RIGHTS");
    await content.attestRights(local.ctx, local.master.id, {
      expectedRevision: local.master.revision,
      rights: { ...local.master.rights, channels: ["manual_export"] },
    });
    const localClaim = await claim(local.pkg);
    expect(localClaim.externalProcessing).toEqual({
      allowed: false,
      reason: "CHANNEL_NOT_PERMITTED",
    });
    expect(await studio.renewGeneration(localClaim)).toBe(true);
    expect((await studio.completeGeneration(localClaim, generated(local.pkg))).accepted).toBe(true);
  });
  it("renewal preserves only a live, current, authorized generation lease", async () => {
    const f = await fixture();
    const c = await claim(f.pkg);
    expect(await studio.renewGeneration(c)).toBe(true);
    roles.set(`${f.ctx.isTest}:${f.ctx.userId}`, []);
    expect(await studio.renewGeneration(c)).toBe(false);
    const result = await studio.completeGeneration(c, generated(f.pkg));
    expect(result).toEqual({ accepted: false, reason: "REQUESTER_ROLE_REVOKED" });
    expect((await studio.get(f.reviewer, f.pkg.id)).status).toBe("FAILED");
  });
  it("generation before approval requires explicit transcript and integrity acknowledgment", async () => {
    const f = await fixture({ approved: false });
    let pkg = await draft(f);
    pkg = await studio.submit(f.ctx, pkg.id, { expectedRevision: pkg.revision });
    await expect(
      studio.review(f.reviewer, pkg.id, {
        expectedRevision: pkg.revision,
        decision: "APPROVED",
        confirmTranscript: true,
        confirmTeachingIntegrity: true,
      }),
    ).rejects.toThrow("NOT_APPROVED");
    await content.approve(f.reviewer, f.master.id, { expectedRevision: f.master.revision });
    await expect(
      studio.review(f.reviewer, pkg.id, {
        expectedRevision: pkg.revision,
        decision: "APPROVED",
        confirmTeachingIntegrity: true,
      }),
    ).rejects.toThrow("MACHINE_TRANSCRIPT_CONFIRMATION_REQUIRED");
    await expect(
      studio.review(f.reviewer, pkg.id, {
        expectedRevision: pkg.revision,
        decision: "APPROVED",
        confirmTranscript: true,
      }),
    ).rejects.toThrow("TEACHING_INTEGRITY_CONFIRMATION_REQUIRED");
    pkg = await studio.review(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "APPROVED",
      confirmTranscript: true,
      confirmTeachingIntegrity: true,
    });
    expect(pkg.approval?.sourceRevision).toBe(f.master.revision + 1);
    expect(pkg.source.revision).toBe(f.master.revision);
  });
  it("retains AI findings with human rejection, then invalidates the pass on a curator edit", async () => {
    const f = await fixture({ channels: ["youtube"] });
    const result = generated(f.pkg);
    const output = result.outputs[0];
    if (!output) throw Error("Missing fixture");
    output.aiReview = {
      status: "PASSED",
      policyVersion: "content-integrity-v1",
      provider: "gemini",
      model: "synthetic",
      recordedAt: new Date().toISOString(),
      inputMode: "transcript_and_audio",
      fileVersion: 1,
      sourceSha256: f.pkg.source.sha256,
      humanFeedbackConsidered: false,
      checks: {
        channel: "youtube",
        language: "en",
        openingComplete: true,
        endingComplete: true,
        contextComplete: true,
        attributionCorrect: true,
        captionsFaithful: true,
        copySupported: true,
        reason: "Synthetic complete thought.",
      },
    };
    const completed = await studio.completeGeneration(await claim(f.pkg), result);
    if (!completed.accepted) throw Error(completed.reason);
    let pkg = completed.package;
    expect(pkg.approval).toBeNull();
    pkg = await studio.submit(f.ctx, pkg.id, { expectedRevision: pkg.revision });
    pkg = await studio.review(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "REJECTED",
      outputIds: [output.id],
      comment: "Preserve the speaker attribution more explicitly.",
    });
    expect(pkg.outputs[0]?.correction?.before.aiReview).toEqual(output.aiReview);
    pkg = await studio.revise(f.ctx, pkg.id, {
      expectedRevision: pkg.revision,
      outputs: [
        { id: output.id, title: "Clarified source attribution", body: output.body, included: true },
      ],
      comment: "Apply the human correction",
    });
    expect(pkg.outputs[0]?.aiReview).toBeNull();
    expect(pkg.outputs[0]?.correction?.before.aiReview).toEqual(output.aiReview);
    expect(pkg.outputs[0]?.correction?.comment).toContain("attribution");
    expect(pkg.approval).toBeNull();
  });
  it("returns one file, blocks unresolved resubmission and refuses changes to unselected outputs", async () => {
    const f = await fixture();
    let pkg = await draft(f);
    pkg = await studio.submit(f.ctx, pkg.id, { expectedRevision: pkg.revision });
    const target = pkg.outputs[0];
    const other = pkg.outputs[1];
    if (!target || !other) throw new Error("Missing fixture");
    pkg = await studio.review(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "REJECTED",
      outputIds: [target.id],
      comment: "Shorten this file only",
    });
    expect(pkg.outputs[1]).toEqual(other);
    expect(pkg.outputs[0]?.correction?.comment).toBe("Shorten this file only");
    await expect(studio.submit(f.ctx, pkg.id, { expectedRevision: pkg.revision })).rejects.toThrow(
      "STUDIO_CORRECTIONS_PENDING",
    );
    await expect(
      studio.enqueueGeneration(f.ctx, pkg.id, {
        expectedRevision: pkg.revision,
        outputIds: [randomUUID()],
      }),
    ).rejects.toThrow("STUDIO_SELECT_OUTPUTS");
    pkg = await studio.enqueueGeneration(f.ctx, pkg.id, {
      expectedRevision: pkg.revision,
      outputIds: [target.id],
    });
    expect(pkg.generation?.outputIds).toEqual([target.id]);
    const c = await claim(pkg);
    const outputs = pkg.outputs.map((o) =>
      o.id === target.id
        ? {
            ...o,
            title: "Corrected title",
            correction: {
              ...(o.correction ??
                (() => {
                  throw new Error("Missing correction");
                })()),
              state: "revised" as const,
            },
          }
        : o,
    );
    await expect(
      studio.completeGeneration(c, {
        outputs: outputs.map((o) => (o.id === other.id ? { ...o, title: "Unexpected edit" } : o)),
        provenance:
          pkg.provenance ??
          (() => {
            throw new Error("Missing provenance");
          })(),
      }),
    ).rejects.toThrow("STUDIO_UNRELATED_OUTPUT_CHANGED");
    const result = await studio.completeGeneration(c, {
      outputs,
      provenance:
        pkg.provenance ??
        (() => {
          throw new Error("Missing provenance");
        })(),
    });
    if (!result.accepted) throw new Error(result.reason);
    pkg = await studio.submit(f.ctx, pkg.id, { expectedRevision: result.package.revision });
    expect(pkg.outputs[1]).toEqual(other);
    expect(pkg.outputs[0]?.correction?.state).toBe("submitted");
    pkg = await studio.review(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "APPROVED",
      confirmTranscript: true,
      confirmTeachingIntegrity: true,
    });
    expect(pkg.status).toBe("APPROVED");
    expect(pkg.outputs[0]?.correction?.state).toBe("resolved");
    const approvedSnapshot = await studio.get(f.ctx, pkg.id);
    const approvedOutput = pkg.outputs[0];
    if (!approvedOutput) throw new Error("Missing approved output");
    await expect(
      studio.revise(f.ctx, pkg.id, {
        expectedRevision: pkg.revision,
        outputs: [
          {
            id: approvedOutput.id,
            title: "Changed after approval",
            body: "Unauthorized replacement",
            included: true,
          },
        ],
        comment: "Attempt after approval",
      }),
    ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
    await expect(
      studio.enqueueGeneration(f.ctx, pkg.id, {
        expectedRevision: pkg.revision,
        outputIds: [approvedOutput.id],
        mode: "ai",
      }),
    ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
    await expect(
      studio.discard(f.ctx, pkg.id, {
        expectedRevision: pkg.revision,
        outputId: approvedOutput.id,
      }),
    ).rejects.toThrow("FORBIDDEN");
    expect(await studio.get(f.ctx, pkg.id)).toEqual(approvedSnapshot);
    const currentMaster = await content.get(f.ctx, pkg.source.masterId);
    const additional = await studio.create(f.ctx, {
      masterId: currentMaster.id,
      expectedSourceRevision: currentMaster.revision,
      request: {
        ...pkg.request,
        channels: ["youtube"],
        instructions: "Create another source-linked teaching passage for a new audience.",
      },
    });
    expect(additional.id).not.toBe(pkg.id);
    expect(additional.source.masterId).toBe(pkg.source.masterId);
    expect(additional.status).toBe("QUEUED");
    expect(additional.outputs).toEqual([]);
    expect(await studio.get(f.ctx, pkg.id)).toEqual(approvedSnapshot);
  });
  it("runs one explicitly dual-role user through review, correction, approval and test delivery", async () => {
    const f = await fixture({ approved: false });
    const dual = { ...f.ctx, roles: ["CONTENT_COORDINATOR", "CONTENT_APPROVER"] };
    roles.set(`${dual.isTest}:${dual.userId}`, dual.roles);
    let pkg = await draft(f);
    pkg = await studio.submit(dual, pkg.id, { expectedRevision: pkg.revision });
    await expect(
      studio.review(dual, pkg.id, {
        expectedRevision: pkg.revision,
        decision: "APPROVED",
        confirmTranscript: true,
        confirmTeachingIntegrity: true,
      }),
    ).rejects.toThrow("NOT_APPROVED");
    const master = await content.approve(dual, f.master.id, {
      expectedRevision: f.master.revision,
    });
    expect(master.approval?.reviewerId).toBe(dual.userId);
    const target = pkg.outputs[0];
    const other = pkg.outputs[1];
    if (!target || !other) throw Error("Missing outputs");
    pkg = await studio.review(dual, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "REJECTED",
      outputIds: [target.id],
      comment: "Correct only this title",
    });
    expect(pkg.status).toBe("CHANGES_REQUESTED");
    await expect(studio.submit(dual, pkg.id, { expectedRevision: pkg.revision })).rejects.toThrow(
      "STUDIO_CORRECTIONS_PENDING",
    );
    pkg = await studio.enqueueGeneration(dual, pkg.id, {
      expectedRevision: pkg.revision,
      outputIds: [target.id],
    });
    const claimValue = await claim(pkg);
    const corrected = await studio.completeGeneration(claimValue, {
      outputs: pkg.outputs.map((o) =>
        o.id === target.id
          ? {
              ...o,
              title: "Corrected title",
              correction: {
                ...(o.correction ??
                  (() => {
                    throw Error("Missing correction");
                  })()),
                state: "revised" as const,
              },
            }
          : o,
      ),
      provenance:
        pkg.provenance ??
        (() => {
          throw Error("Missing provenance");
        })(),
    });
    if (!corrected.accepted) throw Error(corrected.reason);
    pkg = await studio.submit(dual, pkg.id, { expectedRevision: corrected.package.revision });
    expect(pkg.outputs[1]).toEqual(other);
    await expect(
      studio.review(dual, pkg.id, { expectedRevision: pkg.revision, decision: "APPROVED" }),
    ).rejects.toThrow("TEACHING_INTEGRITY_CONFIRMATION_REQUIRED");
    pkg = await studio.review(dual, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "APPROVED",
      confirmTranscript: true,
      confirmTeachingIntegrity: true,
    });
    expect(pkg.approval?.reviewerId).toBe(dual.userId);
    expect(pkg.contributorIds).toContain(dual.userId);
    await expect(
      studio.enqueueGeneration(dual, pkg.id, {
        expectedRevision: pkg.revision,
        outputIds: [target.id],
      }),
    ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
    await expect(
      studio.revise(dual, pkg.id, {
        comment: "Must remain locked",
        expectedRevision: pkg.revision,
        outputs: pkg.outputs.map((o) => ({
          id: o.id,
          title: o.title,
          body: o.body,
          included: o.included,
        })),
      }),
    ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
    const queued = await studio.publish(dual, pkg.id, { expectedRevision: pkg.revision });
    const delivery = await studio.claimPublication({
      isTest: true,
      workerId: "dual-role-test",
      publicationId:
        queued[0]?.id ??
        (() => {
          throw Error("Missing publication");
        })(),
    });
    if (!delivery) throw Error("Missing publication claim");
    expect((await studio.revalidatePublication(delivery)).accepted).toBe(true);
    roles.set(`${dual.isTest}:${dual.userId}`, ["CONTENT_APPROVER"]);
    expect((await studio.revalidatePublication(delivery)).accepted).toBe(false);
  });
  it("rejects every contributor as reviewer and preserves rejection comments and revision CAS", async () => {
    const f = await fixture();
    let pkg = await draft(f);
    pkg = await studio.submit(f.ctx, pkg.id, { expectedRevision: pkg.revision });
    const dual = { ...f.ctx, roles: ["CONTENT_COORDINATOR", "CONTENT_APPROVER"] };
    await expect(
      studio.review(dual, pkg.id, {
        expectedRevision: pkg.revision,
        decision: "APPROVED",
        confirmTranscript: true,
        confirmTeachingIntegrity: true,
      }),
    ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
    await expect(
      studio.review(f.reviewer, pkg.id, {
        expectedRevision: pkg.revision,
        decision: "REJECTED",
        comment: " ",
      }),
    ).rejects.toThrow("INVALID_STUDIO_COMMENT");
    pkg = await studio.review(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "REJECTED",
      comment: "Keep complete source context.",
    });
    expect(pkg.status).toBe("CHANGES_REQUESTED");
    expect(pkg.feedback.at(-1)?.comment).toBe("Keep complete source context.");
    const editor = identity();
    pkg = await studio.revise(editor, pkg.id, {
      expectedRevision: pkg.revision,
      outputs: pkg.outputs.map((o) => ({
        id: o.id,
        title: o.title,
        body: o.body,
        included: o.included,
      })),
      comment: "Context reviewed",
    });
    await expect(
      studio.submit(editor, pkg.id, { expectedRevision: pkg.revision - 1 }),
    ).rejects.toThrow("REVISION_CONFLICT");
    await expect(studio.submit(editor, pkg.id, { expectedRevision: pkg.revision })).rejects.toThrow(
      "STUDIO_CORRECTIONS_PENDING",
    );
    pkg = await studio.enqueueGeneration(editor, pkg.id, { expectedRevision: pkg.revision });
    const correctionClaim = await claim(pkg);
    const correctionResult = await studio.completeGeneration(correctionClaim, {
      outputs: pkg.outputs.map((o) => ({
        ...o,
        correction: {
          ...(o.correction ??
            (() => {
              throw new Error("Missing correction");
            })()),
          state: "revised" as const,
        },
      })),
      provenance:
        pkg.provenance ??
        (() => {
          throw new Error("Missing provenance");
        })(),
    });
    if (!correctionResult.accepted) throw new Error(correctionResult.reason);
    pkg = await studio.submit(editor, pkg.id, {
      expectedRevision: correctionResult.package.revision,
    });
    await expect(
      studio.review({ ...editor, roles: ["CONTENT_COORDINATOR", "CONTENT_APPROVER"] }, pkg.id, {
        expectedRevision: pkg.revision,
        decision: "APPROVED",
        confirmTranscript: true,
        confirmTeachingIntegrity: true,
      }),
    ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
    expect(pkg.contributorIds).toEqual([f.ctx.userId, editor.userId]);
  });
  it("native review requires actual language qualification without granting it at runtime", async () => {
    const f = await fixture({ language: "te" });
    let pkg = await draft(f);
    pkg = await studio.submit(f.ctx, pkg.id, { expectedRevision: pkg.revision });
    const input = {
      expectedRevision: pkg.revision,
      decision: "APPROVED" as const,
      confirmTranscript: true,
      confirmTeachingIntegrity: true,
    };
    await expect(studio.review(f.reviewer, pkg.id, input)).rejects.toThrow(
      "NATIVE_REVIEWER_REQUIRED",
    );
    await migration.query(
      "INSERT INTO distribution.native_reviewer(user_id,is_test,language,granted_by) VALUES($1,$2,'te','local-test')",
      [f.reviewer.userId, true],
    );
    pkg = await studio.review(f.reviewer, pkg.id, input);
    expect(pkg.status).toBe("APPROVED");
    await migration.query(
      "DELETE FROM distribution.native_reviewer WHERE user_id=$1 AND is_test=true AND language='te'",
      [f.reviewer.userId],
    );
    await expect(
      studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision }),
    ).rejects.toThrow("NATIVE_REVIEWER_REQUIRED");
  });
  it("rejects forged assets, missing branding and source replacement during generation", async () => {
    const f = await fixture();
    const c = await claim(f.pkg);
    const bad = generated(f.pkg);
    if (!bad.outputs[0]?.asset) throw new Error("MISSING_TEST_ASSET");
    bad.outputs[0].asset.storageKey = bad.outputs[0].asset.storageKey.replace(
      f.master.id,
      randomUUID(),
    );
    await expect(studio.completeGeneration(c, bad)).rejects.toThrow("INVALID_STUDIO_ASSET");
    const copy = generated(f.pkg);
    if (!copy.outputs[0]) throw new Error("MISSING_TEST_OUTPUT");
    copy.outputs[0].body = "Missing branding";
    await expect(studio.completeGeneration(c, copy)).rejects.toThrow("INVALID_STUDIO_COPY");
    await content.updateMetadata(f.ctx, f.master.id, {
      expectedRevision: f.master.revision,
      title: "Changed meaning",
      language: "en",
      category: "other",
    });
    expect(await studio.completeGeneration(c, generated(f.pkg))).toEqual({
      accepted: false,
      reason: "SOURCE_DEPENDENCY_CHANGED",
    });
  });
  it("refuses curator edits, regeneration and discard after submission or approval", async () => {
    for (const approve of [false, true]) {
      const f = await fixture();
      let pkg = await draft(f);
      pkg = await studio.submit(f.ctx, pkg.id, { expectedRevision: pkg.revision });
      if (approve)
        pkg = await studio.review(f.reviewer, pkg.id, {
          expectedRevision: pkg.revision,
          decision: "APPROVED",
          confirmTranscript: true,
          confirmTeachingIntegrity: true,
        });
      for (const outputId of [undefined, pkg.outputs[0]?.id])
        await expect(
          studio.discard(f.ctx, pkg.id, { expectedRevision: pkg.revision, outputId }),
        ).rejects.toThrow("FORBIDDEN");
      await expect(
        studio.revise(f.ctx, pkg.id, {
          expectedRevision: pkg.revision,
          outputs: pkg.outputs.map(({ id, title, body, included }) => ({
            id,
            title,
            body,
            included,
          })),
          comment: "Must be returned first",
        }),
      ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
      await expect(
        studio.enqueueGeneration(f.ctx, pkg.id, { expectedRevision: pkg.revision }),
      ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
      expect((await studio.get(f.ctx, pkg.id)).revision).toBe(pkg.revision);
    }
  });
  it("records a curator changing draft selection as a contributor who cannot approve that work", async () => {
    const f = await fixture();
    const editor = identity();
    let pkg = await draft(f);
    pkg = await studio.discard(editor, pkg.id, {
      expectedRevision: pkg.revision,
      outputId: pkg.outputs[0]?.id,
    });
    expect(pkg.status).toBe("DRAFT");
    expect(pkg.contributorIds).toEqual([f.ctx.userId, editor.userId]);
    pkg = await studio.submit(editor, pkg.id, { expectedRevision: pkg.revision });
    await expect(
      studio.review({ ...editor, roles: ["CONTENT_COORDINATOR", "CONTENT_APPROVER"] }, pkg.id, {
        expectedRevision: pkg.revision,
        decision: "APPROVED",
        confirmTranscript: true,
        confirmTeachingIntegrity: true,
      }),
    ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
  });
  it("keeps submitted output exclusions in review so the approver can approve the remaining files directly", async () => {
    const f = await fixture();
    let pkg = await draft(f);
    pkg = await studio.submit(f.ctx, pkg.id, { expectedRevision: pkg.revision });
    const submittedRevision = pkg.revision;
    pkg = await studio.discard(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      outputId: pkg.outputs[0]?.id,
      comment: "Keep the complete article only.",
    });
    expect(pkg.status).toBe("IN_REVIEW");
    expect(pkg.revision).toBe(submittedRevision + 1);
    expect(pkg.contributorIds).toEqual([f.ctx.userId]);
    expect(pkg.feedback.at(-1)?.comment).toBe("Keep the complete article only.");
    await expect(
      studio.review(f.reviewer, pkg.id, {
        expectedRevision: submittedRevision,
        decision: "APPROVED",
        confirmTranscript: true,
        confirmTeachingIntegrity: true,
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    pkg = await studio.review(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "APPROVED",
      confirmTranscript: true,
      confirmTeachingIntegrity: true,
    });
    expect(pkg.approval?.revision).toBe(pkg.revision);
    expect(
      await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision }),
    ).toHaveLength(1);
  });
  it("atomically queues a manual media edit and keeps every other output unchanged", async () => {
    const f = await fixture({ channels: ["youtube", "website"] });
    const pkg = await draft(f);
    const output = pkg.outputs[0];
    if (!output) throw Error("MISSING_FIXTURE");
    const mediaEdits = {
      ...STUDIO_MEDIA_DEFAULTS,
      speechLevel: "louder" as const,
      captions: "off" as const,
    };
    const queued = await studio.revise(f.ctx, pkg.id, {
      expectedRevision: pkg.revision,
      render: true,
      comment: "Correct the audio on this file only.",
      outputs: [
        { id: output.id, title: output.title, body: output.body, included: true, mediaEdits },
      ],
    });
    expect(queued.status).toBe("QUEUED");
    expect(queued.generation).toEqual({ outputIds: [output.id], mode: "render" });
    expect(queued.outputs[0]).toMatchObject({
      mediaEdits,
      asset: null,
      aiReview: null,
      presentationReview: null,
    });
    expect(queued.outputs[1]).toEqual(pkg.outputs[1]);
    expect(queued.approval).toBeNull();
    await expect(
      studio.revise(f.ctx, pkg.id, {
        expectedRevision: pkg.revision,
        render: true,
        comment: "",
        outputs: [{ ...output, mediaEdits }],
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
  });
  it("queues only the trimmed file, retains source evidence and rejects out-of-source cuts", async () => {
    const f = await fixture({ channels: ["youtube", "website"] });
    const pkg = await draft(f);
    const output = pkg.outputs[0];
    if (!output) throw Error("MISSING_FIXTURE");
    await expect(
      studio.revise(f.ctx, pkg.id, {
        expectedRevision: pkg.revision,
        comment: "",
        outputs: [{ ...output, sourceTrim: { startMs: 0, endMs: 4000 } }],
      }),
    ).rejects.toThrow("INVALID_STUDIO_TRIM");
    expect(await studio.get(f.ctx, pkg.id)).toEqual(pkg);
    const trimmed = await studio.revise(f.ctx, pkg.id, {
      expectedRevision: pkg.revision,
      render: true,
      comment: "Remove the opening greeting",
      outputs: [
        {
          ...output,
          sourceTrim: { startMs: 500, endMs: 2000 },
          captionCues: [{ id: "one", startMs: 500, endMs: 2000, text: "Teaching." }],
        },
      ],
    });
    expect(trimmed.generation).toEqual({ outputIds: [output.id], mode: "render" });
    expect(trimmed.outputs[0]).toMatchObject({
      startMs: 500,
      endMs: 2000,
      sourceTrim: { startMs: 500, endMs: 2000 },
      asset: null,
      aiReview: null,
    });
    expect(trimmed.outputs[1]).toEqual(pkg.outputs[1]);
    expect(trimmed.provenance).toEqual(pkg.provenance);
  });
  it("rolls back an edit if its rebuild cannot be queued", async () => {
    const f = await fixture();
    const pkg = await draft(f);
    const output = pkg.outputs[0];
    if (!output) throw Error("MISSING_FIXTURE");
    await expect(
      studio.revise(f.ctx, pkg.id, {
        expectedRevision: pkg.revision,
        render: true,
        comment: "",
        outputs: [{ ...output, body: "Edited copy. @sgsswamiji", included: false }],
      }),
    ).rejects.toThrow("STUDIO_SELECT_OUTPUTS");
    expect(await studio.get(f.ctx, pkg.id)).toEqual(pkg);
  });
  it("rejects media changes on approved packages and invalid settings on drafts", async () => {
    const f = await fixture({ channels: ["youtube"] });
    const pkg = await draft(f);
    const output = pkg.outputs[0];
    if (!output) throw Error("MISSING_FIXTURE");
    await expect(
      studio.revise(f.ctx, pkg.id, {
        expectedRevision: pkg.revision,
        comment: "",
        outputs: [{ ...output, mediaEdits: { ...STUDIO_MEDIA_DEFAULTS, portraitFocus: 2 } }],
      }),
    ).rejects.toThrow("INVALID_STUDIO_MEDIA_EDITS");
    expect(await studio.get(f.ctx, pkg.id)).toEqual(pkg);
    const pending = await studio.submit(f.ctx, pkg.id, { expectedRevision: pkg.revision });
    const approved = await studio.review(f.reviewer, pkg.id, {
      expectedRevision: pending.revision,
      decision: "APPROVED",
      confirmTranscript: true,
      confirmTeachingIntegrity: true,
    });
    await expect(
      studio.revise(f.ctx, pkg.id, {
        expectedRevision: approved.revision,
        render: true,
        comment: "",
        outputs: [{ ...output, mediaEdits: { ...STUDIO_MEDIA_DEFAULTS, speechLevel: "louder" } }],
      }),
    ).rejects.toThrow("INVALID_STUDIO_TRANSITION");
  });
  it("saves a translated clip correction before replacement caption assets exist, then queues only that file", async () => {
    const f = await fixture({ channels: ["youtube", "website"], outputLanguages: ["te"] });
    const result = generated(f.pkg);
    const output = result.outputs[0];
    const segment = result.provenance.transcript.segments[0];
    if (!output || !segment) throw new Error("MISSING_FIXTURE");
    output.captionCues = [{ ...segment, text: "మంచి మాట." }];
    output.captions = [
      {
        language: "te",
        translated: true,
        asset: {
          ...studioAssetName(
            {
              masterId: f.pkg.source.masterId,
              sourceVersionId: f.pkg.source.versionId,
              packageId: f.pkg.id,
              outputId: output.id,
              channel: output.channel,
              format: output.format,
              language: output.language,
              aspect: output.aspect,
            },
            "vtt",
            "te",
          ),
          sha256: "d".repeat(64),
          byteSize: 100,
          mimeType: "text/vtt",
        },
      },
    ];
    output.thumbnail = {
      ...studioAssetName(
        {
          masterId: f.pkg.source.masterId,
          sourceVersionId: f.pkg.source.versionId,
          packageId: f.pkg.id,
          outputId: output.id,
          channel: output.channel,
          format: output.format,
          language: output.language,
          aspect: output.aspect,
        },
        "png",
      ),
      sha256: "f".repeat(64),
      byteSize: 100,
      mimeType: "image/png",
    };
    const completed = await studio.completeGeneration(await claim(f.pkg), result);
    if (!completed.accepted) throw new Error(completed.reason);
    const edited = await studio.revise(f.ctx, f.pkg.id, {
      expectedRevision: completed.package.revision,
      comment: "Correct the translated caption while retaining source timing.",
      outputs: [
        {
          id: output.id,
          title: output.title,
          body: output.body,
          included: true,
          sourceSegmentIds: [segment.id],
          captionCues: [{ ...segment, text: "సరిచేసిన మంచి మాట." }],
        },
      ],
    });
    expect(edited.outputs[0]).toMatchObject({ asset: null, captions: [], aiReview: null });
    expect(edited.outputs[0]).not.toHaveProperty("thumbnail");
    expect(edited.outputs[1]).toEqual(completed.package.outputs[1]);
    await expect(
      studio.submit(f.ctx, edited.id, { expectedRevision: edited.revision }),
    ).rejects.toThrow("ASSETS_REQUIRE_REGENERATION");
    const queued = await studio.enqueueGeneration(f.ctx, edited.id, {
      expectedRevision: edited.revision,
      outputIds: [output.id],
      mode: "render",
    });
    expect(queued.generation).toEqual({ outputIds: [output.id], mode: "render" });
    expect(queued.approval).toBeNull();
  });
  it("curator draft edits require regeneration of changed embedded copy before review", async () => {
    const f = await fixture();
    const pkg = await draft(f);
    await expect(
      studio.getOutputAsset(f.ctx, pkg.id, pkg.outputs[0]?.id ?? "", {
        kind: "asset",
        forExport: true,
      }),
    ).rejects.toThrow("FORBIDDEN");
    const edited = await studio.revise(f.ctx, pkg.id, {
      expectedRevision: pkg.revision,
      outputs: pkg.outputs.map((o) => ({
        id: o.id,
        title: o.title,
        body: "Revised. @sgsswamiji",
        included: o.included,
      })),
      comment: "Change text",
    });
    expect(edited.approval).toBeNull();
    expect(edited.outputs.every((o) => o.asset === null)).toBe(true);
    await expect(
      studio.submit(f.ctx, pkg.id, { expectedRevision: edited.revision }),
    ).rejects.toThrow("ASSETS_REQUIRE_REGENERATION");
    await expect(
      studio.publish(f.reviewer, pkg.id, { expectedRevision: edited.revision }),
    ).rejects.toThrow("STUDIO_NOT_APPROVED");
  });
  it("retains a legacy closing destination when manual edits invalidate its review", async () => {
    const f = await fixture({ channels: ["youtube"] });
    const result = generated(f.pkg);
    const output = result.outputs[0];
    if (!output?.asset) throw Error("MISSING_OUTPUT");
    output.presentationReview = {
      policy: "source-safe-portrait-v1",
      sourceSha256: f.pkg.source.sha256,
      renderedSha256: output.asset.sha256,
      fileVersion: 1,
      model: "fixture",
      reviewedAt: new Date().toISOString(),
      framing: "full-picture",
      repairs: 0,
      source: {
        openingComplete: true,
        endingComplete: true,
        naturalStart: true,
        naturalEnd: true,
        reason: "Fixture",
        scenes: [],
      },
      checks: {
        illustrationsRelevant: true,
        textIntact: true,
        subjectIntact: true,
        captionsClear: true,
        naturalBoundaries: true,
        reason: "Fixture",
      },
      closingCard: studioClosingCardPlan(2000, { destination: "youtube" }),
    };
    const completed = await studio.completeGeneration(await claim(f.pkg), result);
    if (!completed.accepted) throw Error(completed.reason);
    const corrected = await studio.revise(f.ctx, f.pkg.id, {
      expectedRevision: completed.package.revision,
      comment: "Adjust speech level only",
      outputs: [
        {
          id: output.id,
          title: output.title,
          body: output.body,
          included: true,
          mediaEdits: { ...STUDIO_MEDIA_DEFAULTS, speechLevel: "louder" },
        },
      ],
    });
    expect(corrected.outputs[0]).toMatchObject({
      closingDestination: "youtube",
      presentationReview: null,
      asset: null,
    });
    const queued = await studio.enqueueGeneration(f.ctx, f.pkg.id, {
      expectedRevision: corrected.revision,
      outputIds: [output.id],
      mode: "render",
    });
    expect(queued.outputs[0]?.closingDestination).toBe("youtube");
  });
  it("permits review and export but refuses publishing to an uncreated closing-card channel", async () => {
    const f = await fixture({ channels: ["youtube"] });
    const result = generated(f.pkg);
    const output = result.outputs[0];
    if (!output?.asset) throw Error("MISSING_OUTPUT");
    output.presentationReview = {
      policy: "source-safe-portrait-v1",
      sourceSha256: f.pkg.source.sha256,
      renderedSha256: output.asset.sha256,
      fileVersion: 1,
      model: "fixture",
      reviewedAt: new Date().toISOString(),
      framing: "full-picture",
      repairs: 0,
      source: {
        openingComplete: true,
        endingComplete: true,
        naturalStart: true,
        naturalEnd: true,
        reason: "Fixture",
        scenes: [],
      },
      checks: {
        illustrationsRelevant: true,
        textIntact: true,
        subjectIntact: true,
        captionsClear: true,
        naturalBoundaries: true,
        reason: "Fixture",
      },
      closingCard: studioClosingCardPlan(2000, { destination: "youtube" }),
    };
    const completed = await studio.completeGeneration(await claim(f.pkg), result);
    if (!completed.accepted) throw Error(completed.reason);
    let pkg = await studio.submit(f.ctx, f.pkg.id, {
      expectedRevision: completed.package.revision,
    });
    pkg = await studio.review(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "APPROVED",
      confirmTranscript: true,
      confirmTeachingIntegrity: true,
    });
    await expect(
      studio.getOutputAsset(f.reviewer, pkg.id, output.id, { kind: "asset", forExport: true }),
    ).resolves.toBeTruthy();
    await expect(
      studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision }),
    ).rejects.toThrow("STUDIO_CLOSING_CHANNEL_REQUIRED");
    expect(await studio.listPublications(f.reviewer, pkg.id)).toEqual([]);
  });
  it("pins the chosen publishing destination and refuses retargeting on retry", async () => {
    const f = await fixture();
    const pkg = await approved(f);
    const accounts = Object.fromEntries(
      pkg.outputs.filter((o) => o.included).map((o) => [o.channel, "chosen-account"]),
    );
    const jobs = await studio.publish(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      accounts,
    });
    expect(jobs.every((job) => job.accountId === "chosen-account")).toBe(true);
    expect(
      (await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision, accounts })).map(
        (job) => job.id,
      ),
    ).toEqual(jobs.map((job) => job.id));
    await expect(
      studio.publish(f.reviewer, pkg.id, {
        expectedRevision: pkg.revision,
        accounts: Object.fromEntries(
          Object.keys(accounts).map((channel) => [channel, "different-account"]),
        ),
      }),
    ).rejects.toThrow("STUDIO_PUBLISH_ACCOUNT_CHANGED");
    expect(
      (await studio.listPublications(f.reviewer, pkg.id)).every(
        (job) => job.accountId === "chosen-account",
      ),
    ).toBe(true);
  });
  it("atomically reserves duplicate files across packages, keeping uncertain sends blocked", async () => {
    const first = await fixture({ channels: ["x"] });
    const second = await fixture({ channels: ["x"] });
    const p1 = await approved(first);
    const p2 = await approved(second);
    const j1 = await studio.publish(first.reviewer, p1.id, {
      expectedRevision: p1.revision,
      accounts: { x: "a" },
    });
    const j2 = await studio.publish(second.reviewer, p2.id, {
      expectedRevision: p2.revision,
      accounts: { x: "a" },
    });
    const c1 = await studio.claimPublication({
      isTest: true,
      workerId: "guard-one",
      publicationId: j1.find((j) => j.channel === "x")?.id,
    });
    const c2 = await studio.claimPublication({
      isTest: true,
      workerId: "guard-two",
      publicationId: j2.find((j) => j.channel === "x")?.id,
    });
    if (!c1 || !c2) throw Error("MISSING_CLAIM");
    expect(c1.output.asset?.sha256).toBe(c2.output.asset?.sha256);
    const check = {
      checkedAt: new Date().toISOString(),
      destination: "x:canonical",
      scanned: 20,
      error: null,
      matches: [],
    };
    const results = await Promise.all([
      studio.reservePublicationDestination(c1, "a", check),
      studio.reservePublicationDestination(c2, "a", check),
    ]);
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(results.find((r) => !r.allowed)?.check.matches[0]?.state).toBe("IN_PROGRESS");
    const winner = results[0]?.allowed ? c1 : c2;
    await studio.completePublication(winner, {
      status: "UNCERTAIN",
      error: "PUBLICATION_OUTCOME_UNKNOWN",
    });
    const history = await studio.checkPostingHistory(first.ctx, p1.id, "a", "x:canonical", "x");
    expect(
      Object.values(history)
        .flat()
        .some((m) => m.state === "NEEDS_REVIEW"),
    ).toBe(true);
  });
  it("can recover a failed external scan without pinning a fallback destination", async () => {
    const f = await fixture({ channels: ["x"] });
    const pkg = await approved(f);
    const jobs = await studio.publish(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      accounts: { x: "recovery-account" },
    });
    const first = await studio.claimPublication({
      isTest: true,
      workerId: "recover-check",
      publicationId: jobs[0]?.id,
    });
    if (!first) throw Error("MISSING_CLAIM");
    expect(
      (
        await studio.reservePublicationDestination(first, "recovery-account", {
          checkedAt: new Date().toISOString(),
          destination: "x:buffer:fallback",
          scanned: 0,
          matches: [],
          error: "STUDIO_POSTING_CHECK_UNAVAILABLE",
        })
      ).allowed,
    ).toBe(false);
    await studio.publish(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      accounts: { x: "recovery-account" },
    });
    const retry = await studio.claimPublication({
      isTest: true,
      workerId: "recover-check",
      publicationId: jobs[0]?.id,
    });
    if (!retry) throw Error("MISSING_RETRY");
    expect(
      (
        await studio.reservePublicationDestination(retry, "recovery-account", {
          checkedAt: new Date().toISOString(),
          destination: "x:recovered-channel",
          scanned: 20,
          matches: [],
          error: null,
        })
      ).allowed,
    ).toBe(true);
    await studio.completePublication(retry, { status: "SIMULATED" });
  });
  it("queues each approved output once and TEST cannot become live publication", async () => {
    const f = await fixture();
    const pkg = await approved(f);
    const first = await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    const second = await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));
    expect(first).toHaveLength(2);
    const c = await studio.claimPublication({
      isTest: true,
      workerId: "publish-test",
      publicationId: first[0]?.id,
    });
    if (!c) throw new Error("MISSING_CLAIM");
    expect((await studio.revalidatePublication(c)).accepted).toBe(true);
    await expect(
      studio.completePublication(c, { status: "PUBLISHED", remoteId: "not-real" }),
    ).rejects.toThrow("INVALID_PUBLICATION_RESULT");
    expect(
      (await studio.completePublication(c, { status: "SIMULATED", accountId: "local-test" }))
        .status,
    ).toBe("SIMULATED");
    await expect(studio.publicationMedia(c.publication.id)).rejects.toThrow("NOT_FOUND");
    await expect(studio.publishedBlog(c.publication.id)).rejects.toThrow("NOT_FOUND");
    expect(await studio.listPublications(f.reviewer, pkg.id)).not.toHaveProperty("checkpoint");
  });
  it("changed source, withdrawn approval or revoked people block dispatch after enqueue", async () => {
    const f = await fixture();
    const pkg = await approved(f);
    const queued = await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    roles.set(`${f.reviewer.isTest}:${f.reviewer.userId}`, []);
    expect(
      await studio.claimPublication({
        isTest: true,
        workerId: "publish-test",
        publicationId: queued[0]?.id,
      }),
    ).toBeNull();
    expect((await studio.listPublications(f.reviewer, pkg.id))[0]?.error).toBe(
      "REVIEWER_ROLE_REVOKED",
    );
    roles.set(`${f.reviewer.isTest}:${f.reviewer.userId}`, f.reviewer.roles);
    await content.withdraw(f.reviewer, f.master.id, { expectedRevision: f.master.revision });
    expect(
      await studio.claimPublication({
        isTest: true,
        workerId: "publish-test",
        publicationId: queued[1]?.id,
      }),
    ).toBeNull();
  });
  it("approver exclusion reopens exact revision review, cancels stale dispatch and excludes omitted exports", async () => {
    const f = await fixture();
    let pkg = await approved(f);
    const queued = await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    const excluded = pkg.outputs[0]?.id;
    if (!excluded) throw new Error("MISSING_OUTPUT");
    pkg = await studio.discard(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      outputId: excluded,
      comment: "Keep the full blog only",
    });
    expect(pkg.approval).toBeNull();
    expect(pkg.contributorIds).toEqual([f.ctx.userId]);
    expect(pkg.status).toBe("IN_REVIEW");
    await expect(
      studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision }),
    ).rejects.toThrow("STUDIO_NOT_APPROVED");
    for (const publication of queued)
      expect(
        await studio.claimPublication({
          isTest: true,
          workerId: "stale-exclusion-test",
          publicationId: publication.id,
        }),
      ).toBeNull();

    pkg = await studio.review(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "APPROVED",
      confirmTranscript: true,
      confirmTeachingIntegrity: true,
    });
    await expect(
      studio.getOutputAsset(f.reviewer, pkg.id, excluded, { kind: "asset", forExport: true }),
    ).rejects.toThrow("OUTPUT_EXCLUDED");
    expect(
      await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision }),
    ).toHaveLength(1);
    pkg = await studio.discard(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    await expect(studio.getOutputAsset(f.ctx, pkg.id, excluded, { kind: "asset" })).rejects.toThrow(
      "STUDIO_DISCARDED",
    );
  });
  it("explicit Publish safely retries a blocked target once and never repeats completed targets", async () => {
    const f = await fixture();
    const pkg = await approved(f);
    const queued = await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    const first = await studio.claimPublication({
      isTest: true,
      workerId: "publish-test",
      publicationId: queued[0]?.id,
    });
    if (!first) throw new Error("MISSING_CLAIM");
    await studio.completePublication(first, {
      status: "BLOCKED",
      error: "STUDIO_ACCOUNT_NOT_CONFIGURED",
    });
    const retried = await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    expect(retried.map((value) => value.id)).toEqual(queued.map((value) => value.id));
    expect(retried.find((value) => value.id === first.publication.id)?.status).toBe("QUEUED");
    const second = await studio.claimPublication({
      isTest: true,
      workerId: "publish-test",
      publicationId: first.publication.id,
    });
    if (!second) throw new Error("MISSING_CLAIM");
    await studio.completePublication(second, { status: "SIMULATED" });
    const repeated = await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    expect(repeated.find((value) => value.id === first.publication.id)?.status).toBe("SIMULATED");
    expect(
      await studio.claimPublication({
        isTest: true,
        workerId: "publish-test",
        publicationId: first.publication.id,
      }),
    ).toBeNull();
    expect(
      (
        await migration.query(
          "SELECT count(*)::int AS total FROM distribution.studio_publication_attempt WHERE publication_id=$1 AND detail->>'action'='EXPLICIT_RETRY'",
          [first.publication.id],
        )
      ).rows[0]?.total,
    ).toBe(1);
  });
  it("expired publication leases become uncertain and never repeat the create operation", async () => {
    const f = await fixture();
    const pkg = await approved(f);
    const queued = await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    const c = await studio.claimPublication({
      isTest: true,
      workerId: "publish-test",
      publicationId: queued[0]?.id,
    });
    if (!c) throw new Error("MISSING_CLAIM");
    await runtime.query(
      "UPDATE distribution.studio_publication_job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [c.publication.id],
    );
    expect(
      await studio.claimPublication({
        isTest: true,
        workerId: "replacement",
        publicationId: c.publication.id,
      }),
    ).toBeNull();
    expect((await studio.listPublications(f.reviewer, pkg.id))[0]?.status).toBe("UNCERTAIN");
    await expect(studio.completePublication(c, { status: "SIMULATED" })).rejects.toThrow(
      "STUDIO_LEASE_LOST",
    );
  });
  it("production polling resumes only an existing remote checkpoint; secret checkpoint is internal", async () => {
    const f = await fixture({ isTest: false });
    const pkg = await approved(f);
    const queued = await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    const c = await studio.claimPublication({
      isTest: false,
      workerId: "offline-provider",
      publicationId: queued[0]?.id,
    });
    if (!c) throw new Error("MISSING_CLAIM");
    await studio.completePublication(c, {
      status: "PROCESSING",
      remoteId: "existing-job",
      checkpoint: { providerJobId: "existing-job", privateToken: "not-a-real-token" },
      retryAfterSeconds: 1,
    });
    await runtime.query(
      "UPDATE distribution.studio_publication_job SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [c.publication.id],
    );
    const resumed = await studio.claimPublication({
      isTest: false,
      workerId: "offline-provider",
      publicationId: c.publication.id,
    });
    if (!resumed) throw new Error("MISSING_CLAIM");
    expect(resumed.checkpoint).toEqual({
      providerJobId: "existing-job",
      privateToken: "not-a-real-token",
    });
    expect(resumed.publication.remoteId).toBe("existing-job");
    expect(JSON.stringify(await studio.listPublications(f.reviewer, pkg.id))).not.toContain(
      "privateToken",
    );
    await studio.completePublication(resumed, {
      status: "PUBLISHED",
      remoteUrl: "https://example.test/post",
    });
    expect((await studio.publicationMedia(resumed.publication.id)).output.id).toBe(
      resumed.output.id,
    );
  });
  it("runtime cannot rewrite immutable provenance, review history, source pins or queued identity", async () => {
    const f = await fixture();
    const pkg = await approved(f);
    const queued = await studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision });
    for (const sql of [
      "UPDATE distribution.studio_revision SET snapshot='{}' WHERE package_id=$1",
      "DELETE FROM distribution.studio_feedback WHERE package_id=$1",
      "UPDATE distribution.studio_package SET created_by='forged' WHERE id=$1",
      "UPDATE distribution.studio_generation_job SET requested_by='forged' WHERE package_id=$1",
    ]) {
      await expect(runtime.query(sql, [pkg.id])).rejects.toThrow(/permission denied/);
    }
    await expect(
      runtime.query(
        "UPDATE distribution.studio_publication_job SET package_revision=1 WHERE id=$1",
        [queued[0]?.id],
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it("approved transcript lineage must stay current and cannot be forged by a worker", async () => {
    const f = await fixture();
    let transcript = await editorial.createTranscript(f.ctx, f.master.id, {
      expectedSourceVersionId: f.master.currentVersion.id,
      language: "en",
      durationMs: 2000,
      segments: [
        {
          id: "one",
          startMs: 0,
          endMs: 2000,
          originalText: "Synthetic teaching.",
          displayText: "Synthetic teaching.",
        },
      ],
      provenance: {
        provider: "manual",
        model: null,
        promptVersion: null,
        schemaVersion: 1,
        recipeVersion: "test",
      },
    });
    transcript = await editorial.reviewTranscript(f.reviewer, transcript.id, {
      expectedRevision: 1,
      decision: "APPROVED",
    });
    const c = await claim(f.pkg);
    expect(c.transcript?.sourceTranscriptId).toBe(transcript.id);
    const result = generated(f.pkg);
    if (!c.transcript) throw new Error("MISSING_TRANSCRIPT");
    result.provenance.transcript = c.transcript;
    const fake = structuredClone(result);
    if (!fake.provenance.transcript.segments[0]) throw new Error("MISSING_SEGMENT");
    fake.provenance.transcript.segments[0].text = "Forged";
    await expect(studio.completeGeneration(c, fake)).rejects.toThrow("TRANSCRIPT_SUPERSEDED");
    const done = await studio.completeGeneration(c, result);
    if (!done.accepted) throw new Error(done.reason);
    let pkg = await studio.submit(f.ctx, done.package.id, {
      expectedRevision: done.package.revision,
    });
    pkg = await studio.review(f.reviewer, pkg.id, {
      expectedRevision: pkg.revision,
      decision: "APPROVED",
      confirmTeachingIntegrity: true,
    });
    await editorial.reviewTranscript(f.reviewer, transcript.id, {
      expectedRevision: transcript.revision,
      decision: "REJECTED",
    });
    await expect(
      studio.publish(f.reviewer, pkg.id, { expectedRevision: pkg.revision }),
    ).rejects.toThrow("TRANSCRIPT_SUPERSEDED");
  });
});

import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DistributionRoleAuthority,
  createDistributionActivationRepository,
  createDistributionEditorialRepository,
  createDistributionOutreachRepository,
  createDistributionRenderRepository,
  createDistributionRepository,
  provisionDistributionCapabilities,
} from "@satsang/distribution-db";
import { trackedLinkDecision } from "@satsang/distribution-domain";
import {
  createSignedLinkCachePublisher,
  createSignedLinkCacheReader,
} from "@satsang/distribution-links/cache";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLinkDeliveryOnce, runLinkRefreshOnce } from "./link-jobs";
import { createLocalRenderer } from "./renderer";
import { runRenderJob } from "./run-render-job";
const suite = process.env.DISTRIBUTION_RUN_DB_TESTS === "1" ? describe : describe.skip;
const ffmpegPath =
  process.env.DISTRIBUTION_TEST_FFMPEG ??
  (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
const ffprobePath =
  process.env.DISTRIBUTION_TEST_FFPROBE ??
  (existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "/usr/bin/ffprobe");
suite("DS-DIST-R3 complete local render path", () => {
  let admin: Pool;
  let migration: Pool;
  let runtime: Pool;
  let root: string;
  let content: ReturnType<typeof createDistributionRepository>;
  let editorial: ReturnType<typeof createDistributionEditorialRepository>;
  let jobs: ReturnType<typeof createDistributionRenderRepository>;
  const currentRoles = new Map<string, readonly string[]>();
  const authorize: DistributionRoleAuthority = async ({ userId, isTest, capability }) => {
    const roles = currentRoles.get(userId) ?? [];
    return (
      isTest &&
      (capability === "content.create"
        ? roles.includes("CONTENT_COORDINATOR")
        : roles.includes("CONTENT_APPROVER"))
    );
  };
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `distribution_worker_${suffix}`;
  const migrationRole = `dist_worker_m_${suffix}`;
  const runtimeRole = `dist_worker_r_${suffix}`;
  let asset: {
    storageKey: string;
    sha256: string;
    byteSize: number;
    mimeType: string;
    originalName: string;
  };
  beforeAll(async () => {
    const base = new URL(process.env.DISTRIBUTION_TEST_ADMIN_URL ?? "");
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      !base.pathname.startsWith("/content_studio_separation_test_") ||
      base.search
    )
      throw new Error("LOCAL_DATABASE_REQUIRED");
    admin = new Pool({ connectionString: base.toString() });
    const mp = randomUUID();
    const rp = randomUUID();
    await admin.query(
      `CREATE ROLE ${migrationRole} LOGIN PASSWORD '${mp}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await admin.query(
      `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${rp}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await admin.query(`CREATE DATABASE ${database} OWNER ${migrationRole}`);
    const url = new URL(base);
    url.pathname = `/${database}`;
    url.username = migrationRole;
    url.password = mp;
    migration = new Pool({ connectionString: url.toString() });
    await migrate(drizzle(migration), {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/distribution-db/drizzle", import.meta.url),
      ),
      migrationsSchema: "distribution_migrations",
      migrationsTable: "__distribution_migrations",
    });
    await migration.query(
      (
        await readFile(
          new URL("../../../packages/distribution-db/ops/runtime-grants.sql", import.meta.url),
          "utf8",
        )
      ).replaceAll(":'distribution_runtime_role'", `'${runtimeRole}'`),
    );
    url.username = runtimeRole;
    url.password = rp;
    runtime = new Pool({ connectionString: url.toString(), max: 2 });
    content = createDistributionRepository(runtime);
    editorial = createDistributionEditorialRepository(runtime);
    jobs = createDistributionRenderRepository(runtime, { authorize });
    root = await mkdtemp(join(realpathSync(tmpdir()), "distribution-worker-e2e-"));
    await mkdir(join(root, "distribution", "masters"), { recursive: true, mode: 0o700 });
    const storageKey = `distribution/masters/${randomUUID()}`;
    execFileSync(
      ffmpegPath,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        join(root, storageKey),
      ],
      { timeout: 15000 },
    );
    await chmod(join(root, storageKey), 0o600);
    const bytes = await readFile(join(root, storageKey));
    asset = {
      storageKey,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      mimeType: "video/mp4",
      originalName: "synthetic-only.mp4",
    };
  }, 20000);
  afterAll(async () => {
    await runtime?.end();
    await migration?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}; DROP ROLE IF EXISTS ${migrationRole}`);
      await admin.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture(aspect: "16:9" | "9:16" | "4:5" | "1:1" = "16:9") {
    const ctx = { userId: randomUUID(), isTest: true, roles: ["SUPER_ADMIN", "CONTENT_APPROVER"] };
    const creator = { userId: randomUUID(), isTest: true, roles: ["CONTENT_COORDINATOR"] };
    const reviewer = { userId: randomUUID(), isTest: true, roles: ["CONTENT_APPROVER"] };
    for (const identity of [ctx, creator, reviewer])
      currentRoles.set(identity.userId, identity.roles);
    const ownAsset = { ...asset, storageKey: `distribution/masters/${randomUUID()}` };
    // Each fixture needs distinct real bytes now that master uploads deduplicate by SHA-256.
    execFileSync(
      ffmpegPath,
      [
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        join(root, asset.storageKey),
        "-c",
        "copy",
        "-metadata",
        `comment=synthetic-fixture-${randomUUID()}`,
        "-f",
        "mp4",
        join(root, ownAsset.storageKey),
      ],
      { timeout: 15000 },
    );
    await chmod(join(root, ownAsset.storageKey), 0o600);
    const ownBytes = await readFile(join(root, ownAsset.storageKey));
    ownAsset.sha256 = createHash("sha256").update(ownBytes).digest("hex");
    ownAsset.byteSize = ownBytes.length;
    let master = await content.create(creator, {
      title: "Explicit synthetic test",
      language: "en",
      category: "other",
      asset: ownAsset,
    });
    master = await content.attestRights(creator, master.id, {
      expectedRevision: master.revision,
      rights: {
        owner: "SGS test",
        territories: ["WORLDWIDE"],
        channels: ["manual_export"],
        authorizationBasis: "Synthetic local fixture",
        privacyClass: "PUBLIC",
        releaseAt: null,
        expiresAt: null,
      },
    });
    master = await content.approve(ctx, master.id, { expectedRevision: master.revision });
    let transcript = await editorial.createTranscript(creator, master.id, {
      expectedSourceVersionId: master.currentVersion.id,
      language: "en",
      durationMs: 2000,
      segments: [
        {
          id: "one",
          startMs: 400,
          endMs: 1600,
          originalText: "Synthetic test only",
          displayText: "Synthetic test only",
        },
      ],
      provenance: {
        provider: "manual",
        model: null,
        promptVersion: null,
        schemaVersion: 1,
        recipeVersion: "manual-v1",
      },
    });
    transcript = await editorial.reviewTranscript(ctx, transcript.id, {
      expectedRevision: 1,
      decision: "APPROVED",
    });
    const job = await jobs.enqueue(creator, {
      masterId: master.id,
      expectedSourceRevision: master.revision,
      transcriptVersionId: transcript.id,
      quoteId: null,
      translationId: null,
      template: { id: "contained-preview-v1", version: 1 },
      aspect,
      language: "en",
      startMs: 400,
      endMs: 1600,
      captionMode: "approved_transcript",
      channel: "manual_export",
      territory: "WORLDWIDE",
    });
    return { ctx, creator, reviewer, master, job };
  }
  it.each([
    { aspect: "16:9", width: 1920, height: 1080 },
    { aspect: "9:16", width: 1080, height: 1920 },
    { aspect: "4:5", width: 1080, height: 1350 },
    { aspect: "1:1", width: 1080, height: 1080 },
  ] as const)(
    "DS-DIST-R3-E2E renders, commits and approves $aspect",
    async ({ aspect, width, height }) => {
      const f = await fixture(aspect);
      const renderer = createLocalRenderer({ root, ffmpegPath, ffprobePath });
      expect(
        await runRenderJob({
          repository: jobs,
          renderer,
          workerId: "e2e-one",
          signal: new AbortController().signal,
        }),
      ).toEqual({ status: "rendered", jobId: f.job.id });
      expect((await jobs.getJob(f.ctx, f.job.id)).status).toBe("SUCCEEDED");
      const listed = await jobs.listArtifacts(f.ctx, f.master.id);
      if (!listed[0]) throw new Error("TEST_ARTIFACT_MISSING");
      const { artifact, eligibility } = listed[0];
      expect(eligibility).toEqual({ allowed: false, reason: "ARTIFACT_NOT_APPROVED" });
      const metadata = JSON.parse(
        execFileSync(
          ffprobePath,
          [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            join(root, artifact.output.video.storageKey),
          ],
          { encoding: "utf8", timeout: 10000 },
        ),
      );
      const video = metadata.streams.find(
        (stream: { codec_type: string }) => stream.codec_type === "video",
      );
      const audio = metadata.streams.find(
        (stream: { codec_type: string }) => stream.codec_type === "audio",
      );
      expect([video.width, video.height]).toEqual([width, height]);
      expect(Math.abs(Number(video.duration) - 1.2)).toBeLessThanOrEqual(0.05);
      expect(audio.codec_name).toBe("aac");
      expect(f.job.recipe.aspect).toBe(aspect);

      expect(
        createHash("sha256")
          .update(await readFile(join(root, artifact.output.video.storageKey)))
          .digest("hex"),
      ).toBe(artifact.output.video.sha256);
      if (!artifact.output.captions) throw new Error("TEST_CAPTIONS_MISSING");
      expect(await readFile(join(root, artifact.output.captions.storageKey), "utf8")).toContain(
        "Synthetic test only",
      );
      const reviewed = await jobs.reviewArtifact(f.ctx, artifact.id, {
        expectedRevision: 1,
        expectedRecipeSha256: artifact.recipeSha256,
        expectedAssetSha256: artifact.output.video.sha256,
        decision: "APPROVED",
      });
      expect((await jobs.getArtifact(f.ctx, reviewed.id)).eligibility).toEqual({ allowed: true });
      expect(
        await runRenderJob({
          repository: jobs,
          renderer,
          workerId: "e2e-two",
          signal: new AbortController().signal,
        }),
      ).toEqual({ status: "idle" });
    },
  );
  it("DS-DIST-R3-E2E source withdrawal after encoding removes only rejected output", async () => {
    const f = await fixture();
    const local = createLocalRenderer({ root, ffmpegPath, ffprobePath });
    let video = "";
    const renderer = {
      ...local,
      render: async (input: Parameters<typeof local.render>[0]) => {
        const result = await local.render(input);
        video = result.video.storageKey;
        await content.withdraw(f.ctx, f.master.id, { expectedRevision: f.master.revision });
        return result;
      },
    };
    const result = await runRenderJob({
      repository: jobs,
      renderer,
      workerId: "e2e-stale",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("stale");
    expect((await jobs.getJob(f.ctx, f.job.id)).status).toBe("STALE");
    expect(await jobs.listArtifacts(f.ctx, f.master.id)).toEqual([]);
    await expect(readFile(join(root, video))).rejects.toThrow();
    expect((await readFile(join(root, asset.storageKey))).length).toBe(asset.byteSize);
  });
  it("DS-DIST-R4-E2E approved derivative activation publishes signed cache and stop survives restart", async () => {
    const f = await fixture();
    await provisionDistributionCapabilities(
      migration,
      f.ctx.userId,
      true,
      ["campaigns.manage"],
      "local-test",
    );
    const renderer = createLocalRenderer({ root, ffmpegPath, ffprobePath });
    await runRenderJob({
      repository: jobs,
      renderer,
      workerId: "links-source",
      signal: new AbortController().signal,
    });
    const [result] = await jobs.listArtifacts(f.ctx, f.master.id);
    if (!result) throw new Error("TEST_ARTIFACT_MISSING");
    const artifact = await jobs.reviewArtifact(f.ctx, result.artifact.id, {
      expectedRevision: 1,
      expectedRecipeSha256: result.artifact.recipeSha256,
      expectedAssetSha256: result.artifact.output.video.sha256,
      decision: "APPROVED",
    });
    const outreach = createDistributionOutreachRepository(runtime);
    const repository = createDistributionActivationRepository(runtime, { authorize });
    const startsAt = new Date(Date.now() - 60000).toISOString();
    const endsAt = new Date(Date.now() + 3600000).toISOString();
    let campaign = await outreach.createCampaign(f.ctx, {
      name: "Local synthetic invitation",
      program: "test",
      goal: "Practice",
      outcomes: ["PRACTICE_COMPLETED"],
      startsAt,
      endsAt,
      budgetMicros: 0,
    });
    campaign = await outreach.approveCampaign(f.reviewer, campaign.id, { expectedRevision: 1 });
    let cta = await outreach.createCta(f.ctx, {
      intent: "PRACTICE",
      copy: "Practice",
      language: "en",
      destination: { path: "/practice/flute-meditation", requiresIdentity: true },
      fallback: { path: "/practice/koti-parayana", requiresIdentity: true },
    });
    cta = await outreach.approveCta(f.reviewer, cta.id, { expectedRevision: 1 });
    let activation = await repository.create(f.ctx, {
      campaignId: campaign.id,
      expectedCampaignRevision: campaign.revision,
      ctaId: cta.id,
      expectedCtaRevision: cta.revision,
      artifactId: artifact.id,
      expectedArtifactRevision: artifact.revision,
      scheduledAt: startsAt,
    });
    const destinations = {
      version: 1 as const,
      isTest: true as const,
      checkedAt: new Date().toISOString(),
      results: [cta.destination, cta.fallback].map(({ path, requiresIdentity }) => ({
        path,
        requiresIdentity,
        available: true,
      })),
    };
    activation = await repository.approve(f.reviewer, activation.id, {
      expectedRevision: 1,
      destinations,
    });
    const key = generateKeyPairSync("ed25519");
    const cacheRoot = join(root, "links");
    const publisher = createSignedLinkCachePublisher({
      root: cacheRoot,
      keyId: "test",
      privateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    const publicKeys = { test: key.publicKey.export({ type: "spki", format: "pem" }).toString() };
    const signal = new AbortController().signal;
    expect(await runLinkDeliveryOnce({ repository, publisher, signal })).toBe(1);
    const reader = createSignedLinkCacheReader({ root: cacheRoot, publicKeys });
    const record = await reader.read(activation.token);
    if (!record) throw new Error("TEST_CACHE_MISSING");
    expect(record.cta.approval?.reviewerId).toBe("human-review");
    expect(trackedLinkDecision(record, new Date().toISOString()).usedFallback).toBe(false);
    expect(
      await runLinkRefreshOnce({
        repository,
        signal,
        checkDestinations: async () => ({ ...destinations, checkedAt: new Date().toISOString() }),
      }),
    ).toEqual({ refreshed: 1, unavailable: 0 });
    await runLinkDeliveryOnce({ repository, publisher, signal });
    await repository.stop(f.ctx, activation.id, { expectedRevision: activation.revision });
    await runLinkDeliveryOnce({ repository, publisher, signal });
    const stopped = await createSignedLinkCacheReader({ root: cacheRoot, publicKeys }).read(
      activation.token,
    );
    if (!stopped) throw new Error("TEST_STOP_MISSING");
    expect(stopped.status).toBe("STOPPED");
    expect(trackedLinkDecision(stopped, new Date().toISOString()).destination).toBe(
      cta.fallback.path,
    );
    await expect(publisher.publish({ ...record, sequence: stopped.sequence + 1 })).rejects.toThrow(
      "LINK_TERMINAL",
    );
  });
  it("DS-DIST-R3-E2E lost commit acknowledgement preserves successful output", async () => {
    const f = await fixture();
    const renderer = createLocalRenderer({ root, ffmpegPath, ffprobePath });
    const repository = {
      ...jobs,
      succeed: async (...args: Parameters<typeof jobs.succeed>) => {
        await jobs.succeed(...args);
        throw new Error("Simulated connection loss after commit");
      },
    };
    expect(
      await runRenderJob({
        repository,
        renderer,
        workerId: "e2e-uncertain",
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: "uncertain", jobId: f.job.id, reason: "RESULT_COMMIT_UNCONFIRMED" });
    const result = await jobs.listArtifacts(f.ctx, f.master.id);
    expect(result).toHaveLength(1);
    if (!result[0]) throw new Error("TEST_ARTIFACT_MISSING");
    expect(
      (await readFile(join(root, result[0].artifact.output.video.storageKey))).length,
    ).toBeGreaterThan(0);
    expect((await jobs.getJob(f.ctx, f.job.id)).status).toBe("SUCCEEDED");
  });
});

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type DerivedAssetNamingInput,
  INTEGRITY_CHECKS,
  type NativeAnalysis,
  buildDerivedAssetNames,
} from "@satsang/distribution-domain";
import type { ContentRights } from "@satsang/distribution-domain";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDistributionEditorialRepository } from "./editorial-repository";
import { createNativeIntelligenceRepository } from "./native-repository";
import {
  type RenderClaim,
  type RenderOutput,
  createDistributionRenderRepository,
} from "./render-repository";
import { createDistributionRepository, provisionDistributionCapabilities } from "./repository";
const suite = process.env.DISTRIBUTION_RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("DS-DIST-R3 local durable render jobs", () => {
  let admin: Pool;
  let migration: Pool;
  let runtime: Pool;
  let second: Pool;
  let content: ReturnType<typeof createDistributionRepository>;
  let editorial: ReturnType<typeof createDistributionEditorialRepository>;
  let jobs: ReturnType<typeof createDistributionRenderRepository>;
  let worker2: ReturnType<typeof createDistributionRenderRepository>;
  const roleAssertions = new Map<string, readonly string[]>();
  const authorize = async ({
    userId,
    isTest,
    capability,
  }: { userId: string; isTest: boolean; capability: "content.create" | "content.review" }) =>
    isTest &&
    (roleAssertions.get(userId) ?? []).includes(
      capability === "content.create" ? "CONTENT_COORDINATOR" : "CONTENT_APPROVER",
    );
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `distribution_r3_${suffix}`;
  const migrateRole = `distribution_r3_m_${suffix}`;
  const runtimeRole = `distribution_r3_r_${suffix}`;
  const rights: ContentRights = {
    owner: "SGS",
    territories: ["WORLDWIDE"],
    channels: ["manual_export"],
    authorizationBasis: "Local test permission",
    privacyClass: "PUBLIC",
    releaseAt: null,
    expiresAt: null,
  };
  const asset = () => ({
    storageKey: `distribution/masters/${randomUUID()}`,
    sha256: randomUUID().replaceAll("-", "").repeat(2),
    byteSize: 100,
    mimeType: "video/mp4",
    originalName: "synthetic.mp4",
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
    content = createDistributionRepository(runtime);
    editorial = createDistributionEditorialRepository(runtime);
    jobs = createDistributionRenderRepository(runtime, { authorize });
    worker2 = createDistributionRenderRepository(second, { authorize });
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
  async function fixture(language = "en", secondSegment = false) {
    const ctx = {
      userId: `render-${randomUUID()}@example.test`,
      isTest: true,
      roles: ["CONTENT_COORDINATOR"],
    };
    const reviewer = {
      userId: `reviewer-${randomUUID()}@example.test`,
      isTest: true,
      roles: ["CONTENT_APPROVER"],
    };
    roleAssertions.set(ctx.userId, ctx.roles);
    roleAssertions.set(reviewer.userId, reviewer.roles);
    await provisionDistributionCapabilities(
      migration,
      ctx.userId,
      true,
      ["content.create", "content.review", "content.publish"],
      "local-test",
    );
    let master = await content.create(ctx, {
      title: "Synthetic source",
      language,
      category: "other",
      asset: asset(),
    });
    master = await content.attestRights(ctx, master.id, {
      expectedRevision: master.revision,
      rights,
    });
    master = await content.approve(reviewer, master.id, { expectedRevision: master.revision });
    let transcript = await editorial.createTranscript(ctx, master.id, {
      expectedSourceVersionId: master.currentVersion.id,
      language,
      durationMs: 5000,
      segments: [
        {
          id: "one",
          startMs: 0,
          endMs: 2000,
          originalText: "Synthetic sample",
          displayText: "Synthetic sample",
        },
        ...(secondSegment
          ? [
              {
                id: "two",
                startMs: 2000,
                endMs: 3000,
                originalText: "Synthetic second segment",
                displayText: "Synthetic second segment",
              },
            ]
          : []),
      ],
      provenance: {
        provider: "manual",
        model: null,
        promptVersion: null,
        schemaVersion: 1,
        recipeVersion: "manual-v1",
      },
    });
    transcript = await editorial.reviewTranscript(reviewer, transcript.id, {
      expectedRevision: 1,
      decision: "APPROVED",
    });
    const command = {
      masterId: master.id,
      expectedSourceRevision: master.revision,
      transcriptVersionId: transcript.id,
      quoteId: null,
      translationId: null,
      template: { id: "contained-preview-v1", version: 1 },
      aspect: "16:9" as const,
      language,
      startMs: 0,
      endMs: 2000,
      captionMode: "approved_transcript" as const,
      channel: "manual_export" as const,
      territory: "WORLDWIDE",
    };
    return { ctx, reviewer, master, transcript, command };
  }
  function output(claim: RenderClaim): RenderOutput {
    const prefix = `distribution/renders/${randomUUID()}`;
    const file = (name: string, mimeType: string) => ({
      storageKey: `${prefix}/${name}`,
      mimeType,
      byteSize: 123,
      sha256: "b".repeat(64),
    });
    return {
      sourceSha256: claim.recipe.sourceSha256,
      recipeSha256: claim.recipeSha256,
      encoderVersion: "ffmpeg version test",
      video: file("preview.mp4", "video/mp4"),
      captions: file("captions.vtt", "text/vtt"),
      manifest: file("manifest.json", "application/json"),
    };
  }
  async function claimOne(jobId: string, workerId = "one") {
    const claim = await jobs.claim({ isTest: true, workerId, jobId });
    expect(claim).not.toBeNull();
    return claim as RenderClaim;
  }
  it("binds descriptive output names to the exact master, source version and intended channel", async () => {
    const f = await fixture();
    const job = await jobs.enqueue(f.ctx, { ...f.command, placement: "instagram" });
    const claim = await claimOne(job.id);
    expect(claim.recipe.placement).toBe("instagram");
    const naming: DerivedAssetNamingInput = {
      masterId: claim.masterId,
      sourceVersionId: claim.sourceVersionId,
      derivationId: randomUUID(),
      destination: "instagram",
      language: claim.recipe.language,
      aspect: claim.recipe.aspect,
    };
    const named = (input: DerivedAssetNamingInput) => {
      const names = buildDerivedAssetNames(input);
      const result = output(claim);
      result.video.storageKey = `${names.directory}/${names.video}`;
      if (result.captions) result.captions.storageKey = `${names.directory}/${names.captions}`;
      result.manifest.storageKey = `${names.directory}/${names.manifest}`;
      return result;
    };
    for (const changed of [
      { masterId: randomUUID() },
      { sourceVersionId: randomUUID() },
      { destination: "facebook" as const },
      { language: "te" },
      { aspect: "9:16" as const },
    ])
      await expect(jobs.succeed(claim, named({ ...naming, ...changed }))).rejects.toThrow(
        "INVALID_RENDER_OUTPUT",
      );
    const mixed = named(naming);
    mixed.manifest = named({ ...naming, destination: "facebook" }).manifest;
    await expect(jobs.succeed(claim, mixed)).rejects.toThrow("INVALID_RENDER_OUTPUT");
    const completed = await jobs.succeed(claim, named(naming));
    expect(completed.accepted).toBe(true);
    if (!completed.accepted) throw new Error("TEST_COMPLETION_REFUSED");
    const result = await jobs.getArtifact(f.ctx, completed.artifact.id);
    expect(result.job.masterId).toBe(f.master.id);
    expect(result.job.recipe.placement).toBe("instagram");
    expect(result.job).not.toHaveProperty("leaseToken");
  });
  it("DS-DIST-R3-JOBS deduplicates simultaneous server recipes and two workers cannot claim one job", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([
      jobs.enqueue(f.ctx, f.command),
      worker2.enqueue(f.ctx, f.command),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.recipe.captions[0]?.text).toBe("Synthetic sample");
    const claims = await Promise.all([
      jobs.claim({ isTest: true, workerId: "one", jobId: a.id }),
      worker2.claim({ isTest: true, workerId: "two", jobId: a.id }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.attempts).toBe(1);
    await expect(jobs.getJob({ ...f.ctx, isTest: false }, a.id)).rejects.toThrow();
    await expect(
      jobs.enqueue({ userId: "ungranted@example.test", isTest: true }, f.command),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("DS-DIST-R3-DTO hides worker lease secrets and lists only current-world artifacts", async () => {
    const f = await fixture();
    const job = await jobs.enqueue(f.ctx, f.command);
    const claim = await claimOne(job.id);
    for (const dto of [
      job,
      await jobs.getJob(f.ctx, job.id),
      ...(await jobs.listJobs(f.ctx, f.master.id)),
    ]) {
      expect(dto).not.toHaveProperty("leaseToken");
      expect(dto).not.toHaveProperty("leaseOwner");
      expect(dto).not.toHaveProperty("leaseUntil");
    }
    const completed = await jobs.succeed(claim, output(claim));
    expect(completed.accepted).toBe(true);
    const listed = await jobs.listArtifacts(f.ctx, f.master.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.eligibility).toEqual({ allowed: false, reason: "ARTIFACT_NOT_APPROVED" });
    await expect(jobs.listArtifacts({ ...f.ctx, isTest: false }, f.master.id)).resolves.toEqual([]);
  });
  it("DS-DIST-R3-CURRENT revoked requester roles refuse claim and completion", async () => {
    const f = await fixture();
    const job = await jobs.enqueue(f.ctx, f.command);
    await provisionDistributionCapabilities(
      migration,
      f.ctx.userId,
      true,
      ["content.review"],
      "local-test",
    );
    roleAssertions.delete(f.ctx.userId);
    expect(await jobs.claim({ isTest: true, workerId: "one", jobId: job.id })).toBeNull();
    expect((await jobs.getJob(f.ctx, job.id)).status).toBe("STALE");
    const g = await fixture();
    const running = await jobs.enqueue(g.ctx, g.command);
    const claimed = await claimOne(running.id);
    await provisionDistributionCapabilities(
      migration,
      g.ctx.userId,
      true,
      ["content.review"],
      "local-test",
    );
    roleAssertions.delete(g.ctx.userId);
    expect(await jobs.succeed(claimed, output(claimed))).toMatchObject({
      accepted: false,
      reason: "REQUESTER_GRANT_REVOKED",
    });
  });
  it.each(["withdraw", "replace", "correct", "reject"] as const)(
    "DS-DIST-R3-CURRENT %s during render refuses stale output",
    async (change) => {
      const f = await fixture();
      const job = await jobs.enqueue(f.ctx, f.command);
      const claim = await claimOne(job.id);
      if (change === "withdraw")
        await content.withdraw(f.reviewer, f.master.id, { expectedRevision: f.master.revision });
      else if (change === "replace")
        await content.addVersion(f.ctx, f.master.id, {
          expectedRevision: f.master.revision,
          asset: asset(),
        });
      else if (change === "correct")
        await editorial.correctTranscript(f.ctx, f.transcript.id, {
          expectedRevision: f.transcript.revision,
          corrections: [{ segmentId: "one", displayText: "Corrected sample" }],
        });
      else
        await editorial.reviewTranscript(f.reviewer, f.transcript.id, {
          expectedRevision: f.transcript.revision,
          decision: "REJECTED",
        });
      expect(await jobs.succeed(claim, output(claim))).toMatchObject({ accepted: false });
      expect((await jobs.getJob(f.ctx, job.id)).status).toBe("STALE");
      expect(
        (
          await migration.query("SELECT id FROM distribution.render_artifact WHERE job_id=$1", [
            job.id,
          ])
        ).rowCount,
      ).toBe(0);
    },
  );
  it("DS-DIST-R3-LEASE reclaims crashes, fences stale workers and exhausts exactly three attempts", async () => {
    const f = await fixture();
    const job = await jobs.enqueue(f.ctx, f.command);
    const first = await claimOne(job.id);
    await migration.query(
      "UPDATE distribution.render_job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    const next = await worker2.claim({ isTest: true, workerId: "two", jobId: job.id });
    expect(next?.attempts).toBe(2);
    expect(next?.leaseToken).not.toBe(first.leaseToken);
    await expect(jobs.succeed(first, output(first))).rejects.toThrow("RENDER_LEASE_LOST");
    await expect(jobs.fail(first, "RENDER_TIMEOUT")).rejects.toThrow("RENDER_LEASE_LOST");
    await migration.query(
      "UPDATE distribution.render_job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    const third = await claimOne(job.id);
    expect(third.attempts).toBe(3);
    await migration.query(
      "UPDATE distribution.render_job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    expect(await jobs.claim({ isTest: true, workerId: "four", jobId: job.id })).toBeNull();
    expect(await jobs.getJob(f.ctx, job.id)).toMatchObject({
      status: "FAILED",
      attempts: 3,
      lastError: "RETRY_EXHAUSTED",
    });
  });
  it("DS-DIST-R3-LEASE failure retries retain recipes and use a fresh lease", async () => {
    const f = await fixture();
    const job = await jobs.enqueue(f.ctx, f.command);
    const first = await claimOne(job.id);
    await jobs.fail(first, "RENDER_TIMEOUT");
    expect(await jobs.claim({ isTest: true, workerId: "two", jobId: job.id })).toBeNull();
    await migration.query(
      "UPDATE distribution.render_job SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    const retry = await claimOne(job.id, "two");
    expect(retry.attempts).toBe(2);
    expect(retry.recipeSha256).toBe(first.recipeSha256);
  });
  it("DS-DIST-R3-REVIEW approval is exact, concurrent-safe and invalidated by current source changes", async () => {
    const f = await fixture();
    const job = await jobs.enqueue(f.ctx, f.command);
    const claim = await claimOne(job.id);
    const completed = await jobs.succeed(claim, output(claim));
    expect(completed.accepted).toBe(true);
    if (!completed.accepted) throw new Error("TEST_COMPLETION_REFUSED");
    const artifact = completed.artifact;
    expect(artifact.approval).toBeNull();
    await expect(jobs.succeed(claim, output(claim))).rejects.toThrow("RENDER_LEASE_LOST");
    const review = {
      expectedRevision: artifact.revision,
      expectedRecipeSha256: artifact.recipeSha256,
      expectedAssetSha256: artifact.output.video.sha256,
      decision: "APPROVED" as const,
    };
    await expect(
      jobs.reviewArtifact(f.reviewer, artifact.id, {
        ...review,
        expectedAssetSha256: "f".repeat(64),
      }),
    ).rejects.toThrow("ARTIFACT_MISMATCH");
    const results = await Promise.allSettled([
      jobs.reviewArtifact(f.reviewer, artifact.id, review),
      worker2.reviewArtifact(f.reviewer, artifact.id, review),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await jobs.getArtifact(f.ctx, artifact.id)).eligibility).toEqual({ allowed: true });
    const exportOptions = {
      expectedRevision: artifact.revision + 1,
      expectedRecipeSha256: artifact.recipeSha256,
      expectedAssetSha256: artifact.output.video.sha256,
    };
    await jobs.getArtifactExport(f.reviewer, artifact.id, { ...exportOptions, recordAudit: false });
    await expect(
      jobs.getArtifactExport(f.reviewer, artifact.id, {
        ...exportOptions,
        expectedAssetSha256: "c".repeat(64),
      }),
    ).rejects.toThrow("ARTIFACT_MISMATCH");
    await jobs.getArtifactExport(f.reviewer, artifact.id, exportOptions);
    expect(
      (
        await migration.query(
          "SELECT action FROM distribution.audit_event WHERE master_id=$1 AND action='VARIANT_MANUAL_EXPORT'",
          [f.master.id],
        )
      ).rowCount,
    ).toBe(1);
    await provisionDistributionCapabilities(
      migration,
      f.ctx.userId,
      true,
      ["content.create", "content.review"],
      "local-test",
    );
    await expect(
      jobs.getArtifactExport({ ...f.reviewer, roles: [] }, artifact.id, exportOptions),
    ).rejects.toThrow("FORBIDDEN");
    await content.withdraw(f.reviewer, f.master.id, { expectedRevision: f.master.revision });
    const history = await jobs.getArtifact(f.ctx, artifact.id);
    expect(history.artifact.approval?.decision).toBe("APPROVED");
    expect(history.eligibility.allowed).toBe(false);
    await expect(
      runtime.query("UPDATE distribution.render_artifact SET output='{}' WHERE id=$1", [
        artifact.id,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtime.query("UPDATE distribution.render_job SET recipe='{}' WHERE id=$1", [job.id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtime.query("DELETE FROM distribution.render_artifact_review WHERE artifact_id=$1", [
        artifact.id,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
  it("DS-DIST-R3-REVIEW refuses substituted outputs and unauthorized reviews", async () => {
    const f = await fixture();
    const job = await jobs.enqueue(f.ctx, f.command);
    const claim = await claimOne(job.id);
    const invalid = output(claim);
    invalid.video.storageKey = "../../private";
    await expect(jobs.succeed(claim, invalid)).rejects.toThrow("INVALID_RENDER_OUTPUT");
    const completed = await jobs.succeed(claim, output(claim));
    if (!completed.accepted) throw new Error("TEST_COMPLETION_REFUSED");
    await provisionDistributionCapabilities(
      migration,
      f.ctx.userId,
      true,
      ["content.create"],
      "local-test",
    );
    await expect(
      jobs.reviewArtifact(f.ctx, completed.artifact.id, {
        expectedRevision: 1,
        expectedRecipeSha256: completed.artifact.recipeSha256,
        expectedAssetSha256: completed.artifact.output.video.sha256,
        decision: "APPROVED",
      }),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("V3.2 pins native evidence and rejects missing, superseded or revoked approval", async () => {
    const { ctx, reviewer, master, transcript, command } = await fixture("te", true);
    const native = createNativeIntelligenceRepository(runtime);
    const analysis: NativeAnalysis = {
      schemaVersion: 1,
      transcriptVersionId: transcript.id,
      transcriptRevision: transcript.revision,
      sourceSha256: transcript.sourceSha256,
      language: "te",
      glossaryVersionIds: [],
      annotations: transcript.segments.map((segment) => ({
        segmentId: segment.id,
        confidence: 1,
        speakerId: "synthetic",
        speakerName: "Synthetic test speaker",
        languageSpans: [{ startMs: segment.startMs, endMs: segment.endMs, language: "te" }],
        words: [],
        englishShadow: null,
        uncertainty: [],
      })),
      teachings: [
        {
          id: "teaching",
          segmentIds: ["one"],
          kind: "conclusion",
          nativeSummary: "Synthetic test only",
          englishShadow: null,
          requiredContextIds: [],
        },
      ],
      candidates: [
        {
          id: "candidate",
          segmentIds: ["one"],
          startMs: 0,
          endMs: 2000,
          rationale: "Complete synthetic test segment",
          attributedSpeakerId: "synthetic",
          checks: INTEGRITY_CHECKS.map((check) => ({
            check,
            status: "PASS",
            evidence: "Synthetic test evidence",
            segmentIds: ["one"],
          })),
          scores: {
            fidelity: 1,
            selfContainment: 1,
            contextCompleteness: 1,
            significance: 1,
            clarity: 1,
            accessibility: 1,
            visualSuitability: 1,
            hook: 1,
          },
        },
      ],
      provenance: { provider: "manual", model: "synthetic", promptVersion: "v1", schemaVersion: 1 },
    };
    const requestId = randomUUID();
    const id = await native.propose(ctx, master.id, requestId, analysis);
    expect(await native.propose(ctx, master.id, requestId, analysis)).toBe(id);
    await expect(jobs.enqueue(ctx, command)).rejects.toThrow("NATIVE_REVIEW_REQUIRED");
    const review = {
      analysisId: id,
      candidateId: "candidate",
      expectedRevision: 0,
      requestId: randomUUID(),
      decision: "APPROVED" as const,
      reason: "Synthetic test review only",
      checks: INTEGRITY_CHECKS.map((check) => ({ check, evidence: "Synthetic evidence" })),
    };
    await expect(native.review(reviewer, master.id, review)).rejects.toThrow(
      "NATIVE_REVIEWER_REQUIRED",
    );
    await migration.query(
      "INSERT INTO distribution.native_reviewer(user_id,is_test,language,granted_by) VALUES($1,true,'te','local-test')",
      [reviewer.userId],
    );
    await native.review(reviewer, master.id, review);
    const job = await jobs.enqueue(ctx, command);
    expect(job.recipe.nativeApproval).toEqual({
      analysisId: id,
      candidateId: "candidate",
      reviewRevision: 1,
    });
    await migration.query("DELETE FROM distribution.native_reviewer WHERE user_id=$1", [
      reviewer.userId,
    ]);
    await expect(jobs.enqueue(ctx, command)).rejects.toThrow("NATIVE_REVIEW_REQUIRED");
    await migration.query(
      "INSERT INTO distribution.native_reviewer(user_id,is_test,language,granted_by) VALUES($1,true,'te','local-test')",
      [reviewer.userId],
    );
    await native.propose(ctx, master.id, randomUUID(), {
      ...analysis,
      candidates: analysis.candidates.map((c) => ({
        ...c,
        segmentIds: ["two"],
        startMs: 2000,
        endMs: 3000,
        checks: c.checks.map((check) => ({ ...check, segmentIds: ["two"] })),
      })),
    });
    await expect(jobs.enqueue(ctx, command)).rejects.toThrow("NATIVE_REVIEW_REQUIRED");
    const next = await native.propose(ctx, master.id, randomUUID(), {
      ...analysis,
      provenance: { ...analysis.provenance, promptVersion: "v2" },
    });
    await expect(jobs.enqueue(ctx, command)).rejects.toThrow("NATIVE_REVIEW_REQUIRED");
    await native.review(reviewer, master.id, {
      ...review,
      analysisId: next,
      requestId: randomUUID(),
      decision: "REJECTED",
    });
    // A historical retry returns its original result, without writing a new review.
    expect(await native.review(reviewer, master.id, review)).toMatchObject({
      revision: 1,
      decision: "APPROVED",
    });
    // The older approved proposal may not reappear after a newer rejection.
    await expect(jobs.enqueue(ctx, command)).rejects.toThrow("NATIVE_REVIEW_REQUIRED");
    await expect(
      runtime.query("DELETE FROM distribution.native_review WHERE analysis_id=$1", [id]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  ActivationPackageInput,
  CanonicalDestinationEvidence,
  ContentRights,
} from "@satsang/distribution-domain";
import { trackedLinkDecision } from "@satsang/distribution-domain";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DestinationEvidence,
  createDistributionActivationRepository,
} from "./activation-repository";
import { createDistributionEditorialRepository } from "./editorial-repository";
import { createDistributionOutreachRepository } from "./outreach-repository";
import {
  type RenderClaim,
  type RenderOutput,
  createDistributionRenderRepository,
} from "./render-repository";
import { createDistributionRepository, provisionDistributionCapabilities } from "./repository";
const suite = process.env.DISTRIBUTION_RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("DS-DIST-R4 manual activations and transactional outbox", () => {
  let admin: Pool;
  let migration: Pool;
  let runtime: Pool;
  let second: Pool;
  let content: ReturnType<typeof createDistributionRepository>;
  let editorial: ReturnType<typeof createDistributionEditorialRepository>;
  let jobs: ReturnType<typeof createDistributionRenderRepository>;
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
  const database = `distribution_r4a_${suffix}`;
  const migrateRole = `distribution_r4a_m_${suffix}`;
  const runtimeRole = `distribution_r4a_r_${suffix}`;
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
  async function fixture() {
    const ctx = {
      userId: `render-${randomUUID()}@example.test`,
      isTest: true,
      roles: ["CONTENT_COORDINATOR", "TECH_SUPER_ADMIN", "CONTENT_APPROVER"],
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
      ["content.create", "content.review", "content.publish", "campaigns.manage"],
      "local-test",
    );
    let master = await content.create(ctx, {
      title: "Synthetic source",
      language: "en",
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
      language: "en",
      durationMs: 5000,
      segments: [
        {
          id: "one",
          startMs: 0,
          endMs: 2000,
          originalText: "Synthetic sample",
          displayText: "Synthetic sample",
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
      language: "en",
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

  const paths = {
    destination: { path: "/practice/flute-meditation", requiresIdentity: true },
    fallback: { path: "/practice/koti-parayana", requiresIdentity: true },
  };
  function evidence(): DestinationEvidence {
    return {
      version: 1,
      isTest: true,
      checkedAt: new Date().toISOString(),
      results: [
        { ...paths.destination, available: true },
        { ...paths.fallback, available: true },
      ],
    };
  }
  function activations(pool = runtime) {
    return createDistributionActivationRepository(pool);
  }
  async function ready() {
    const f = await fixture();
    const job = await jobs.enqueue(f.ctx, f.command);
    const claim = await claimOne(job.id);
    const completed = await jobs.succeed(claim, output(claim));
    if (!completed.accepted) throw Error(completed.reason);
    const artifact = await jobs.reviewArtifact(f.reviewer, completed.artifact.id, {
      expectedRevision: 1,
      expectedRecipeSha256: completed.artifact.recipeSha256,
      expectedAssetSha256: completed.artifact.output.video.sha256,
      decision: "APPROVED",
    });
    const outreach = createDistributionOutreachRepository(runtime);
    let campaign = await outreach.createCampaign(f.ctx, {
      name: "Synthetic outreach",
      program: "Local only",
      goal: "Practice invitation",
      outcomes: ["PRACTICE_COMPLETED"],
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: new Date(Date.now() + 3600000).toISOString(),
      budgetMicros: 0,
    });
    campaign = await outreach.approveCampaign(f.reviewer, campaign.id, { expectedRevision: 1 });
    let cta = await outreach.createCta(f.ctx, {
      intent: "MEDITATE",
      copy: "Begin practice",
      language: "en",
      ...paths,
    });
    cta = await outreach.approveCta(f.reviewer, cta.id, { expectedRevision: 1 });
    const draft = await activations().create(f.ctx, {
      campaignId: campaign.id,
      expectedCampaignRevision: campaign.revision,
      ctaId: cta.id,
      expectedCtaRevision: cta.revision,
      artifactId: artifact.id,
      expectedArtifactRevision: artifact.revision,
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
    });
    return { ...f, artifact, campaign, cta, draft, outreach };
  }
  async function approved() {
    const f = await ready();
    const active = await activations().approve(f.reviewer, f.draft.id, {
      expectedRevision: 1,
      destinations: evidence(),
    });
    return { ...f, active };
  }
  it("DS-DIST-R4-ACTIVATION pins explicit accountless human approval and immutable lineage", async () => {
    const f = await ready();
    expect(f.draft.channelAccountId).toBeNull();
    expect(f.draft.approval).toBeNull();
    await expect(
      activations().getExport(f.reviewer, f.draft.id, {
        expectedRevision: 1,
        destinations: evidence(),
      }),
    ).rejects.toThrow("ACTIVATION_NOT_APPROVED");
    const a = await activations().approve(f.reviewer, f.draft.id, {
      expectedRevision: 1,
      destinations: evidence(),
    });
    expect(a.revision).toBe(2);
    expect(a.approval?.reviewerId).toBe(f.reviewer.userId);
    expect(a.linkBinding?.activationRevision).toBe(2);
    const result = await activations().getExport(f.reviewer, a.id, {
      expectedRevision: 2,
      destinations: evidence(),
    });
    expect(result.artifact.id).toBe(f.artifact.id);
    const history = await runtime.query(
      "SELECT revision FROM distribution.activation_revision WHERE activation_id=$1 AND is_test=true ORDER BY revision",
      [a.id],
    );
    expect(history.rows.map((x) => x.revision)).toEqual([1, 2]);
    await expect(
      runtime.query(
        "UPDATE distribution.activation_revision SET action='APPROVED' WHERE activation_id=$1",
        [a.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtime.query("UPDATE distribution.activation SET token='forged' WHERE id=$1", [a.id]),
    ).rejects.toThrow(/permission denied/);
  });
  it("DS-DIST-R4-DESTINATION refuses stale, unavailable and identity-weakened checks before approval", async () => {
    const f = await ready();
    const missing = evidence();
    missing.results = missing.results.map((item, index) => ({ ...item, available: index !== 1 }));
    await expect(
      activations().approve(f.reviewer, f.draft.id, { expectedRevision: 1, destinations: missing }),
    ).rejects.toThrow("DESTINATION_UNAVAILABLE");
    await expect(
      activations().approve(f.reviewer, f.draft.id, {
        expectedRevision: 1,
        destinations: { ...evidence(), checkedAt: new Date(Date.now() - 31000).toISOString() },
      }),
    ).rejects.toThrow("DESTINATION_CHECK_STALE");
    const wrong = evidence();
    wrong.results = wrong.results.map((item, index) => ({
      ...item,
      path: index === 0 ? "/practice/not-requested" : item.path,
    }));
    await expect(
      activations().approve(f.reviewer, f.draft.id, { expectedRevision: 1, destinations: wrong }),
    ).rejects.toThrow("DESTINATION_UNAVAILABLE");
    expect((await activations().get(f.ctx, f.draft.id)).revision).toBe(1);
  });
  it("DS-DIST-R4-ACTIVATION enforces test world and explicit distinct capabilities", async () => {
    const f = await ready();
    await expect(activations().get({ ...f.ctx, isTest: false }, f.draft.id)).rejects.toThrow(
      "TEST_WORLD_REQUIRED",
    );
    const author = { userId: randomUUID(), isTest: true };
    await provisionDistributionCapabilities(
      migration,
      author.userId,
      true,
      ["campaigns.manage"],
      "fixture",
    );
    await expect(
      activations().approve(author, f.draft.id, { expectedRevision: 1, destinations: evidence() }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      activations().getExport(author, f.draft.id, {
        expectedRevision: 1,
        destinations: evidence(),
      }),
    ).rejects.toThrow("FORBIDDEN");
    await provisionDistributionCapabilities(migration, f.ctx.userId, true, [], "fixture");
    await expect(activations().list({ ...f.ctx, roles: [] })).rejects.toThrow("FORBIDDEN");
  });
  it("DS-DIST-R4-STOP campaign and CTA edits persist tombstones atomically with no stale approval", async () => {
    const f = await approved();
    await f.outreach.updateCta(f.ctx, f.cta.id, {
      ...f.cta,
      copy: "A revised invitation",
      expectedRevision: 2,
    });
    const a = await activations().get(f.ctx, f.active.id);
    expect(a.status).toBe("STOPPED");
    expect(a.invalidatedReason).toBe("CTA_EDITED");
    const records = await runtime.query(
      "SELECT record FROM distribution.link_outbox WHERE activation_id=$1 ORDER BY sequence",
      [a.id],
    );
    expect(records.rows.map((x) => x.record.status)).toEqual(["ACTIVE", "STALE"]);
    expect(records.rows[1]?.record.cta.copy).toBe("Begin practice");
    await expect(
      activations().getExport(f.reviewer, a.id, { expectedRevision: 3, destinations: evidence() }),
    ).rejects.toThrow();
    const g = await approved();
    await g.outreach.stopCampaign(g.ctx, g.campaign.id, { expectedRevision: 2 });
    expect((await activations().get(g.ctx, g.active.id)).status).toBe("STOPPED");
  });
  it("DS-DIST-R4-STOP source/editorial/derivative changes invalidate links in the same transaction", async () => {
    const f = await approved();
    await content.withdraw(f.reviewer, f.master.id, { expectedRevision: f.master.revision });
    expect((await activations().get(f.ctx, f.active.id)).invalidatedReason).toBe(
      "CONTENT_WITHDRAWN",
    );
    const g = await approved();
    await editorial.correctTranscript(g.ctx, g.transcript.id, {
      expectedRevision: g.transcript.revision,
      corrections: [{ segmentId: "one", displayText: "Synthetic correction" }],
    });
    expect((await activations().get(g.ctx, g.active.id)).invalidatedReason).toBe(
      "TRANSCRIPT_CORRECTED",
    );
    const h = await approved();
    await jobs.reviewArtifact(h.reviewer, h.artifact.id, {
      expectedRevision: h.artifact.revision,
      expectedRecipeSha256: h.artifact.recipeSha256,
      expectedAssetSha256: h.artifact.output.video.sha256,
      decision: "REJECTED",
    });
    expect((await activations().get(h.ctx, h.active.id)).invalidatedReason).toBe(
      "ARTIFACT_REVIEW_CHANGED",
    );
  });
  it("DS-DIST-R4-CACHE two workers serialize review versus stop and preserve monotonic outbox", async () => {
    const f = await ready();
    const results = await Promise.allSettled([
      activations().approve(f.reviewer, f.draft.id, {
        expectedRevision: 1,
        destinations: evidence(),
      }),
      activations(second).stop(f.ctx, f.draft.id, { expectedRevision: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason.message),
    ).toEqual(["REVISION_CONFLICT"]);
    let a = await activations().get(f.ctx, f.draft.id);
    if (a.status !== "STOPPED")
      a = await activations().stop(f.ctx, a.id, { expectedRevision: a.revision });
    expect(a.status).toBe("STOPPED");
    await expect(
      activations().approve(f.reviewer, a.id, {
        expectedRevision: a.revision,
        destinations: evidence(),
      }),
    ).rejects.toThrow("ACTIVATION_NOT_DRAFT");
  });
  it("DS-DIST-R4-CACHE failed delivery retries durably, coalesces stops and rejects stale resurrection", async () => {
    const f = await approved();
    let captured: unknown = null;
    // Drain prior fixtures without contacting any provider or network.
    while (
      await activations().deliverNext({
        isTest: true,
        publish: async (record) => {
          captured = record;
        },
      })
    ) {}
    await activations().refresh({ isTest: true, id: f.active.id, destinations: evidence() });
    await expect(
      activations().deliverNext({
        isTest: true,
        publish: async () => {
          throw Error("SIMULATED_CACHE_FAILURE");
        },
      }),
    ).rejects.toThrow("SIMULATED_CACHE_FAILURE");
    const before = await runtime.query(
      "SELECT count(*) FROM distribution.link_outbox WHERE activation_id=$1 AND delivered_at IS NULL",
      [f.active.id],
    );
    expect(Number(before.rows[0].count)).toBe(1);
    await activations().stop(f.ctx, f.active.id, { expectedRevision: 2 });
    const delivered = await activations(second).deliverNext({
      isTest: true,
      publish: async (record) => {
        captured = record;
      },
    });
    expect(delivered?.status).toBe("STOPPED");
    expect(delivered?.sequence).toBe(3);
    expect(delivered?.activationRevision).toBe(2);
    expect(captured).toEqual(delivered);
    expect(
      await activations().refresh({ isTest: true, id: f.active.id, destinations: evidence() }),
    ).toBeNull();
    const after = await runtime.query(
      "SELECT count(*) FROM distribution.link_outbox WHERE activation_id=$1 AND delivered_at IS NULL",
      [f.active.id],
    );
    expect(Number(after.rows[0].count)).toBe(0);
  });
  it("DS-DIST-R4-CACHE refresh observes current authority and fallback covers outage within thirty seconds", async () => {
    const f = await approved();
    const record = await activations().refresh({
      isTest: true,
      id: f.active.id,
      destinations: evidence(),
    });
    expect(record?.status).toBe("ACTIVE");
    if (!record) throw Error("NO_RECORD");
    expect(
      trackedLinkDecision(record, new Date(Date.parse(record.checkedAt) + 31000).toISOString())
        .destination,
    ).toBe(paths.fallback.path);
    const e = evidence();
    e.results = e.results.map((item, index) => ({ ...item, available: index !== 0 }));
    const unavailable = await activations().refresh({
      isTest: true,
      id: f.active.id,
      destinations: e,
    });
    expect(unavailable?.destinationAvailable).toBe(false);
    const available = await activations().refresh({
      isTest: true,
      id: f.active.id,
      destinations: evidence(),
    });
    expect(available?.destinationAvailable).toBe(true);
    await content.updateMetadata(f.ctx, f.master.id, {
      expectedRevision: f.master.revision,
      title: "Revised title",
      language: "en",
      category: "other",
    });
    expect(
      await activations().refresh({ isTest: true, id: f.active.id, destinations: evidence() }),
    ).toBeNull();
  });
  const packageInput: ActivationPackageInput = {
    channel: "instagram",
    copy: "A reviewed caption linked to the full source discourse.",
    promise: "FULL_DISCOURSE",
    intendedAccess: "AUTH_REQUIRED",
  };
  async function socialReady() {
    const f = await ready();
    const canonicalId = `room:${randomUUID()}`;
    const canonicalPath = `/content/room/${canonicalId.slice(5)}`;
    let cta = await f.outreach.createCta(f.ctx, {
      intent: "LEARN",
      copy: "Watch the complete discourse",
      language: "en",
      destination: { path: canonicalPath, requiresIdentity: true },
      fallback: { path: "/explore", requiresIdentity: false },
    });
    cta = await f.outreach.approveCta(f.reviewer, cta.id, { expectedRevision: cta.revision });
    const draft = await activations().create(f.ctx, {
      campaignId: f.campaign.id,
      expectedCampaignRevision: f.campaign.revision,
      ctaId: cta.id,
      expectedCtaRevision: cta.revision,
      artifactId: f.artifact.id,
      expectedArtifactRevision: f.artifact.revision,
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      reviewPackage: packageInput,
    });
    const destinations = (): CanonicalDestinationEvidence => ({
      version: 2,
      isTest: true,
      checkedAt: new Date().toISOString(),
      flags: { tracked_social_deep_links: true, universal_content_landing: true },
      results: [
        {
          ...cta.destination,
          available: true,
          canonicalId,
          kind: "DISCOURSE",
          accessMode: "AUTH_REQUIRED",
          revision: "canonical-v1",
          reason: null,
        },
        {
          ...cta.fallback,
          available: true,
          canonicalId: "library",
          kind: "LIBRARY",
          accessMode: "PUBLIC",
          revision: "library-v1",
          reason: null,
        },
      ],
    });
    return { ...f, cta, draft, destinations };
  }
  it("DL07/DL08/DL16 requires a complete tested package and fresh exact destination before approval/export", async () => {
    const f = await socialReady();
    await expect(
      activations().approve(f.reviewer, f.draft.id, {
        expectedRevision: 1,
        destinations: f.destinations(),
      }),
    ).rejects.toThrow("DESTINATION_TEST_REQUIRED");
    const mismatched = f.destinations();
    mismatched.results = mismatched.results.map((value, index) =>
      index === 0 ? { ...value, kind: "ALBUM" } : value,
    );
    await expect(
      activations().validateDestination(f.ctx, f.draft.id, {
        expectedRevision: 1,
        destinations: mismatched,
      }),
    ).rejects.toThrow("CTA_DESTINATION_MISMATCH");
    const tested = await activations().validateDestination(f.ctx, f.draft.id, {
      expectedRevision: 1,
      destinations: f.destinations(),
    });
    expect(tested.revision).toBe(2);
    expect(tested.reviewPackage?.source).toMatchObject({
      startMs: 0,
      endMs: 2000,
      transcriptVersionId: f.transcript.id,
    });
    const active = await activations().approve(f.reviewer, tested.id, {
      expectedRevision: 2,
      destinations: f.destinations(),
    });
    expect(active.approvalPackageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(active.linkBinding?.social).toMatchObject({
      channel: "instagram",
      promise: "FULL_DISCOURSE",
      accessMode: "AUTH_REQUIRED",
    });
    expect(active.channel).toBe("manual_export");
    expect(
      (
        await activations().getExport(f.reviewer, active.id, {
          expectedRevision: 3,
          destinations: f.destinations(),
        })
      ).artifact.id,
    ).toBe(f.artifact.id);
    const changed = f.destinations();
    changed.results = changed.results.map((value, index) =>
      index === 0 ? { ...value, revision: "canonical-v2" } : value,
    );
    await expect(
      activations().getExport(f.reviewer, active.id, {
        expectedRevision: 3,
        destinations: changed,
      }),
    ).rejects.toThrow("DESTINATION_TEST_REQUIRED");
    await content.withdraw(f.reviewer, f.master.id, { expectedRevision: f.master.revision });
    expect((await activations().get(f.ctx, active.id)).status).toBe("STOPPED");
  });
  it("DL15 blocks disabled/withdrawn or audience-incompatible destination evidence without changing review", async () => {
    const f = await socialReady();
    const off = f.destinations();
    off.flags.tracked_social_deep_links = false;
    await expect(
      activations().validateDestination(f.ctx, f.draft.id, {
        expectedRevision: 1,
        destinations: off,
      }),
    ).rejects.toThrow("FEATURE_UNAVAILABLE");
    const unavailable = f.destinations();
    unavailable.results = unavailable.results.map((value, index) => ({
      ...value,
      available: index !== 0,
    }));
    await expect(
      activations().validateDestination(f.ctx, f.draft.id, {
        expectedRevision: 1,
        destinations: unavailable,
      }),
    ).rejects.toThrow("DESTINATION_UNAVAILABLE");
    const edited = await activations().revisePackage(f.ctx, f.draft.id, {
      expectedRevision: 1,
      reviewPackage: { ...packageInput, intendedAccess: "PUBLIC" },
    });
    await expect(
      activations().validateDestination(f.ctx, edited.id, {
        expectedRevision: edited.revision,
        destinations: f.destinations(),
      }),
    ).rejects.toThrow("DESTINATION_AUDIENCE_REFUSED");
    expect((await activations().get(f.ctx, edited.id)).reviewPackage?.destinationTest).toBeNull();
  });
  it("DL16 preserves historical full approvals and uses a fresh token after an approved copy/channel edit", async () => {
    const f = await socialReady();
    const tested = await activations().validateDestination(f.ctx, f.draft.id, {
      expectedRevision: 1,
      destinations: f.destinations(),
    });
    const approved = await activations().approve(f.reviewer, tested.id, {
      expectedRevision: tested.revision,
      destinations: f.destinations(),
    });
    const replacement = await activations().revisePackage(f.ctx, approved.id, {
      expectedRevision: approved.revision,
      reviewPackage: {
        ...packageInput,
        channel: "reddit",
        copy: "A different reviewed-context draft.",
      },
    });
    expect(replacement.id).not.toBe(approved.id);
    expect(replacement.token).not.toBe(approved.token);
    expect(replacement.supersedesActivationId).toBe(approved.id);
    expect(replacement.approvalPackageSha256).toBeUndefined();
    expect(replacement.reviewPackage?.destinationTest).toBeNull();
    expect((await activations().get(f.ctx, approved.id)).status).toBe("STOPPED");
    const history = await runtime.query(
      "SELECT snapshot FROM distribution.activation_revision WHERE activation_id=$1 AND is_test=true AND action='APPROVED'",
      [approved.id],
    );
    expect(history.rows[0].snapshot.reviewPackage.copy).toBe(packageInput.copy);
    expect(history.rows[0].snapshot.approvalPackageSha256).toBe(approved.approvalPackageSha256);
    const terminal = await runtime.query(
      "SELECT record FROM distribution.link_outbox WHERE activation_id=$1 AND is_test=true ORDER BY sequence DESC LIMIT 1",
      [approved.id],
    );
    expect(terminal.rows[0].record.status).toBe("STOPPED");
  });
  it("DL16 checks the locked revision before destination-test requirements after an edit wins", async () => {
    const f = await socialReady();
    const tested = await activations().validateDestination(f.ctx, f.draft.id, {
      expectedRevision: 1,
      destinations: f.destinations(),
    });
    const revised = await activations(second).revisePackage(f.ctx, tested.id, {
      expectedRevision: tested.revision,
      reviewPackage: { ...packageInput, copy: "New copy invalidates the earlier destination test" },
    });
    expect(revised.reviewPackage?.destinationTest).toBeNull();
    await expect(
      activations().approve(f.reviewer, tested.id, {
        expectedRevision: tested.revision,
        destinations: f.destinations(),
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    await expect(
      activations().approve(f.reviewer, revised.id, {
        expectedRevision: revised.revision,
        destinations: f.destinations(),
      }),
    ).rejects.toThrow("DESTINATION_TEST_REQUIRED");
    expect((await activations().get(f.ctx, revised.id)).status).toBe("DRAFT");
  });
  it("DL16 serializes copy edits against approval so stale human review cannot approve another package", async () => {
    const f = await socialReady();
    const tested = await activations().validateDestination(f.ctx, f.draft.id, {
      expectedRevision: 1,
      destinations: f.destinations(),
    });
    const results = await Promise.allSettled([
      activations().approve(f.reviewer, tested.id, {
        expectedRevision: tested.revision,
        destinations: f.destinations(),
      }),
      activations(second).revisePackage(f.ctx, tested.id, {
        expectedRevision: tested.revision,
        reviewPackage: { ...packageInput, copy: "Concurrent new copy" },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === "rejected")
        .map((result) => (result as PromiseRejectedResult).reason.message),
    ).toEqual(["REVISION_CONFLICT"]);
  });
});

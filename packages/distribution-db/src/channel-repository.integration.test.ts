import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ContentRights } from "@satsang/distribution-domain";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DestinationEvidence,
  createDistributionActivationRepository,
} from "./activation-repository";
import { createDistributionChannelRepository } from "./channel-repository";
import { createDistributionEditorialRepository } from "./editorial-repository";
import type { DistributionRoleAuthority } from "./operator-authority";
import { createDistributionOutreachRepository } from "./outreach-repository";
import {
  type RenderClaim,
  type RenderOutput,
  createDistributionRenderRepository,
} from "./render-repository";
import { createDistributionRepository, provisionDistributionCapabilities } from "./repository";
const suite = process.env.DISTRIBUTION_RUN_DB_TESTS === "1" ? describe : describe.skip;
suite("DS-DIST-R5 durable local channel rehearsal", () => {
  let admin: Pool;
  let migration: Pool;
  let runtime: Pool;
  let second: Pool;
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
  const database = `distribution_r5local_${suffix}`;
  const migrateRole = `distribution_r5local_m_${suffix}`;
  const runtimeRole = `distribution_r5local_r_${suffix}`;
  const rights: ContentRights = {
    owner: "SGS",
    territories: ["WORLDWIDE"],
    channels: ["manual_export", "youtube", "telegram"],
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
    const ctx = { userId: randomUUID(), isTest: true, roles: ["SUPER_ADMIN", "CONTENT_APPROVER"] };
    const creator = { userId: randomUUID(), isTest: true, roles: ["CONTENT_COORDINATOR"] };
    const reviewer = { userId: randomUUID(), isTest: true, roles: ["CONTENT_APPROVER"] };
    for (const identity of [ctx, creator, reviewer])
      currentRoles.set(identity.userId, identity.roles);
    await provisionDistributionCapabilities(
      migration,
      ctx.userId,
      true,
      ["campaigns.manage", "channels.manage", "operations.manage"],
      "local-test",
    );
    let master = await content.create(creator, {
      title: "Synthetic source",
      language: "en",
      category: "other",
      asset: asset(),
    });
    master = await content.attestRights(creator, master.id, {
      expectedRevision: master.revision,
      rights,
    });
    master = await content.approve(reviewer, master.id, { expectedRevision: master.revision });
    let transcript = await editorial.createTranscript(creator, master.id, {
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
    return { ctx, creator, reviewer, master, transcript, command };
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
    return createDistributionActivationRepository(pool, { authorize });
  }
  async function ready() {
    const f = await fixture();
    const job = await jobs.enqueue(f.creator, f.command);
    const claim = await claimOne(job.id);
    const completed = await jobs.succeed(claim, output(claim));
    if (!completed.accepted) throw Error(completed.reason);
    const artifact = await jobs.reviewArtifact(f.ctx, completed.artifact.id, {
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
  const channels = (pool = runtime) =>
    createDistributionChannelRepository(pool, { localLeaseMs: 1000, authorize });
  async function planned() {
    const f = await approved();
    const accountInput = {
      requestId: randomUUID(),
      expectedRevision: 0,
      adoption: {
        channel: "telegram" as const,
        accountId: randomUUID(),
        world: "TEST" as const,
        enabled: true,
        officialCapabilityEvidence: "Synthetic fixture of official API",
        accountEligibilityEvidence: "Fake channel only",
        contractTestEvidence: "No network calls",
        authorizationExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        verifiedDestination: "-100123",
        allowedVisibility: ["public" as const],
      },
      secretReference: "secret-ref://distribution/test/synthetic-channel",
      emergencyStop: false,
      circuitOpen: false,
    };
    const account = await channels().saveAccount(f.ctx, accountInput);
    const command = {
      requestId: randomUUID(),
      activationId: f.active.id,
      expectedActivationRevision: f.active.revision,
      accountId: account.adoption.accountId,
      expectedAccountRevision: account.revision,
      payload: {
        channel: "telegram" as const,
        post: { destination: "-100123", text: "Synthetic local rehearsal only" },
      },
      publicChannelAuthorization: "Local fixture channel authorization; not individual consent",
      approvalReason: "Reviewed synthetic payload for local rehearsal",
    };
    const local = await channels().prepareLocal(f.ctx, command);
    return { ...f, account, accountInput, local, command };
  }
  it("preserves source state guards and independent legacy media/package reviews with combined roles", async () => {
    const f = await ready();
    const combined = {
      ...f.creator,
      roles: ["CONTENT_COORDINATOR", "SUPER_ADMIN", "CONTENT_APPROVER"],
    };
    await expect(
      content.approve(combined, f.master.id, { expectedRevision: f.master.revision }),
    ).rejects.toThrow("APPROVAL_REFUSED:NOT_READY_FOR_REVIEW");
    await expect(
      editorial.reviewTranscript(combined, f.transcript.id, {
        expectedRevision: f.transcript.revision,
        decision: "APPROVED",
      }),
    ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
    await expect(
      jobs.reviewArtifact(combined, f.artifact.id, {
        expectedRevision: f.artifact.revision,
        expectedRecipeSha256: f.artifact.recipeSha256,
        expectedAssetSha256: f.artifact.output.video.sha256,
        decision: "APPROVED",
      }),
    ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
    await expect(
      activations().approve(f.ctx, f.draft.id, {
        expectedRevision: f.draft.revision,
        destinations: evidence(),
      }),
    ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
    const reviewed = await activations().approve(f.reviewer, f.draft.id, {
      expectedRevision: f.draft.revision,
      destinations: evidence(),
    });
    // The Admin author may publish only after another Admin approved the exact package.
    await expect(
      activations().getExport(f.ctx, reviewed.id, {
        expectedRevision: reviewed.revision,
        destinations: evidence(),
      }),
    ).resolves.toMatchObject({ activation: { id: reviewed.id } });
  });
  it("preserves inherited metadata authors across byte replacement without retaining obsolete byte or rights authors", async () => {
    const f = await fixture();
    const metadataAuthor = {
      userId: randomUUID(),
      isTest: true,
      roles: ["CONTENT_COORDINATOR", "SUPER_ADMIN", "CONTENT_APPROVER"],
    };
    const replacementUploader = {
      userId: randomUUID(),
      isTest: true,
      roles: ["CONTENT_COORDINATOR"],
    };
    let current = await content.updateMetadata(metadataAuthor, f.master.id, {
      expectedRevision: f.master.revision,
      title: "Current metadata authored before replacement",
      language: "en",
      category: "other",
    });
    current = await content.addVersion(replacementUploader, current.id, {
      expectedRevision: current.revision,
      asset: asset(),
    });
    current = await content.attestRights(replacementUploader, current.id, {
      expectedRevision: current.revision,
      rights,
    });
    await expect(
      content.approve({ ...metadataAuthor, roles: ["CONTENT_APPROVER"] }, current.id, {
        expectedRevision: current.revision,
      }),
    ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
    const previousByteAuthor = { ...f.creator, roles: ["CONTENT_COORDINATOR", "CONTENT_APPROVER"] };
    const reviewed = await content.approve(previousByteAuthor, current.id, {
      expectedRevision: current.revision,
    });
    expect(reviewed.approval?.reviewerId).toBe(previousByteAuthor.userId);
    await expect(
      content.getExport(metadataAuthor, reviewed.id, {
        expectedRevision: reviewed.revision,
        channel: "manual_export",
        territory: "WORLDWIDE",
        now: new Date().toISOString(),
      }),
    ).resolves.toMatchObject({ content: { id: reviewed.id } });
  });
  it("manual content grants cannot let Admin generate or a coordinator publish", async () => {
    const f = await planned();
    await provisionDistributionCapabilities(
      migration,
      f.ctx.userId,
      true,
      ["content.create"],
      "local-test",
    );
    await expect(
      content.create(f.ctx, { title: "Denied", language: "en", category: "other", asset: asset() }),
    ).rejects.toThrow("FORBIDDEN");
    await provisionDistributionCapabilities(
      migration,
      f.creator.userId,
      true,
      ["content.publish", "operations.manage"],
      "local-test",
    );
    await expect(channels().prepareLocal(f.creator, f.command)).rejects.toThrow("FORBIDDEN");
    await expect(channels().getLocal({ ...f.ctx, roles: [] }, f.local.id)).rejects.toThrow(
      "FORBIDDEN",
    );
  });
  it("missing current-role authority rolls back claim without consuming an attempt", async () => {
    const f = await fixture();
    const job = await jobs.enqueue(f.creator, f.command);
    await expect(
      createDistributionRenderRepository(runtime).claim({
        isTest: true,
        workerId: "missing-authority",
        jobId: job.id,
      }),
    ).rejects.toThrow("OPERATOR_AUTHORITY_UNAVAILABLE");
    expect(await jobs.getJob(f.creator, job.id)).toMatchObject({ status: "QUEUED", attempts: 0 });
    currentRoles.delete(f.creator.userId);
    expect(await jobs.claim({ isTest: true, workerId: "revoked", jobId: job.id })).toBeNull();
    expect(await jobs.getJob(f.reviewer, job.id)).toMatchObject({
      status: "STALE",
      attempts: 0,
      lastError: "REQUESTER_GRANT_REVOKED",
    });
  });
  it("stores only references, preserves TEST boundaries and prevents runtime history mutation", async () => {
    const f = await planned();
    expect(f.local.networkEnabled).toBe(false);
    expect(f.local.plan.mode).toBe("LOCAL_SIMULATION");
    await expect(channels().getLocal({ ...f.ctx, isTest: false }, f.local.id)).rejects.toThrow(
      "TEST_WORLD_REQUIRED",
    );
    await expect(
      channels().getLocal({ userId: "unknown@example.test", isTest: true }, f.local.id),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      channels().saveAccount(f.ctx, {
        ...f.accountInput,
        requestId: randomUUID(),
        expectedRevision: 1,
        secretReference: "123:raw-bot-token",
      }),
    ).rejects.toThrow("SECRET_REFERENCE_REQUIRED");
    await expect(
      runtime.query("UPDATE distribution.channel_publication SET payload_sha256=$1 WHERE id=$2", [
        "c".repeat(64),
        f.local.id,
      ]),
    ).rejects.toThrow();
    await expect(
      runtime.query(
        "DELETE FROM distribution.channel_publication_revision WHERE publication_id=$1",
        [f.local.id],
      ),
    ).rejects.toThrow();
    const listed = await channels().listLocal(f.ctx);
    expect(listed.networkEnabled).toBe(false);
    expect(JSON.stringify(listed)).not.toContain("secret-ref:");
  });
  it("deduplicates preparing a publication and refuses changed approved payload under the same identity", async () => {
    const f = await planned();
    const [one, two] = await Promise.all([
      channels().prepareLocal(f.ctx, f.command),
      channels(second).prepareLocal(f.ctx, f.command),
    ]);
    expect(one.id).toBe(f.local.id);
    expect(two.id).toBe(f.local.id);
    await expect(
      channels().prepareLocal(f.ctx, {
        ...f.command,
        payload: {
          ...f.command.payload,
          post: { ...f.command.payload.post, text: "Changed payload" },
        },
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });
  it("permits exactly one concurrent worker claim and suppresses duplicate delivery after restart", async () => {
    const f = await planned();
    const first = { requestId: randomUUID(), expectedRevision: 1, attemptId: "worker-one" };
    const attempts = await Promise.allSettled([
      channels().claimLocal(f.ctx, f.local.id, first),
      channels(second).claimLocal(f.ctx, f.local.id, {
        ...first,
        requestId: randomUUID(),
        attemptId: "worker-two",
      }),
    ]);
    expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((x) => x.status === "rejected")).toHaveLength(1);
    const held = await channels().getLocal(f.ctx, f.local.id);
    expect(held.publication.attempts).toBe(1);
    expect(held.publication.state).toBe("IN_FLIGHT");
    const replay = await channels(second).claimLocal(f.ctx, f.local.id, {
      requestId: randomUUID(),
      expectedRevision: held.publication.revision,
      attemptId: held.publication.attemptId as string,
    });
    expect(replay.claimed).toBe(false);
    expect(replay.networkEnabled).toBe(false);
  });
  it("recovers a committed claim after a process crash into reconciliation, never a new send", async () => {
    const f = await planned();
    const claimed = await channels().claimLocal(f.ctx, f.local.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      attemptId: "crashed-worker",
    });
    expect(claimed.claimed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const recovered = await channels(second).recoverLocal(f.ctx, f.local.id);
    expect(recovered.publication.state).toBe("RECONCILING");
    await expect(
      channels().claimLocal(f.ctx, f.local.id, {
        requestId: randomUUID(),
        expectedRevision: recovered.publication.revision,
        attemptId: "replacement-worker",
      }),
    ).rejects.toThrow("NOT_DISPATCHABLE");
    const result = await channels().recordLocalResult(f.ctx, f.local.id, {
      requestId: randomUUID(),
      expectedRevision: recovered.publication.revision,
      attemptId: "crashed-worker",
      outcome: { kind: "MANUAL_RECONCILIATION", code: "NO_LOOKUP" },
    });
    expect(result.publication.state).toBe("MANUAL_RECONCILIATION");
  });
  it("persists an unknown timeout across pools and rejects blindly repeating it", async () => {
    const f = await planned();
    const claimed = await channels().claimLocal(f.ctx, f.local.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      attemptId: "timed-out",
    });
    const command = {
      requestId: randomUUID(),
      expectedRevision: claimed.publication.revision,
      attemptId: "timed-out",
      outcome: { kind: "UNKNOWN" as const, code: "TRANSPORT" as const },
    };
    const result = await channels().recordLocalResult(f.ctx, f.local.id, command);
    expect(result.publication.state).toBe("RECONCILING");
    expect(
      (await channels(second).recordLocalResult(f.ctx, f.local.id, command)).publication.revision,
    ).toBe(result.publication.revision);
    await expect(
      channels(second).claimLocal(f.ctx, f.local.id, {
        requestId: randomUUID(),
        expectedRevision: result.publication.revision,
        attemptId: "blind-retry",
      }),
    ).rejects.toThrow("NOT_DISPATCHABLE");
  });
  it("rechecks account stops and revoked grants before any local action", async () => {
    const f = await planned();
    await channels().saveAccount(f.ctx, {
      ...f.accountInput,
      requestId: randomUUID(),
      expectedRevision: 1,
      emergencyStop: true,
    });
    await expect(
      channels().claimLocal(f.ctx, f.local.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
        attemptId: "stopped",
      }),
    ).rejects.toThrow("DEPENDENCY_CHANGED");
    await migration.query(
      "DELETE FROM distribution.capability_grant WHERE user_id=$1 AND is_test=true AND capability='operations.manage'",
      [f.ctx.userId],
    );
    await expect(channels().getLocal(f.ctx, f.local.id)).rejects.toThrow("FORBIDDEN");
  });
  it("rechecks source, transcript/native lineage and activation revisions instead of trusting queued approval", async () => {
    const f = await planned();
    await content.withdraw(f.ctx, f.master.id, { expectedRevision: f.master.revision });
    await expect(
      channels().claimLocal(f.ctx, f.local.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
        attemptId: "stale-source",
      }),
    ).rejects.toThrow();
    const held = await channels().getLocal(f.ctx, f.local.id);
    expect(held.publication.state).toBe("READY");
    expect(held.publication.attempts).toBe(0);
  });
  it("requires the current native teaching approval when a queued source becomes governed", async () => {
    const f = await planned();
    await migration.query(
      "INSERT INTO distribution.native_source(master_id,is_test) VALUES($1,true)",
      [f.master.id],
    );
    await expect(
      channels().claimLocal(f.ctx, f.local.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
        attemptId: "pending-native",
      }),
    ).rejects.toThrow("NATIVE_REVIEW_REQUIRED");
    expect((await channels().getLocal(f.ctx, f.local.id)).publication.attempts).toBe(0);
  });
  it("refuses a queued publication after its transcript approval is revoked", async () => {
    const f = await planned();
    await editorial.reviewTranscript(f.ctx, f.transcript.id, {
      expectedRevision: f.transcript.revision,
      decision: "REJECTED",
    });
    await expect(
      channels().claimLocal(f.ctx, f.local.id, {
        requestId: randomUUID(),
        expectedRevision: 1,
        attemptId: "rejected-transcript",
      }),
    ).rejects.toThrow("TRANSCRIPT_NOT_APPROVED");
    expect((await channels().getLocal(f.ctx, f.local.id)).publication.attempts).toBe(0);
  });
  it("keeps local fixture receipts separate from real provider publication evidence", async () => {
    const f = await planned();
    const claimed = await channels().claimLocal(f.ctx, f.local.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
      attemptId: "synthetic",
    });
    const command = {
      requestId: randomUUID(),
      expectedRevision: claimed.publication.revision,
      attemptId: "synthetic",
      outcome: {
        kind: "COMPLETE" as const,
        receipt: {
          channel: "telegram" as const,
          remoteId: "17",
          remoteDestination: "-100123",
          visibility: "public" as const,
        },
      },
    };
    await expect(channels().recordLocalResult(f.ctx, f.local.id, command)).rejects.toThrow(
      "SYNTHETIC_RECEIPT_REQUIRED",
    );
    const saved = await channels().recordLocalResult(f.ctx, f.local.id, {
      ...command,
      outcome: {
        ...command.outcome,
        receipt: { ...command.outcome.receipt, remoteId: "fixture17" },
      },
    });
    expect(saved.publication.state).toBe("PUBLISHED");
    expect(saved.networkEnabled).toBe(false);
    expect(saved.plan.mode).toBe("LOCAL_SIMULATION");
    await expect(
      channels().claimLocal(f.ctx, f.local.id, {
        requestId: randomUUID(),
        expectedRevision: saved.publication.revision,
        attemptId: "resend",
      }),
    ).rejects.toThrow("NOT_DISPATCHABLE");
  });
});

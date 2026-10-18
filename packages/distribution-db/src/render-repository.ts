import { createHash, randomUUID } from "node:crypto";
import {
  type ContentMaster,
  type DistributionCapability,
  type DistributionChannel,
  type EditorialReview,
  type QuoteCandidate,
  type RenderRecipe,
  type SocialPlacement,
  type TranscriptVersion,
  type VariantAspect,
  buildRenderRecipe,
  canonicalRenderRecipe,
  isEditorialApproved,
  parseDerivedAssetKey,
  requireContentRevision,
  requireIndependentContentReview,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { invalidateActivations } from "./activation-invalidation.js";
import { nativeRenderApproval } from "./native-repository.js";
import type { DistributionRoleAuthority } from "./operator-authority.js";
import {
  type DistributionContext,
  type PrivateAsset,
  distributionWorld,
  requireDistributionCapability,
} from "./repository.js";
import {
  requireIndependentEditorialReview,
  requireIndependentSourceReview,
} from "./review-integrity.js";

export type RenderEnqueueCommand = {
  masterId: string;
  expectedSourceRevision: number;
  transcriptVersionId: string;
  quoteId: string | null;
  translationId: string | null;
  template: { id: string; version: number };
  aspect: VariantAspect;
  language: string;
  startMs: number;
  endMs: number;
  captionMode: "none" | "approved_transcript" | "approved_quote";
  channel: DistributionChannel;
  placement?: SocialPlacement | undefined;
  territory: string;
};
export type RenderFile = { storageKey: string; sha256: string; byteSize: number; mimeType: string };
export type RenderOutput = {
  recipeSha256: string;
  sourceSha256: string;
  encoderVersion: string;
  video: RenderFile;
  captions: RenderFile | null;
  manifest: RenderFile;
};
export type RenderJob = {
  id: string;
  isTest: boolean;
  masterId: string;
  sourceVersionId: string;
  recipeSha256: string;
  recipe: RenderRecipe;
  requestedBy: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "STALE";
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
export type RenderJobSummary = Omit<RenderJob, "leaseToken" | "leaseOwner" | "leaseUntil">;
export type RenderClaim = RenderJob & {
  leaseToken: string;
  leaseOwner: string;
  source: PrivateAsset & { versionId: string };
};
export type RenderArtifact = {
  id: string;
  jobId: string;
  isTest: boolean;
  recipeSha256: string;
  output: RenderOutput;
  revision: number;
  approval: EditorialReview | null;
  createdAt: string;
};
export type RenderEligibility = { allowed: true } | { allowed: false; reason: string };
const iso = (value: Date | string) => new Date(value).toISOString();
const hashRecipe = (recipe: RenderRecipe) =>
  createHash("sha256").update(canonicalRenderRecipe(recipe)).digest("hex");
const permissions: DistributionCapability[] = [
  "content.create",
  "content.review",
  "content.publish",
];
const dependencyErrors = new Set([
  "INDEPENDENT_REVIEW_REQUIRED",
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "SOURCE_VERSION_STALE",
  "SOURCE_MISMATCH",
  "TRANSCRIPT_SUPERSEDED",
  "TRANSCRIPT_NOT_APPROVED",
  "QUOTE_NOT_APPROVED",
  "INVALID_TRANSCRIPT",
  "INVALID_SOURCE_SPAN",
  "NOT_EXACT_QUOTE",
  "QUOTE_TEXT_MISMATCH",
  "WITHDRAWN",
  "NOT_APPROVED",
  "APPROVAL_STALE",
  "RIGHTS_MISSING",
  "INVALID_RIGHTS",
  "RELEASE_PENDING",
  "RIGHTS_EXPIRED",
  "CHANNEL_NOT_PERMITTED",
  "TERRITORY_NOT_PERMITTED",
  "RESTRICTED_CONTENT",
  "SOURCE_DEPENDENCY_CHANGED",
  "NATIVE_REVIEW_REQUIRED",
  "TEACHING_INTEGRITY_FAILED",
]);
function jobFrom(row: QueryResultRow): RenderJob {
  return {
    id: row.id,
    isTest: row.is_test,
    masterId: row.master_id,
    sourceVersionId: row.source_version_id,
    recipeSha256: row.recipe_sha256,
    recipe: row.recipe,
    requestedBy: row.requested_by,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: iso(row.available_at),
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until ? iso(row.lease_until) : null,
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function jobSummary(job: RenderJob): RenderJobSummary {
  const { leaseToken: _token, leaseOwner: _owner, leaseUntil: _until, ...summary } = job;
  return summary;
}
function reviewFrom(row: QueryResultRow): EditorialReview | null {
  return row.review_decision
    ? {
        decision: row.review_decision,
        revision: row.review_revision,
        reviewerId: row.reviewer_id,
        reviewedAt: iso(row.reviewed_at),
      }
    : null;
}
function artifactFrom(row: QueryResultRow): RenderArtifact {
  const approval = reviewFrom(row);
  return {
    id: row.id,
    jobId: row.job_id,
    isTest: row.is_test,
    recipeSha256: row.recipe_sha256,
    output: row.output,
    revision: approval?.revision ?? 1,
    approval,
    createdAt: iso(row.created_at),
  };
}
function validateOutput(job: RenderJob, output: RenderOutput): void {
  const video = parseDerivedAssetKey(output.video?.storageKey);
  const naming = video?.naming;
  const file = (value: RenderFile | null, kind: string, mime: string, maximum: number) => {
    const parsed = value && parseDerivedAssetKey(value.storageKey);
    return (
      value &&
      parsed &&
      video &&
      parsed.directory === video.directory &&
      parsed.kind === kind &&
      JSON.stringify(parsed.naming) === JSON.stringify(video.naming) &&
      value.mimeType === mime &&
      /^[a-f0-9]{64}$/.test(value.sha256) &&
      Number.isSafeInteger(value.byteSize) &&
      value.byteSize > 0 &&
      value.byteSize <= maximum
    );
  };
  if (
    (naming &&
      (naming.masterId !== job.masterId ||
        naming.sourceVersionId !== job.sourceVersionId ||
        naming.destination !== (job.recipe.placement ?? job.recipe.channel) ||
        naming.language !== job.recipe.language ||
        naming.aspect !== job.recipe.aspect)) ||
    output.recipeSha256 !== job.recipeSha256 ||
    output.sourceSha256 !== job.recipe.sourceSha256 ||
    !output.encoderVersion.startsWith("ffmpeg version ") ||
    output.encoderVersion.length > 300 ||
    !file(output.video, "video", "video/mp4", 100 * 1024 * 1024) ||
    !file(output.manifest, "manifest", "application/json", 2 * 1024 * 1024) ||
    (job.recipe.captions.length
      ? !file(output.captions, "captions", "text/vtt", 1024 * 1024)
      : output.captions !== null)
  )
    throw new Error("INVALID_RENDER_OUTPUT");
}
/** Operator commands and internal worker leases share world-scoped SQL, never core tables. */
export function createDistributionRenderRepository(
  pool: Pool,
  options: { authorize?: DistributionRoleAuthority } = {},
) {
  async function run<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function hasGrant(
    _client: PoolClient,
    ctx: DistributionContext,
    capability: "content.create",
  ): Promise<boolean> {
    distributionWorld(ctx);
    // The loopback TEST service rechecks active core roles at claim AND completion.
    // Unconfigured/unavailable authority throws and rolls back; it cannot authorize a job.
    if (!options.authorize) throw new Error("OPERATOR_AUTHORITY_UNAVAILABLE");
    return options.authorize({ userId: ctx.userId, isTest: ctx.isTest, capability });
  }
  async function authorize(
    client: PoolClient,
    ctx: DistributionContext,
    capability?: DistributionCapability,
  ) {
    await requireDistributionCapability(client, ctx, capability ? [capability] : permissions);
  }
  async function loadMaster(
    client: PoolClient,
    ctx: DistributionContext,
    id: string,
    lock: boolean,
  ) {
    const world = distributionWorld(ctx);
    if (lock)
      await client.query(
        "SELECT id FROM distribution.content_master WHERE id=$1 AND is_test=$2 FOR UPDATE",
        [id, world],
      );
    const rows = await client.query(
      `SELECT m.*,v.id AS version_id,v.number AS version_number,v.sha256,v.byte_size,v.mime_type,v.original_name,v.storage_key,v.created_at AS version_created_at,v.created_by AS version_created_by,
      (SELECT rights FROM distribution.content_rights WHERE version_id=v.id AND is_test=m.is_test ORDER BY revision DESC LIMIT 1) AS rights,
      (SELECT jsonb_build_object('versionId',version_id,'approvedRevision',approved_revision,'reviewerId',reviewer_id,'approvedAt',created_at) FROM distribution.approval_decision WHERE version_id=v.id AND is_test=m.is_test AND approved_revision=m.revision LIMIT 1) AS approval
      FROM distribution.content_master m JOIN distribution.content_version v ON v.master_id=m.id AND v.is_test=m.is_test AND v.number=m.current_version_number WHERE m.id=$1 AND m.is_test=$2`,
      [id, world],
    );
    const row = rows.rows[0];
    if (!row) throw new Error("NOT_FOUND");
    const master: ContentMaster = {
      id: row.id,
      title: row.title,
      language: row.language,
      category: row.category,
      state: row.state,
      isTest: row.is_test,
      revision: row.revision,
      currentVersion: {
        id: row.version_id,
        masterId: row.id,
        number: row.version_number,
        sha256: row.sha256,
        byteSize: Number(row.byte_size),
        mimeType: row.mime_type,
        originalName: row.original_name,
        createdAt: iso(row.version_created_at),
        createdBy: row.version_created_by,
      },
      rights: row.rights,
      approval: row.approval ? { ...row.approval, approvedAt: iso(row.approval.approvedAt) } : null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
    return {
      master,
      source: {
        versionId: row.version_id,
        storageKey: row.storage_key,
        sha256: row.sha256,
        byteSize: Number(row.byte_size),
        mimeType: row.mime_type,
        originalName: row.original_name,
      } as PrivateAsset & { versionId: string },
    };
  }
  async function build(
    client: PoolClient,
    ctx: DistributionContext,
    command: RenderEnqueueCommand,
    lock: boolean,
  ) {
    const { master, source } = await loadMaster(client, ctx, command.masterId, lock);
    requireContentRevision(master.revision, command.expectedSourceRevision);
    if (master.currentVersion.mimeType !== "video/mp4") throw new Error("UNSUPPORTED_RENDER_MEDIA");
    const rows = await client.query(
      `SELECT t.transcript,r.decision AS review_decision,r.revision AS review_revision,r.reviewer_id,r.created_at AS reviewed_at,
      EXISTS(SELECT 1 FROM distribution.transcript_version child WHERE child.parent_version_id=t.id AND child.is_test=t.is_test) AS superseded
      FROM distribution.transcript_version t LEFT JOIN LATERAL (SELECT * FROM distribution.transcript_review WHERE transcript_version_id=t.id AND is_test=t.is_test ORDER BY revision DESC LIMIT 1) r ON true WHERE t.id=$1 AND t.is_test=$2`,
      [command.transcriptVersionId, ctx.isTest],
    );
    const row = rows.rows[0];
    if (!row) throw new Error("NOT_FOUND");
    if (row.superseded) throw new Error("TRANSCRIPT_SUPERSEDED");
    const review = reviewFrom(row);
    const transcript: TranscriptVersion = {
      ...row.transcript,
      review,
      revision: review?.revision ?? 1,
    };
    let quote: QuoteCandidate | undefined;
    if (command.quoteId) {
      const rows = await client.query(
        `SELECT q.candidate,r.decision AS review_decision,r.revision AS review_revision,r.reviewer_id,r.created_at AS reviewed_at
        FROM distribution.quote_candidate q LEFT JOIN LATERAL (SELECT * FROM distribution.quote_review WHERE quote_id=q.id AND is_test=q.is_test ORDER BY revision DESC LIMIT 1) r ON true WHERE q.id=$1 AND q.is_test=$2`,
        [command.quoteId, ctx.isTest],
      );
      const row = rows.rows[0];
      if (!row) throw new Error("NOT_FOUND");
      const review = reviewFrom(row);
      quote = { ...row.candidate, review, revision: review?.revision ?? 1 };
    }
    if (command.translationId !== null) throw new Error("TRANSLATION_RENDER_NOT_AVAILABLE");
    if (
      !["contained-preview-v1", "contained-teaching-v1"].includes(command.template.id) ||
      command.template.version !== 1 ||
      command.endMs - command.startMs >
        (command.template.id === "contained-teaching-v1" ? 600000 : 120000) ||
      command.endMs > 86400000
    )
      throw new Error("UNSUPPORTED_RENDER_TEMPLATE");
    const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]?.now;
    const recipe = buildRenderRecipe({
      master,
      transcript,
      ...(quote ? { quote } : {}),
      template: command.template,
      aspect: command.aspect,
      language: command.language,
      startMs: command.startMs,
      endMs: command.endMs,
      captionMode: command.captionMode,
      channel: command.channel,
      ...(command.placement !== undefined ? { placement: command.placement } : {}),
      territory: command.territory,
      now: iso(now),
    });
    await requireIndependentSourceReview(client, {
      isTest: ctx.isTest,
      masterId: master.id,
      versionId: master.currentVersion.id,
      reviewerId: master.approval?.reviewerId ?? "",
    });
    await requireIndependentEditorialReview(client, {
      isTest: ctx.isTest,
      kind: "transcript",
      id: transcript.id,
      reviewerId: transcript.review?.reviewerId ?? "",
    });
    if (quote)
      await requireIndependentEditorialReview(client, {
        isTest: ctx.isTest,
        kind: "quote",
        id: quote.id,
        reviewerId: quote.review?.reviewerId ?? "",
      });
    const nativeApproval = await nativeRenderApproval(
      client,
      ctx,
      command.masterId,
      transcript,
      command.startMs,
      command.endMs,
      options.authorize,
    );
    if (command.template.id === "contained-teaching-v1" && !nativeApproval)
      throw new Error("NATIVE_REVIEW_REQUIRED");
    return { recipe: nativeApproval ? { ...recipe, nativeApproval } : recipe, source };
  }
  async function current(client: PoolClient, job: RenderJob, lock: boolean) {
    const r = job.recipe;
    const result = await build(
      client,
      { userId: job.requestedBy, isTest: job.isTest },
      {
        masterId: job.masterId,
        expectedSourceRevision: r.sourceRevision,
        transcriptVersionId: r.transcriptVersionId,
        quoteId: r.quoteId,
        translationId: r.translationId,
        template: r.template,
        aspect: r.aspect,
        language: r.language,
        startMs: r.startMs,
        endMs: r.endMs,
        captionMode: r.quoteId
          ? "approved_quote"
          : r.captions.length
            ? "approved_transcript"
            : "none",
        channel: r.channel,
        ...(r.placement !== undefined ? { placement: r.placement } : {}),
        territory: r.territory,
      },
      lock,
    );
    if (hashRecipe(result.recipe) !== job.recipeSha256)
      throw new Error("SOURCE_DEPENDENCY_CHANGED");
    return result;
  }
  async function decision(
    client: PoolClient,
    job: RenderJob,
    lock: boolean,
  ): Promise<RenderEligibility> {
    try {
      await current(client, job, lock);
      return { allowed: true };
    } catch (error) {
      if (error instanceof Error && dependencyErrors.has(error.message))
        return { allowed: false, reason: error.message };
      throw error;
    }
  }
  async function loadJob(
    client: PoolClient,
    isTest: boolean,
    id: string,
    lock = false,
  ): Promise<RenderJob> {
    const rows = await client.query(
      `SELECT * FROM distribution.render_job WHERE id=$1 AND is_test=$2 ${lock ? "FOR UPDATE" : ""}`,
      [id, isTest],
    );
    if (!rows.rows[0]) throw new Error("NOT_FOUND");
    return jobFrom(rows.rows[0]);
  }
  async function state(
    client: PoolClient,
    job: RenderJob,
    status: RenderJob["status"],
    reason: string | null,
  ) {
    await client.query(
      "UPDATE distribution.render_job SET status=$3,last_error=$4,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
      [job.id, job.isTest, status, reason],
    );
  }
  async function checkedLease(client: PoolClient, claim: RenderClaim): Promise<RenderJob> {
    const job = await loadJob(client, claim.isTest, claim.id, true);
    const rows = await client.query(
      "SELECT 1 FROM distribution.render_job WHERE id=$1 AND is_test=$2 AND status='RUNNING' AND lease_token=$3 AND lease_owner=$4 AND lease_until>clock_timestamp()",
      [claim.id, claim.isTest, claim.leaseToken, claim.leaseOwner],
    );
    if (!rows.rowCount) throw new Error("RENDER_LEASE_LOST");
    return job;
  }
  async function loadArtifact(
    client: PoolClient,
    isTest: boolean,
    id: string,
  ): Promise<RenderArtifact> {
    const rows = await client.query(
      `SELECT a.*,r.decision AS review_decision,r.revision AS review_revision,r.reviewer_id,r.created_at AS reviewed_at
      FROM distribution.render_artifact a LEFT JOIN LATERAL (SELECT * FROM distribution.render_artifact_review WHERE artifact_id=a.id AND is_test=a.is_test ORDER BY revision DESC LIMIT 1) r ON true WHERE a.id=$1 AND a.is_test=$2`,
      [id, isTest],
    );
    if (!rows.rows[0]) throw new Error("NOT_FOUND");
    return artifactFrom(rows.rows[0]);
  }
  return {
    /** Internal only. Caller owns transaction/grant. Lock order begins with the source master. */
    inspectArtifactInTransaction: async (
      client: PoolClient,
      isTest: boolean,
      id: string,
      lock = true,
    ) => {
      distributionWorld({ userId: "internal-activation", isTest });
      const initial = await loadArtifact(client, isTest, id);
      const job = await loadJob(client, isTest, initial.jobId);
      const { master } = await loadMaster(
        client,
        { userId: "internal-activation", isTest },
        job.masterId,
        lock,
      );
      const artifact = await loadArtifact(client, isTest, id);
      let eligibility = await decision(client, job, false);
      if (eligibility.allowed && !isEditorialApproved(artifact.approval, artifact.revision))
        eligibility = { allowed: false, reason: "ARTIFACT_NOT_APPROVED" };
      if (eligibility.allowed && artifact.approval?.reviewerId === job.requestedBy)
        eligibility = { allowed: false, reason: "INDEPENDENT_REVIEW_REQUIRED" };
      return { artifact, job, master, eligibility };
    },
    enqueue: (ctx: DistributionContext, command: RenderEnqueueCommand) =>
      run(async (client) => {
        await authorize(client, ctx, "content.create");
        const { recipe } = await build(client, ctx, command, true);
        const recipeSha256 = hashRecipe(recipe);
        const rows = await client.query(
          "INSERT INTO distribution.render_job(is_test,master_id,source_version_id,recipe_sha256,recipe,requested_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(recipe_sha256,is_test) DO NOTHING RETURNING *",
          [ctx.isTest, command.masterId, recipe.sourceVersionId, recipeSha256, recipe, ctx.userId],
        );
        if (rows.rows[0]) return jobSummary(jobFrom(rows.rows[0]));
        const existing = await client.query(
          "SELECT * FROM distribution.render_job WHERE recipe_sha256=$1 AND is_test=$2",
          [recipeSha256, ctx.isTest],
        );
        return jobSummary(jobFrom(existing.rows[0] as QueryResultRow));
      }),
    getJob: (ctx: DistributionContext, id: string) =>
      run(async (client) => {
        await authorize(client, ctx);
        return jobSummary(await loadJob(client, ctx.isTest, id));
      }),
    listJobs: (ctx: DistributionContext, masterId: string) =>
      run(async (client) => {
        await authorize(client, ctx);
        const rows = await client.query(
          "SELECT * FROM distribution.render_job WHERE master_id=$1 AND is_test=$2 ORDER BY created_at DESC,id LIMIT 100",
          [masterId, ctx.isTest],
        );
        return rows.rows.map((row) => jobSummary(jobFrom(row)));
      }),
    // Internal worker API: never bind these methods to an operator-controlled HTTP action.
    claim: (input: { isTest: boolean; workerId: string; jobId?: string; leaseMs?: number }) =>
      run(async (client): Promise<RenderClaim | null> => {
        distributionWorld({ userId: input.workerId, isTest: input.isTest });
        const leaseMs = input.leaseMs ?? 180000;
        if (
          !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.workerId) ||
          !Number.isSafeInteger(leaseMs) ||
          leaseMs < 100 ||
          leaseMs > 300000
        )
          throw new Error("INVALID_RENDER_WORKER");
        for (let examined = 0; examined < 20; examined++) {
          const rows = await client.query(
            `SELECT * FROM distribution.render_job WHERE is_test=$1 AND ($2::uuid IS NULL OR id=$2) AND ((status='QUEUED' AND available_at<=clock_timestamp()) OR (status='RUNNING' AND lease_until<=clock_timestamp())) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
            [input.isTest, input.jobId ?? null],
          );
          if (!rows.rows[0]) return null;
          const job = jobFrom(rows.rows[0]);
          if (job.attempts >= job.maxAttempts) {
            await state(client, job, "FAILED", "RETRY_EXHAUSTED");
            continue;
          }
          if (
            !(await hasGrant(
              client,
              { userId: job.requestedBy, isTest: job.isTest },
              "content.create",
            ))
          ) {
            await state(client, job, "STALE", "REQUESTER_GRANT_REVOKED");
            continue;
          }
          let dependency: Awaited<ReturnType<typeof current>>;
          try {
            dependency = await current(client, job, false);
          } catch (error) {
            if (!(error instanceof Error) || !dependencyErrors.has(error.message)) throw error;
            await state(client, job, "STALE", error.message);
            continue;
          }
          const { source } = dependency;
          const token = randomUUID();
          const claimed = await client.query(
            "UPDATE distribution.render_job SET status='RUNNING',attempts=attempts+1,lease_token=$3,lease_owner=$4,lease_until=clock_timestamp()+($5::int*interval '1 millisecond'),last_error=NULL,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 RETURNING *",
            [job.id, job.isTest, token, input.workerId, leaseMs],
          );
          return {
            ...jobFrom(claimed.rows[0] as QueryResultRow),
            leaseToken: token,
            leaseOwner: input.workerId,
            source,
          };
        }
        return null;
      }),
    succeed: (claim: RenderClaim, output: RenderOutput) =>
      run(
        async (
          client,
        ): Promise<
          { accepted: true; artifact: RenderArtifact } | { accepted: false; reason: string }
        > => {
          distributionWorld({ userId: claim.leaseOwner, isTest: claim.isTest });
          const initial = await loadJob(client, claim.isTest, claim.id);
          // Source -> job is the same lock order as enqueue. Claims hold only a job lock.
          await client.query(
            "SELECT id FROM distribution.content_master WHERE id=$1 AND is_test=$2 FOR UPDATE",
            [initial.masterId, claim.isTest],
          );
          const job = await checkedLease(client, claim);
          validateOutput(job, output);
          const granted = await hasGrant(
            client,
            { userId: job.requestedBy, isTest: job.isTest },
            "content.create",
          );
          const eligibility = granted
            ? await decision(client, job, false)
            : { allowed: false as const, reason: "REQUESTER_GRANT_REVOKED" };
          if (!eligibility.allowed) {
            await state(client, job, "STALE", eligibility.reason);
            return { accepted: false, reason: eligibility.reason };
          }
          const inserted = await client.query(
            "INSERT INTO distribution.render_artifact(job_id,is_test,recipe_sha256,asset_sha256,output) VALUES ($1,$2,$3,$4,$5) RETURNING id",
            [job.id, job.isTest, job.recipeSha256, output.video.sha256, output],
          );
          await state(client, job, "SUCCEEDED", null);
          return {
            accepted: true,
            artifact: await loadArtifact(client, job.isTest, inserted.rows[0]?.id),
          };
        },
      ),
    fail: (claim: RenderClaim, code: string) =>
      run(async (client) => {
        distributionWorld({ userId: claim.leaseOwner, isTest: claim.isTest });
        const job = await checkedLease(client, claim);
        const allowed = [
          "RENDER_TIMEOUT",
          "RENDER_PROCESS_FAILED",
          "RENDER_PROCESS_UNAVAILABLE",
          "RENDER_CANCELLED",
          "RENDER_VALIDATION_FAILED",
          "SOURCE_INTEGRITY_FAILED",
          "SOURCE_SPAN_UNAVAILABLE",
        ];
        const reason = allowed.includes(code) ? code : "RENDER_FAILED";
        const terminal =
          job.attempts >= job.maxAttempts ||
          ["SOURCE_INTEGRITY_FAILED", "SOURCE_SPAN_UNAVAILABLE"].includes(reason);
        await state(client, job, terminal ? "FAILED" : "QUEUED", reason);
        if (!terminal)
          await client.query(
            "UPDATE distribution.render_job SET available_at=clock_timestamp()+($3::int*interval '1 second') WHERE id=$1 AND is_test=$2",
            [job.id, job.isTest, 2 ** job.attempts],
          );
        return loadJob(client, job.isTest, job.id);
      }),
    getArtifact: (ctx: DistributionContext, id: string) =>
      run(async (client) => {
        await authorize(client, ctx);
        const artifact = await loadArtifact(client, ctx.isTest, id);
        const job = await loadJob(client, ctx.isTest, artifact.jobId);
        let eligibility = await decision(client, job, false);
        if (eligibility.allowed && !isEditorialApproved(artifact.approval, artifact.revision))
          eligibility = { allowed: false, reason: "ARTIFACT_NOT_APPROVED" };
        if (eligibility.allowed && artifact.approval?.reviewerId === job.requestedBy)
          eligibility = { allowed: false, reason: "INDEPENDENT_REVIEW_REQUIRED" };
        return { artifact, eligibility, job: jobSummary(job) };
      }),
    getArtifactExport: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        expectedRecipeSha256: string;
        expectedAssetSha256: string;
        recordAudit?: boolean;
      },
    ) =>
      run(async (client) => {
        await authorize(client, ctx, "content.publish");
        const initial = await loadArtifact(client, ctx.isTest, id);
        const job = await loadJob(client, ctx.isTest, initial.jobId);
        await client.query(
          "SELECT id FROM distribution.content_master WHERE id=$1 AND is_test=$2 FOR SHARE",
          [job.masterId, ctx.isTest],
        );
        const artifact = await loadArtifact(client, ctx.isTest, id);
        requireContentRevision(artifact.revision, input.expectedRevision);
        if (
          artifact.recipeSha256 !== input.expectedRecipeSha256 ||
          artifact.output.video.sha256 !== input.expectedAssetSha256
        )
          throw new Error("ARTIFACT_MISMATCH");
        const eligibility = await decision(client, job, false);
        if (!eligibility.allowed) throw new Error(eligibility.reason);
        if (!isEditorialApproved(artifact.approval, artifact.revision))
          throw new Error("ARTIFACT_NOT_APPROVED");
        requireIndependentContentReview(artifact.approval?.reviewerId ?? "", [job.requestedBy]);
        if (input.recordAudit !== false)
          await client.query(
            "INSERT INTO distribution.audit_event(master_id,is_test,actor_id,action,revision) VALUES($1,$2,$3,'VARIANT_MANUAL_EXPORT',$4)",
            [job.masterId, ctx.isTest, ctx.userId, job.recipe.sourceRevision],
          );
        return artifact;
      }),
    listArtifacts: (ctx: DistributionContext, masterId: string) =>
      run(async (client) => {
        await authorize(client, ctx);
        const rows = await client.query(
          "SELECT a.id FROM distribution.render_artifact a JOIN distribution.render_job j ON j.id=a.job_id AND j.is_test=a.is_test WHERE j.master_id=$1 AND j.is_test=$2 ORDER BY a.created_at DESC,a.id LIMIT 100",
          [masterId, ctx.isTest],
        );
        const results: { artifact: RenderArtifact; eligibility: RenderEligibility }[] = [];
        for (const row of rows.rows) {
          const artifact = await loadArtifact(client, ctx.isTest, row.id);
          const job = await loadJob(client, ctx.isTest, artifact.jobId);
          let eligibility = await decision(client, job, false);
          if (eligibility.allowed && !isEditorialApproved(artifact.approval, artifact.revision))
            eligibility = { allowed: false, reason: "ARTIFACT_NOT_APPROVED" };
          if (eligibility.allowed && artifact.approval?.reviewerId === job.requestedBy)
            eligibility = { allowed: false, reason: "INDEPENDENT_REVIEW_REQUIRED" };
          results.push({ artifact, eligibility });
        }
        return results;
      }),
    reviewArtifact: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        expectedRecipeSha256: string;
        expectedAssetSha256: string;
        decision: EditorialReview["decision"];
      },
    ) =>
      run(async (client) => {
        await authorize(client, ctx, "content.review");
        const initial = await loadArtifact(client, ctx.isTest, id);
        const job = await loadJob(client, ctx.isTest, initial.jobId);
        await client.query(
          "SELECT id FROM distribution.content_master WHERE id=$1 AND is_test=$2 FOR UPDATE",
          [job.masterId, ctx.isTest],
        );
        // The master lock serializes reviews; immutable artifacts deliberately lack UPDATE privileges.
        const artifact = await loadArtifact(client, ctx.isTest, id);
        requireContentRevision(artifact.revision, input.expectedRevision);
        requireIndependentContentReview(ctx.userId, [job.requestedBy]);
        if (
          artifact.recipeSha256 !== input.expectedRecipeSha256 ||
          artifact.output.video.sha256 !== input.expectedAssetSha256
        )
          throw new Error("ARTIFACT_MISMATCH");
        if (!["APPROVED", "REJECTED"].includes(input.decision)) throw new Error("INVALID_REVIEW");
        if (input.decision === "APPROVED") {
          const eligibility = await decision(client, job, false);
          if (!eligibility.allowed) throw new Error(eligibility.reason);
        }
        await client.query(
          "INSERT INTO distribution.render_artifact_review(artifact_id,is_test,revision,decision,recipe_sha256,asset_sha256,reviewer_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            ctx.isTest,
            artifact.revision + 1,
            input.decision,
            artifact.recipeSha256,
            artifact.output.video.sha256,
            ctx.userId,
          ],
        );
        await invalidateActivations(client, {
          isTest: ctx.isTest,
          actorId: ctx.userId,
          artifactId: id,
          reason: "ARTIFACT_REVIEW_CHANGED",
        });
        return loadArtifact(client, ctx.isTest, id);
      }),
  };
}

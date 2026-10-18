import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isOnlineBundle } from "@satsang/distribution-domain";
import {
  type ContentMaster,
  type DistributionChannel,
  type PlaylistCuration,
  type StudioAdditionalMessage,
  type StudioChannel,
  type StudioFeedback,
  type StudioGenerationProgress,
  type StudioGenerationRequest,
  type StudioOutput,
  type StudioPackage,
  type StudioProvenance,
  type StudioPublication,
  type StudioTranscript,
  appendStudioMessage,
  assertStudioCorrectionIsolation,
  contentExportDecision,
  requireContentRevision,
  requireIndependentContentReview,
  studioCanDiscard,
  studioCanEdit,
  studioCorrectionTargets,
  studioExternalProcessingDecision,
  studioNeedsSuitabilityReview,
  studioPackageBlockers,
  studioSourceMatches,
  studioSourceRange,
  studioStatusAfterOutputDiscard,
  studioYoutubeClosing,
  unconfiguredStudioClosingChannels,
  validateContentRights,
  validateStudioGenerationRequest,
  validateStudioOutputs,
  validateStudioProvenance,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  type DistributionContext,
  type PrivateAsset,
  distributionCapabilities,
  distributionWorld,
  recordContentRights,
  requireDistributionCapability,
} from "./repository.js";
import { requireIndependentSourceReview } from "./review-integrity.js";
import type { StudioRoleAuthority } from "./studio-authority.js";
import { currentStudioTranscript, loadStudioSource } from "./studio-source.js";

export type StudioRevisionHistoryEntry = {
  revision: number;
  action: string;
  actorId: string;
  createdAt: string;
  package: StudioPackage;
};

export type StudioGenerationClaim = {
  checkpoint?: Record<string, { fingerprint: string; value: unknown }>;
  id: string;
  package: StudioPackage;
  source: PrivateAsset & { versionId: string; masterId: string };
  transcript: StudioTranscript | null;
  externalProcessing: { allowed: boolean; reason: string | null };
  leaseToken: string;
  leaseOwner: string;
  attempts: number;
};
export type StudioPublicationClaim = {
  publication: StudioPublication;
  package: StudioPackage;
  output: StudioOutput;
  checkpoint: Record<string, unknown> | null;
  leaseToken: string;
  leaseOwner: string;
};
type Eligibility = { accepted: true; package: StudioPackage } | { accepted: false; reason: string };
const iso = (value: Date | string) => new Date(value).toISOString();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = isDeepStrictEqual;
function comment(value: string | undefined, required = false): string {
  const result = value?.trim() ?? "";
  if (result.length > 4000 || result.includes("\u0000") || (required && !result))
    throw new Error("INVALID_STUDIO_COMMENT");
  return result;
}
const knownFailures = new Set([
  "STUDIO_CLOSING_CHANNEL_REQUIRED",
  "GENERATION_NOT_CONFIGURED",
  "TRANSCRIPTION_NOT_CONFIGURED",
  "TRANSLATION_NOT_CONFIGURED",
  "BRAND_NOT_CONFIGURED",
  "SOURCE_DEPENDENCY_CHANGED",
  "SOURCE_INTEGRITY_FAILED",
  "PROVIDER_UNAVAILABLE",
  "GENERATION_FAILED",
  "GENERATION_TIMEOUT",
  "INVALID_STUDIO_OUTPUTS",
  "INVALID_STUDIO_OUTPUT",
  "INVALID_STUDIO_ASSET",
  "REQUESTER_ROLE_REVOKED",
  "RETRY_EXHAUSTED",
  "STUDIO_GENERATION_DISABLED",
  "STUDIO_INTELLIGENCE_NOT_CONFIGURED",
  "STUDIO_TRANSCRIPTION_NOT_CONFIGURED_OR_TOO_LARGE",
  "STUDIO_TRANSCRIPT_REQUIRED",
  "STUDIO_TRANSCRIPT_INVALID",
  "STUDIO_TRANSCRIPT_LANGUAGE_MISMATCH",
  "STUDIO_TRANSCRIPT_TOO_LARGE",
  "STUDIO_TRANSCRIPT_DURATION_MISMATCH",
  "STUDIO_TRANSLATION_PROVIDER_REQUIRED",
  "STUDIO_TRANSLATION_INCOMPLETE",
  "STUDIO_PROVIDER_INCOMPLETE",
  "STUDIO_PROVIDER_OUTPUT_LIMIT",
  "STUDIO_PROVIDER_CONTENT_BLOCKED",
  "STUDIO_PROVIDER_RECITATION_BLOCKED",
  "STUDIO_PROVIDER_QUOTA_EXHAUSTED",
  "STUDIO_PROVIDER_BILLING_REQUIRED",
  "STUDIO_PROVIDER_REQUEST_INVALID",
  "STUDIO_NO_SUITABLE_CHANNELS",
  "STUDIO_TRANSCRIPTION_START_UNCERTAIN",
  "STUDIO_PROVIDER_INVALID_RESPONSE",
  "STUDIO_PROVIDER_RATE_LIMITED",
  "STUDIO_PROVIDER_AUTHENTICATION_FAILED",
  "STUDIO_PROVIDER_TIMEOUT",
  "STUDIO_PROVIDER_UNSAFE_STORAGE_URL",
  "STUDIO_PROVIDER_TRANSCRIPTION_FAILED",
  "STUDIO_SARVAM_KEYTERMS_INVALID",
  "STUDIO_SARVAM_CONFIGURATION_INVALID",
  "STUDIO_TRANSCRIPTION_PROVIDER_UNSUPPORTED",
  "STUDIO_AUDIO_INVALID_OR_TOO_LARGE",
  "STUDIO_AUDIO_MEASUREMENT_FAILED",
  "STUDIO_AUDIO_UNUSABLE",
  "STUDIO_AUDIO_QUALITY_FAILED",
  "STUDIO_PROVIDER_RESPONSE_LIMIT",
  "STUDIO_PROVIDER_UNAVAILABLE",
  "STUDIO_PROVIDER_ABORTED",
  "STUDIO_CACHE_INVALID",
  "STUDIO_CACHE_SOURCE_MISMATCH",
  "STUDIO_MEDIA_DURATION_INVALID",
  "STUDIO_MEDIA_DIMENSIONS_INVALID",
  "STUDIO_EDITED_OUTPUT_OMITTED",
  "DUPLICATE_STUDIO_PASSAGE",
  "STUDIO_MESSAGE_SOURCE_MISMATCH",
  "INVALID_STUDIO_MESSAGE",
  "STUDIO_PRIVATE_SCRATCH_REQUIRED",
  "STUDIO_CAPTION_BOUNDARY_INVALID",
  "STUDIO_CAPTION_SEGMENT_TOO_LONG",
  "STUDIO_CHANNEL_COVERAGE_REQUIRED",
  "STUDIO_CLIP_TOO_LONG",
  "STUDIO_VIDEO_REVIEW_REQUIRED",
  "STUDIO_VIDEO_REVIEW_INVALID",
  "STUDIO_PRESENTATION_REVIEW_INVALID",
  "STUDIO_CLOSING_CARD_INVALID",
  "STUDIO_OPENING_CARD_INVALID",
  "STUDIO_PRESENTATION_NOT_CONFIGURED",
  "STUDIO_PRESENTATION_BOUNDARY_REQUIRED",
  "STUDIO_PRESENTATION_REPAIR_REQUIRED",
  "STUDIO_ILLUSTRATION_INVALID",
  "STUDIO_IMAGE_NOT_CONFIGURED",
  "STUDIO_IMAGE_GENERATION_INVALID",
  "STUDIO_IMAGE_REVIEW_INVALID",
  "STUDIO_IMAGE_REVIEW_REQUIRED",
  "STUDIO_POST_ART_INVALID",
  "STUDIO_POST_EXCERPT_INVALID",
  "STUDIO_POST_LAYOUT_INVALID",
  "STUDIO_POST_ART_REVIEW_REQUIRED",
  "INVALID_STUDIO_AI_REVIEW",
  "STUDIO_SOURCE_EVIDENCE_REQUIRED",
  "STUDIO_CAPTIONS_REQUIRED",
  "OPERATOR_AUTHORITY_UNAVAILABLE",
  "STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED",
]);
const publicationRefusals = new Set([
  "STUDIO_NOT_APPROVED",
  "INDEPENDENT_REVIEW_REQUIRED",
  "GENERATION_REQUIRED",
  "NO_INCLUDED_OUTPUTS",
  "ASSETS_REQUIRE_REGENERATION",
  "SOURCE_DEPENDENCY_CHANGED",
  "TRANSCRIPT_SUPERSEDED",
  "NATIVE_REVIEWER_REQUIRED",
  "REVIEWER_ROLE_REVOKED",
  "REQUESTER_ROLE_REVOKED",
  "PUBLISHER_ROLE_REVOKED",
  "PACKAGE_CHANGED",
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
]);
const failure = (code: string) => (knownFailures.has(code) ? code : "GENERATION_FAILED");
function publication(row: QueryResultRow): StudioPublication {
  return {
    id: row.id,
    packageId: row.package_id,
    packageRevision: row.package_revision,
    outputId: row.output_id,
    channel: row.channel,
    isTest: row.is_test,
    status: row.status,
    accountId: row.account_id,
    attempt: row.attempts,
    error: row.last_error,
    remoteId: row.remote_id,
    remoteUrl: row.remote_url,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function worker(input: { isTest: boolean; workerId: string; leaseMs?: number | undefined }) {
  distributionWorld({ isTest: input.isTest, userId: input.workerId });
  const leaseMs = input.leaseMs ?? 240000;
  if (
    !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.workerId) ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 100 ||
    leaseMs > 300000
  )
    throw new Error("INVALID_STUDIO_WORKER");
  return leaseMs;
}

/** Durable content workflow. Immutable revisions and feedback are separate from queue state. */
export function createIntelligentContentRepository(
  pool: Pool,
  options: { authorize?: StudioRoleAuthority } = {},
) {
  async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
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
  async function access(
    client: PoolClient,
    ctx: DistributionContext,
    capability?: "content.create" | "content.review" | "content.publish",
  ) {
    await requireDistributionCapability(
      client,
      ctx,
      capability ? [capability] : ["content.create", "content.review", "content.publish"],
    );
  }
  async function fresh(
    userId: string,
    isTest: boolean,
    capability: "content.create" | "content.review" | "content.publish",
  ) {
    if (!options.authorize) throw new Error("OPERATOR_AUTHORITY_UNAVAILABLE");
    return options.authorize({ userId, isTest, capability });
  }
  // Resolve both roles from the current authority, including at delivery time.
  async function reviewerRoles(userId: string, isTest: boolean): Promise<string[]> {
    return (await fresh(userId, isTest, "content.create")) &&
      (await fresh(userId, isTest, "content.review"))
      ? ["CONTENT_COORDINATOR", "CONTENT_APPROVER"]
      : [];
  }
  async function load(
    client: PoolClient,
    isTest: boolean,
    id: string,
    lock = false,
  ): Promise<StudioPackage> {
    const first = await client.query(
      "SELECT master_id FROM distribution.studio_package WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
      [id, isTest],
    );
    if (!first.rows[0]) throw new Error("NOT_FOUND");
    if (lock) {
      await loadStudioSource(client, isTest, first.rows[0].master_id, true);
      await client.query(
        "SELECT id FROM distribution.studio_package WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL FOR UPDATE",
        [id, isTest],
      );
    }
    const rows = await client.query(
      "SELECT r.snapshot FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision WHERE p.id=$1 AND p.is_test=$2 AND p.deleted_at IS NULL",
      [id, isTest],
    );
    const result = rows.rows[0]?.snapshot as StudioPackage | undefined;
    if (!result) throw new Error("NOT_FOUND");
    const history = await client.query(
      "SELECT * FROM distribution.studio_feedback WHERE package_id=$1 AND is_test=$2 ORDER BY revision,created_at,id",
      [id, isTest],
    );
    result.feedback = history.rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      comment: row.comment,
      revision: row.revision,
      createdAt: iso(row.created_at),
    }));
    if (["QUEUED", "GENERATING", "FAILED"].includes(result.status)) {
      const jobs = await client.query(
        "SELECT status,progress FROM distribution.studio_generation_job WHERE package_id=$1 AND is_test=$2 ORDER BY package_revision DESC LIMIT 1",
        [id, isTest],
      );
      if (jobs.rows[0]?.status === "RUNNING") result.status = "GENERATING";
      result.generationProgress = jobs.rows[0]?.progress ?? null;
    }
    return result;
  }
  async function save(
    client: PoolClient,
    pkg: StudioPackage,
    actorId: string,
    action: string,
    change: Partial<StudioPackage>,
    note?: { action: StudioFeedback["action"]; comment: string },
  ) {
    const next: StudioPackage = {
      ...pkg,
      ...change,
      generationProgress: null,
      id: pkg.id,
      isTest: pkg.isTest,
      source: pkg.source,
      createdBy: pkg.createdBy,
      createdAt: pkg.createdAt,
      revision: pkg.revision + 1,
      feedback: [],
      updatedAt: new Date().toISOString(),
    };
    await client.query(
      "INSERT INTO distribution.studio_revision(package_id,is_test,revision,snapshot,actor_id,action) VALUES($1,$2,$3,$4,$5,$6)",
      [pkg.id, pkg.isTest, next.revision, next, actorId, action],
    );
    const changed = await client.query(
      "UPDATE distribution.studio_package SET revision=$3,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 AND revision=$4",
      [pkg.id, pkg.isTest, next.revision, pkg.revision],
    );
    if (changed.rowCount !== 1) throw new Error("REVISION_CONFLICT");
    if (note)
      await client.query(
        "INSERT INTO distribution.studio_feedback(package_id,is_test,revision,actor_id,action,comment) VALUES($1,$2,$3,$4,$5,$6)",
        [pkg.id, pkg.isTest, next.revision, actorId, note.action, note.comment],
      );
    return load(client, pkg.isTest, pkg.id);
  }
  async function sourceCurrent(client: PoolClient, pkg: StudioPackage): Promise<ContentMaster> {
    const { master } = await loadStudioSource(client, pkg.isTest, pkg.source.masterId);
    if (!studioSourceMatches(pkg.source, master) || master.state === "WITHDRAWN")
      throw new Error("SOURCE_DEPENDENCY_CHANGED");
    return master;
  }
  async function transcriptCurrent(client: PoolClient, pkg: StudioPackage) {
    const value = pkg.provenance?.transcript;
    if (value?.provenance === "APPROVED_TRANSCRIPT") {
      const current = await currentStudioTranscript(client, pkg.isTest, pkg.source.versionId);
      if (!current || !same(current, value)) throw new Error("TRANSCRIPT_SUPERSEDED");
    }
  }
  async function sourceRights(client: PoolClient, pkg: StudioPackage, strictApproval = false) {
    const master = await sourceCurrent(client, pkg);
    if (strictApproval && master.revision !== pkg.approval?.sourceRevision)
      throw new Error("SOURCE_DEPENDENCY_CHANGED");
    for (const output of pkg.outputs.filter((value) => value.included)) {
      const decision = contentExportDecision({
        content: master,
        channel: output.channel as DistributionChannel,
        territory: "WORLDWIDE",
        now: new Date().toISOString(),
      });
      if (!decision.allowed) throw new Error(decision.reason);
    }
    if (!master.approval) throw new Error("NOT_APPROVED");
    await requireIndependentSourceReview(client, {
      isTest: pkg.isTest,
      masterId: master.id,
      versionId: master.currentVersion.id,
      reviewerId: master.approval.reviewerId,
      reviewerRoles: await reviewerRoles(master.approval.reviewerId, pkg.isTest),
    });
    await transcriptCurrent(client, pkg);
    return master;
  }
  async function qualifiedReviewer(client: PoolClient, pkg: StudioPackage, reviewerId: string) {
    if (["te", "kn", "ta"].includes(pkg.source.language)) {
      const grants = await client.query(
        "SELECT 1 FROM distribution.native_reviewer WHERE user_id=$1 AND is_test=$2 AND language=$3",
        [reviewerId, pkg.isTest, pkg.source.language],
      );
      if (!grants.rowCount) throw new Error("NATIVE_REVIEWER_REQUIRED");
    }
  }
  async function publicationEligible(client: PoolClient, pkg: StudioPackage, publishing = true) {
    if (pkg.status !== "APPROVED" || pkg.approval?.revision !== pkg.revision)
      throw new Error("STUDIO_NOT_APPROVED");
    requireIndependentContentReview(
      pkg.approval.reviewerId,
      pkg.contributorIds,
      await reviewerRoles(pkg.approval.reviewerId, pkg.isTest),
    );
    const blockers = studioPackageBlockers(pkg);
    if (blockers.length) throw new Error(blockers[0]);
    if (publishing && unconfiguredStudioClosingChannels(pkg.outputs).length)
      throw new Error("STUDIO_CLOSING_CHANNEL_REQUIRED");
    await sourceRights(client, pkg, true);
    await qualifiedReviewer(client, pkg, pkg.approval.reviewerId);
    if (!(await fresh(pkg.approval.reviewerId, pkg.isTest, "content.review")))
      throw new Error("REVIEWER_ROLE_REVOKED");
    for (const contributor of pkg.contributorIds)
      if (!(await fresh(contributor, pkg.isTest, "content.create")))
        throw new Error("REQUESTER_ROLE_REVOKED");
  }
  async function enqueue(client: PoolClient, pkg: StudioPackage, userId: string) {
    await client.query(
      "INSERT INTO distribution.studio_generation_job(package_id,is_test,package_revision,requested_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [pkg.id, pkg.isTest, pkg.revision, userId],
    );
  }
  async function checkedGeneration(client: PoolClient, claim: StudioGenerationClaim) {
    const pkg = await load(client, claim.package.isTest, claim.package.id, true);
    const rows = await client.query(
      "SELECT * FROM distribution.studio_generation_job WHERE id=$1 AND is_test=$2 AND package_id=$3 AND status='RUNNING' AND lease_token=$4 AND lease_owner=$5 AND lease_until>clock_timestamp() FOR UPDATE",
      [claim.id, claim.package.isTest, claim.package.id, claim.leaseToken, claim.leaseOwner],
    );
    if (!rows.rows[0]) throw new Error("STUDIO_LEASE_LOST");
    return { pkg, row: rows.rows[0] };
  }
  async function generationState(
    client: PoolClient,
    id: string,
    isTest: boolean,
    status: string,
    error: string | null,
  ) {
    await client.query(
      "UPDATE distribution.studio_generation_job SET status=$3,last_error=$4,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
      [id, isTest, status, error],
    );
  }
  async function publicationRow(client: PoolClient, isTest: boolean, id: string, lock = false) {
    const rows = await client.query(
      `SELECT * FROM distribution.studio_publication_job WHERE id=$1 AND is_test=$2 ${lock ? "FOR UPDATE" : ""}`,
      [id, isTest],
    );
    if (!rows.rows[0]) throw new Error("NOT_FOUND");
    return rows.rows[0];
  }
  async function attempt(
    client: PoolClient,
    row: QueryResultRow,
    status: string,
    detail: Record<string, unknown> = {},
  ) {
    await client.query(
      "INSERT INTO distribution.studio_publication_attempt(publication_id,is_test,attempt,status,detail) VALUES($1,$2,$3,$4,$5)",
      [row.id, row.is_test, row.attempts, status, detail],
    );
  }
  async function publicationState(
    client: PoolClient,
    row: QueryResultRow,
    status: string,
    error: string | null,
  ) {
    await client.query(
      "UPDATE distribution.studio_publication_job SET status=$3,last_error=$4,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
      [row.id, row.is_test, status, error],
    );
    await attempt(client, row, status, error ? { error } : {});
  }
  async function checkedPublication(client: PoolClient, claim: StudioPublicationClaim) {
    const pkg = await load(client, claim.publication.isTest, claim.publication.packageId, true);
    const row = await publicationRow(client, claim.publication.isTest, claim.publication.id, true);
    if (
      row.package_id !== claim.publication.packageId ||
      row.package_revision !== claim.publication.packageRevision ||
      row.output_id !== claim.publication.outputId ||
      row.channel !== claim.publication.channel ||
      row.status !== "RUNNING" ||
      row.lease_token !== claim.leaseToken ||
      row.lease_owner !== claim.leaseOwner ||
      Date.parse(iso(row.lease_until)) <= Date.now()
    )
      throw new Error("STUDIO_LEASE_LOST");
    return { pkg, row };
  }
  function active(pkg: StudioPackage) {
    if (pkg.status === "DISCARDED") throw new Error("STUDIO_DISCARDED");
  }
  async function createPackage(
    client: PoolClient,
    ctx: DistributionContext,
    input: {
      masterId: string;
      expectedSourceRevision: number;
      request: StudioGenerationRequest;
      liveWindow?: StudioPackage["source"]["liveWindow"];
    },
  ) {
    await access(client, ctx, "content.create");
    validateStudioGenerationRequest(input.request);
    const { master } = await loadStudioSource(client, ctx.isTest, input.masterId, true);
    requireContentRevision(master.revision, input.expectedSourceRevision);
    if (master.state === "WITHDRAWN") throw new Error("WITHDRAWN");
    const request: StudioGenerationRequest = {
      languages: [...input.request.languages],
      channels: [...input.request.channels],
      instructions: input.request.instructions.trim(),
      captions: input.request.captions,
      ...(input.request.sourceBranding ? { sourceBranding: input.request.sourceBranding } : {}),
      ...(input.request.youtubeClosing
        ? { youtubeClosing: studioYoutubeClosing(input.request.youtubeClosing) }
        : {}),
      ...(input.request.allCompleteMessages !== undefined
        ? { allCompleteMessages: input.request.allCompleteMessages }
        : {}),
    };
    const creationKey = hash({
      masterId: master.id,
      sourceVersionId: master.currentVersion.id,
      sourceRevision: master.revision,
      request,
    });
    const existing = await client.query(
      "SELECT id FROM distribution.studio_package WHERE creation_key=$1 AND is_test=$2 AND deleted_at IS NULL",
      [creationKey, ctx.isTest],
    );
    if (existing.rows[0]) return load(client, ctx.isTest, existing.rows[0].id);
    const id = randomUUID();
    const now = new Date().toISOString();
    const pkg: StudioPackage = {
      id,
      isTest: ctx.isTest,
      revision: 1,
      status: "QUEUED",
      source: {
        ...(input.liveWindow ? { liveWindow: input.liveWindow } : {}),
        masterId: master.id,
        versionId: master.currentVersion.id,
        sha256: master.currentVersion.sha256,
        revision: master.revision,
        title: master.title,
        language: master.language,
        category: master.category,
        mimeType: master.currentVersion.mimeType,
      },
      createdBy: ctx.userId,
      contributorIds: [ctx.userId],
      request,
      outputs: [],
      provenance: null,
      approval: null,
      feedback: [],
      failure: null,
      createdAt: now,
      updatedAt: now,
    };
    await client.query(
      "INSERT INTO distribution.studio_package(id,is_test,master_id,source_version_id,creation_key,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [id, ctx.isTest, master.id, master.currentVersion.id, creationKey, ctx.userId],
    );
    await client.query(
      "INSERT INTO distribution.studio_revision(package_id,is_test,revision,snapshot,actor_id,action) VALUES($1,$2,1,$3,$4,'CREATED')",
      [id, ctx.isTest, pkg, ctx.userId],
    );
    await enqueue(client, pkg, ctx.userId);
    return pkg;
  }
  async function requestGeneration(
    client: PoolClient,
    ctx: DistributionContext,
    id: string,
    input: {
      expectedRevision: number;
      request?: StudioGenerationRequest | undefined;
      outputIds?: string[] | undefined;
      mode?: "ai" | "render" | "closing" | undefined;
      steadyOpening?: true | undefined;
      closingDestinations?: Record<string, "app" | "youtube"> | undefined;
      illustrationTimings?:
        | import("@satsang/distribution-domain").StudioIllustrationTiming[]
        | undefined;
    },
  ) {
    await access(client, ctx, "content.create");
    const pkg = await load(client, ctx.isTest, id, true);
    requireContentRevision(pkg.revision, input.expectedRevision);
    active(pkg);
    if (!studioCanEdit(pkg.status, ["content.create"]))
      throw new Error("INVALID_STUDIO_TRANSITION");
    await sourceCurrent(client, pkg);
    const request = input.request ?? pkg.request;
    const outputIds = studioCorrectionTargets(pkg, input.outputIds);
    if (
      request.youtubeClosing &&
      Object.values(input.closingDestinations ?? {}).some(
        (destination) => destination !== "youtube",
      )
    )
      throw Error("STUDIO_TARGET_SETTINGS_CHANGED");
    if (
      input.closingDestinations &&
      (input.mode === "ai" ||
        !input.mode ||
        !Object.keys(input.closingDestinations).length ||
        Object.entries(input.closingDestinations).some(
          ([id, target]) => !outputIds.includes(id) || !["app", "youtube"].includes(target),
        ))
    )
      throw Error("STUDIO_SELECT_OUTPUTS");
    if (
      (input.illustrationTimings || input.steadyOpening) &&
      (input.mode !== "closing" || outputIds.length !== 1)
    )
      throw Error("STUDIO_SELECT_OUTPUTS");
    if (
      pkg.outputs.length &&
      (!same(request.channels, pkg.request.channels) ||
        !same(request.languages, pkg.request.languages) ||
        request.captions !== pkg.request.captions ||
        !same(request.youtubeClosing, pkg.request.youtubeClosing) ||
        request.sourceBranding !== pkg.request.sourceBranding)
    )
      throw new Error("STUDIO_TARGET_SETTINGS_CHANGED");
    validateStudioGenerationRequest(request);
    const next = await save(client, pkg, ctx.userId, "GENERATION_REQUESTED", {
      status: "QUEUED",
      request,
      generation: outputIds.length
        ? {
            outputIds,
            mode: input.mode ?? "ai",
            ...(input.closingDestinations
              ? { closingDestinations: input.closingDestinations }
              : {}),
            ...(input.steadyOpening ? { steadyOpening: true as const } : {}),
            ...(input.illustrationTimings
              ? { illustrationTimings: input.illustrationTimings }
              : {}),
          }
        : null,
      approval: null,
      failure: null,
      contributorIds: [...new Set([...pkg.contributorIds, ctx.userId])],
    });
    await enqueue(client, next, ctx.userId);
    return next;
  }
  return {
    queueLiveWindow: (isTest: boolean) =>
      transaction(async (client) => {
        const row = (
          await client.query(
            `SELECT w.*,m.requested_by FROM distribution.live_window w
        JOIN distribution.live_broadcast b ON b.id=w.broadcast_id AND b.is_test=w.is_test
        JOIN distribution.live_monitor m ON m.id=b.monitor_id AND m.is_test=b.is_test
        WHERE w.is_test=$1 AND w.package_id IS NULL AND m.enabled=true AND (m.error IS NULL OR m.error NOT IN ('REQUESTER_ROLE_REVOKED','LIVE_CURATION_RIGHTS_REQUIRED','LIVE_CHANNEL_DISABLED','OPERATOR_AUTHORITY_UNAVAILABLE'))
        ORDER BY w.created_at FOR UPDATE OF w SKIP LOCKED LIMIT 1`,
            [isTest],
          )
        ).rows[0];
        if (!row) return false;
        if (!(await fresh(row.requested_by, isTest, "content.create")))
          throw Error("REQUESTER_ROLE_REVOKED");
        const ctx = { userId: row.requested_by, isTest, roles: ["CONTENT_COORDINATOR"] };
        const { master } = await loadStudioSource(client, isTest, row.master_id, true);
        const pkg = await createPackage(client, ctx, {
          masterId: master.id,
          expectedSourceRevision: master.revision,
          request: {
            channels: ["youtube"],
            languages: ["en"],
            captions: true,
            allCompleteMessages: true,
            instructions:
              "Discover complete, self-contained teachings for newcomers to Sri Swamiji. Use original speaker footage by default, accurate English captions, consistent audio and a smooth ending. Do not force generated imagery.",
          },
          liveWindow: {
            broadcastId: row.broadcast_id,
            windowId: row.id,
            startOffsetMs: row.start_ms,
            ownedEndMs: row.owned_end_ms,
          },
        });
        await client.query(
          "UPDATE distribution.live_window SET package_id=$3 WHERE id=$1 AND is_test=$2",
          [row.id, isTest, pkg.id],
        );
        return true;
      }),
    configurePlaylist: (
      ctx: DistributionContext,
      id: string,
      input: Pick<PlaylistCuration, "rights" | "request">,
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        if (!(await fresh(ctx.userId, ctx.isTest, "content.create")))
          throw Error("ONLINE_IMPORT_FORBIDDEN");
        validateContentRights(input.rights);
        validateStudioGenerationRequest(input.request);
        if (
          input.rights.privacyClass !== "PUBLIC" ||
          !input.rights.territories.includes("WORLDWIDE") ||
          input.request.channels.some((channel) => !input.rights.channels.includes(channel)) ||
          (input.rights.releaseAt && Date.parse(input.rights.releaseAt) > Date.now()) ||
          (input.rights.expiresAt && Date.parse(input.rights.expiresAt) <= Date.now())
        )
          throw Error("PLAYLIST_PERMISSIONS_INVALID");
        const result = await client.query(
          "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 FOR UPDATE",
          [id, ctx.isTest],
        );
        const row = result.rows[0];
        if (!row || !isOnlineBundle(row.source) || !row.child_ids?.length)
          throw Error("PLAYLIST_NOT_READY");
        if (row.curation) {
          if (same(row.curation.rights, input.rights) && same(row.curation.request, input.request))
            return;
          throw Error("PLAYLIST_ALREADY_STARTED");
        }
        const curation: PlaylistCuration = {
          rights: input.rights,
          request: input.request,
          requestedBy: ctx.userId,
          confirmedAt: new Date().toISOString(),
          items: {},
        };
        await client.query(
          "UPDATE distribution.online_import SET curation=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
          [id, ctx.isTest, curation],
        );
      }),
    retryPlaylistGeneration: (ctx: DistributionContext, id: string) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        if (!(await fresh(ctx.userId, ctx.isTest, "content.create")))
          throw Error("ONLINE_IMPORT_FORBIDDEN");
        const result = await client.query(
          "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 FOR UPDATE",
          [id, ctx.isTest],
        );
        const row = result.rows[0];
        if (!row || !isOnlineBundle(row.source)) throw Error("NOT_FOUND");
        const plan = row.curation as PlaylistCuration | null;
        if (!plan) return;
        // Only failed jobs resume. Drafts, human review, approved and active work are untouched.
        for (const member of Object.values(plan.items).sort((a, b) =>
          (a.packageId ?? "").localeCompare(b.packageId ?? ""),
        )) {
          if (!member.packageId) continue;
          await client.query("SAVEPOINT playlist_generation_retry");
          try {
            const pkg = await load(client, ctx.isTest, member.packageId, true);
            if (studioNeedsSuitabilityReview(pkg.failure)) {
              // Keep the explanation; repeating unchanged input would incur cost without a fix.
              member.error = pkg.failure as string;
              await client.query("RELEASE SAVEPOINT playlist_generation_retry");
              continue;
            }
            if (pkg.status === "FAILED")
              await requestGeneration(client, ctx, pkg.id, {
                expectedRevision: pkg.revision,
                outputIds: pkg.generation?.outputIds,
                mode: pkg.generation?.mode,
              });
            Reflect.deleteProperty(member, "error");
            await client.query("RELEASE SAVEPOINT playlist_generation_retry");
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT playlist_generation_retry");
            const code = error instanceof Error ? error.message : "";
            member.error = /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : "PLAYLIST_QUEUE_FAILED";
          }
        }
        await client.query(
          "UPDATE distribution.online_import SET curation=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
          [id, ctx.isTest, plan],
        );
      }),
    retryPlaylistItem: (ctx: DistributionContext, id: string, childId: string) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        if (!(await fresh(ctx.userId, ctx.isTest, "content.create")))
          throw Error("ONLINE_IMPORT_FORBIDDEN");
        const result = await client.query(
          "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 FOR UPDATE",
          [id, ctx.isTest],
        );
        const plan = result.rows[0]?.curation as PlaylistCuration | undefined;
        if (!plan?.items[childId]?.error) throw Error("NOT_FOUND");
        // Retry only the failed handoff. Existing generated or approved packages are immutable here.
        delete plan.items[childId];
        await client.query(
          "UPDATE distribution.online_import SET curation=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
          [id, ctx.isTest, plan],
        );
      }),
    queuePlaylistMember: (isTest: boolean, capacity = 2) =>
      transaction(async (client) => {
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 9)
          throw Error("INVALID_STUDIO_QUEUE_CAPACITY");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `playlist-generation:${isTest}`,
        ]);
        if (
          (
            await client.query(
              "SELECT count(*)::int AS count FROM distribution.studio_generation_job WHERE is_test=$1 AND status IN ('QUEUED','RUNNING')",
              [isTest],
            )
          ).rows[0].count >= capacity
        )
          return false;
        // Parent locking plus one DB transaction makes rights, package creation and progress atomic.
        // Membership uses child_ids, including recordings imported before the playlist was added.
        const result = await client.query(
          `SELECT p.* FROM distribution.online_import p WHERE p.is_test=$1 AND p.deleted_at IS NULL AND p.curation IS NOT NULL AND p.curation->>'pausedForCleanup' IS DISTINCT FROM 'true' AND EXISTS (
        SELECT 1 FROM distribution.online_import i WHERE i.is_test=p.is_test AND i.id::text IN (SELECT jsonb_array_elements_text(p.child_ids)) AND i.deleted_at IS NULL AND i.status='COMPLETE' AND i.master_id IS NOT NULL AND NOT (p.curation->'items' ? i.id::text)
      ) ORDER BY p.created_at,p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,
          [isTest],
        );
        const row = result.rows[0];
        if (!row) return false;
        const plan = row.curation as PlaylistCuration;
        const childResult = await client.query(
          `SELECT * FROM distribution.online_import WHERE is_test=$1 AND id::text IN (SELECT jsonb_array_elements_text($2::jsonb)) AND status='COMPLETE' AND master_id IS NOT NULL AND NOT ($3::jsonb ? id::text) ORDER BY array_position(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)),id::text) LIMIT 1`,
          [isTest, JSON.stringify(row.child_ids), JSON.stringify(plan.items)],
        );
        const child = childResult.rows[0];
        if (!child) return false;
        await client.query("SAVEPOINT playlist_member");
        try {
          if (!(await fresh(plan.requestedBy, isTest, "content.create")))
            throw Error("ONLINE_IMPORT_FORBIDDEN");
          // The current authority was just checked. The internal role is scoped to this transaction.
          const ctx = { userId: plan.requestedBy, isTest, roles: ["CONTENT_COORDINATOR"] };
          let { master } = await loadStudioSource(client, isTest, child.master_id, true);
          if (master.state === "WITHDRAWN") throw Error("WITHDRAWN");
          const existing = await client.query(
            `SELECT p.id FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision WHERE p.is_test=$1 AND p.deleted_at IS NULL AND p.master_id=$2 AND p.source_version_id=$3 AND r.snapshot->>'status'<>'DISCARDED' ORDER BY p.updated_at DESC LIMIT 1`,
            [isTest, master.id, master.currentVersion.id],
          );
          if (existing.rows[0])
            plan.items[child.id] = { packageId: existing.rows[0].id, existing: true };
          else {
            // Shared attestation applies to untouched imports. Existing rights are never overwritten.
            if (!master.rights) {
              await recordContentRights(client, ctx, master, plan.rights);
              master = (await loadStudioSource(client, isTest, master.id)).master;
            }
            const decision = studioExternalProcessingDecision(
              master,
              plan.request,
              new Date().toISOString(),
            );
            if (!decision.allowed) throw Error(decision.reason ?? "PLAYLIST_PERMISSIONS_INVALID");
            const pkg = await createPackage(client, ctx, {
              masterId: master.id,
              expectedSourceRevision: master.revision,
              request: plan.request,
            });
            plan.items[child.id] = { packageId: pkg.id, existing: false };
          }
          await client.query("RELEASE SAVEPOINT playlist_member");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT playlist_member");
          const code = error instanceof Error ? error.message : "PLAYLIST_QUEUE_FAILED";
          const known = [
            "ONLINE_IMPORT_FORBIDDEN",
            "OPERATOR_AUTHORITY_UNAVAILABLE",
            "WITHDRAWN",
            "RIGHTS_EXPIRED",
            "RELEASE_PENDING",
            "CHANNEL_NOT_PERMITTED",
            "TERRITORY_NOT_PERMITTED",
            "STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED",
          ];
          plan.items[child.id] = { error: known.includes(code) ? code : "PLAYLIST_QUEUE_FAILED" };
        }
        await client.query(
          "UPDATE distribution.online_import SET curation=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
          [row.id, isTest, plan],
        );
        return true;
      }),
    create: (
      ctx: DistributionContext,
      input: { masterId: string; expectedSourceRevision: number; request: StudioGenerationRequest },
    ) => transaction((client) => createPackage(client, ctx, input)),
    get: (ctx: DistributionContext, id: string) =>
      transaction(async (client) => {
        await access(client, ctx);
        return load(client, ctx.isTest, id);
      }),
    history: (
      ctx: DistributionContext,
      id: string,
      input: { limit?: number; offset?: number } = {},
    ) =>
      transaction(async (client) => {
        await access(client, ctx);
        const limit = input.limit ?? 20;
        const offset = input.offset ?? 0;
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 50 ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > 1000000
        )
          throw new Error("INVALID_PAGINATION");
        const current = await client.query(
          "SELECT id FROM distribution.studio_package WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
          [id, distributionWorld(ctx)],
        );
        if (!current.rows[0]) throw new Error("NOT_FOUND");
        const rows = await client.query(
          "SELECT revision,action,actor_id,created_at,snapshot FROM distribution.studio_revision WHERE package_id=$1 AND is_test=$2 ORDER BY revision DESC LIMIT $3 OFFSET $4",
          [id, distributionWorld(ctx), limit + 1, offset],
        );
        const revisions: StudioRevisionHistoryEntry[] = rows.rows.slice(0, limit).map((row) => ({
          revision: row.revision,
          action: row.action,
          actorId: row.actor_id,
          createdAt: iso(row.created_at),
          package: row.snapshot as StudioPackage,
        }));
        return { revisions, nextOffset: rows.rows.length > limit ? offset + limit : null };
      }),
    list: (
      ctx: DistributionContext,
      input: {
        masterId?: string | undefined;
        status?: StudioPackage["status"] | undefined;
        includeWithdrawn?: boolean | undefined;
        playlistId?: string | undefined;
      } = {},
    ) =>
      transaction(async (client) => {
        await access(client, ctx);
        const rows = await client.query(
          `SELECT p.id FROM distribution.studio_package p
           JOIN distribution.content_master m ON m.id=p.master_id AND m.is_test=p.is_test
           WHERE p.is_test=$1 AND p.deleted_at IS NULL AND m.deleted_at IS NULL AND ($2::uuid IS NULL OR p.master_id=$2)
           AND ($3::boolean OR m.state<>'WITHDRAWN')
           AND ($4::uuid IS NULL OR p.id::text IN (SELECT value->>'packageId' FROM distribution.online_import source CROSS JOIN LATERAL jsonb_each(source.curation->'items') WHERE source.id=$4 AND source.is_test=p.is_test AND source.deleted_at IS NULL))
           ORDER BY p.updated_at DESC,p.id LIMIT 100`,
          [
            ctx.isTest,
            input.masterId ?? null,
            input.includeWithdrawn ?? false,
            input.playlistId ?? null,
          ],
        );
        const values = await Promise.all(rows.rows.map((row) => load(client, ctx.isTest, row.id)));
        return input.status ? values.filter((value) => value.status === input.status) : values;
      }),
    enqueueGeneration: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        request?: StudioGenerationRequest | undefined;
        outputIds?: string[] | undefined;
        mode?: "ai" | "render" | "closing" | undefined;
        steadyOpening?: true | undefined;
        closingDestinations?: Record<string, "app" | "youtube"> | undefined;
        illustrationTimings?:
          | import("@satsang/distribution-domain").StudioIllustrationTiming[]
          | undefined;
      },
    ) => transaction((client) => requestGeneration(client, ctx, id, input)),
    appendMessage: (
      ctx: DistributionContext,
      id: string,
      input: { expectedRevision: number; message: StudioAdditionalMessage; comment: string },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        if (!(await fresh(ctx.userId, ctx.isTest, "content.create")))
          throw new Error("REQUESTER_ROLE_REVOKED");
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        active(pkg);
        await sourceCurrent(client, pkg);
        const outputId = randomUUID();
        const outputs = appendStudioMessage(pkg, input.message, outputId);
        const next = await save(
          client,
          pkg,
          ctx.userId,
          "MESSAGE_ADDED",
          {
            outputs,
            status: "QUEUED",
            approval: null,
            failure: null,
            generation: { outputIds: [outputId], mode: "render" },
            contributorIds: [...new Set([...pkg.contributorIds, ctx.userId])],
          },
          { action: "REVISED", comment: comment(input.comment) },
        );
        await enqueue(client, next, ctx.userId);
        return next;
      }),
    revise: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        outputs: (Pick<StudioOutput, "id" | "title" | "body" | "included"> & {
          sourceSegmentIds?: string[] | undefined;
          captionCues?: StudioOutput["captionCues"] | undefined;
        })[];
        comment: string;
      },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        active(pkg);
        if (!studioCanEdit(pkg.status, ["content.create"]))
          throw new Error("INVALID_STUDIO_TRANSITION");
        const note = comment(input.comment);
        if (
          !input.outputs.length ||
          input.outputs.some((edit) => !pkg.outputs.some((o) => o.id === edit.id)) ||
          new Set(input.outputs.map((value) => value.id)).size !== input.outputs.length
        )
          throw new Error("INVALID_STUDIO_OUTPUTS");
        const outputs = pkg.outputs.map((output) => {
          const edit = input.outputs.find((value) => value.id === output.id);
          if (!edit) return output;
          const sourceSegmentIds = edit.sourceSegmentIds ?? output.sourceSegmentIds;
          const transcript = pkg.provenance?.transcript;
          if (!transcript) throw new Error("GENERATION_REQUIRED");
          const range = studioSourceRange(sourceSegmentIds, transcript, output.format);
          const captionCues = edit.captionCues ?? output.captionCues;
          if (
            captionCues &&
            (captionCues.length !== range.segments.length ||
              captionCues.some((cue, i) => {
                const source = range.segments[i];
                return (
                  !source ||
                  cue.id !== source.id ||
                  cue.startMs !== source.startMs ||
                  cue.endMs !== source.endMs ||
                  !cue.text.trim() ||
                  cue.text.length > 4000
                );
              }))
          )
            throw new Error("INVALID_STUDIO_CAPTIONS");
          const changed =
            edit.title !== output.title ||
            edit.body !== output.body ||
            !same(sourceSegmentIds, output.sourceSegmentIds) ||
            !same(captionCues, output.captionCues);
          const revised = {
            ...output,
            title: edit.title,
            body: edit.body,
            included: edit.included,
            sourceSegmentIds,
            ...(["short", "reel"].includes(output.format)
              ? { startMs: range.startMs, endMs: range.endMs }
              : {}),
            ...(captionCues ? { captionCues } : {}),
            ...(changed
              ? {
                  asset: null,
                  captions: [],
                  aiReview: null,
                  presentationReview: null,
                  postArt: null,
                }
              : {}),
          };
          // Title artwork describes the rendered file; retain neither after a source/copy edit.
          const { thumbnail: _thumbnail, ...withoutThumbnail } = revised;
          return changed ? withoutThumbnail : revised;
        });
        validateStudioOutputs(outputs, {
          packageId: pkg.id,
          source: pkg.source,
          request: pkg.request,
          provenance: pkg.provenance,
        });
        return save(
          client,
          pkg,
          ctx.userId,
          "REVISED",
          {
            outputs,
            status: "DRAFT",
            approval: null,
            failure: null,
            contributorIds: [...new Set([...pkg.contributorIds, ctx.userId])],
          },
          { action: "REVISED", comment: note },
        );
      }),
    submit: (
      ctx: DistributionContext,
      id: string,
      input: { expectedRevision: number; comment?: string | undefined },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        if (!["DRAFT", "CHANGES_REQUESTED"].includes(pkg.status))
          throw new Error("INVALID_STUDIO_TRANSITION");
        if (pkg.outputs.some((o) => o.included && o.correction?.state === "pending"))
          throw new Error("STUDIO_CORRECTIONS_PENDING");
        const reasons = studioPackageBlockers(pkg, await sourceCurrent(client, pkg));
        if (reasons.length) throw new Error(reasons[0]);
        return save(
          client,
          pkg,
          ctx.userId,
          "SUBMITTED",
          {
            status: "IN_REVIEW",
            approval: null,
            outputs: pkg.outputs.map((o) =>
              o.correction?.state === "revised"
                ? { ...o, correction: { ...o.correction, state: "submitted" as const } }
                : o,
            ),
          },
          { action: "SUBMITTED", comment: comment(input.comment) },
        );
      }),
    review: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        decision: "APPROVED" | "REJECTED" | "DISCARDED";
        outputIds?: string[] | undefined;
        comment?: string | undefined;
        confirmTranscript?: boolean | undefined;
        confirmTeachingIntegrity?: boolean | undefined;
      },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.review");
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        if (pkg.status !== "IN_REVIEW") throw new Error("INVALID_STUDIO_TRANSITION");
        if (!["APPROVED", "REJECTED", "DISCARDED"].includes(input.decision))
          throw new Error("INVALID_REVIEW");
        requireIndependentContentReview(
          ctx.userId,
          pkg.contributorIds,
          await reviewerRoles(ctx.userId, ctx.isTest),
        );
        const note = comment(input.comment, input.decision === "REJECTED");
        const targets = input.outputIds ?? pkg.outputs.filter((o) => o.included).map((o) => o.id);
        if (
          !targets.length ||
          new Set(targets).size !== targets.length ||
          targets.some((id) => !pkg.outputs.some((o) => o.id === id && o.included))
        )
          throw new Error("STUDIO_SELECT_OUTPUTS");
        if (input.outputIds && input.decision !== "REJECTED") throw new Error("INVALID_REVIEW");
        const outputs = pkg.outputs.map((o) =>
          input.decision === "REJECTED" && targets.includes(o.id)
            ? {
                ...o,
                correction: {
                  comment: note,
                  reviewerId: ctx.userId,
                  requestedAt: new Date().toISOString(),
                  state: "pending" as const,
                  before: {
                    title: o.title,
                    body: o.body,
                    sourceSegmentIds: o.sourceSegmentIds,
                    ...(o.captionCues ? { captionCues: o.captionCues } : {}),
                    ...(o.aiReview ? { aiReview: o.aiReview } : {}),
                  },
                },
              }
            : input.decision === "APPROVED" && o.correction
              ? { ...o, correction: { ...o.correction, state: "resolved" as const } }
              : o,
        );
        let approval: StudioPackage["approval"] = null;
        if (input.decision === "APPROVED") {
          const reasons = studioPackageBlockers(pkg);
          if (reasons.length) throw new Error(reasons[0]);
          if (!input.confirmTeachingIntegrity)
            throw new Error("TEACHING_INTEGRITY_CONFIRMATION_REQUIRED");
          if (
            pkg.provenance?.transcript.provenance === "MACHINE_TRANSCRIPT" &&
            !input.confirmTranscript
          )
            throw new Error("MACHINE_TRANSCRIPT_CONFIRMATION_REQUIRED");
          const master = await sourceRights(client, pkg);
          await requireIndependentSourceReview(client, {
            isTest: ctx.isTest,
            masterId: master.id,
            versionId: master.currentVersion.id,
            reviewerId: ctx.userId,
            reviewerRoles: await reviewerRoles(ctx.userId, ctx.isTest),
          });
          await qualifiedReviewer(client, pkg, ctx.userId);
          approval = {
            reviewerId: ctx.userId,
            revision: pkg.revision + 1,
            sourceRevision: master.revision,
            approvedAt: new Date().toISOString(),
          };
        }
        return save(
          client,
          pkg,
          ctx.userId,
          input.decision === "APPROVED"
            ? pkg.provenance?.transcript.provenance === "MACHINE_TRANSCRIPT"
              ? "APPROVED_TEACHING_AND_MACHINE_TRANSCRIPT"
              : "APPROVED_TEACHING_AND_APPROVED_TRANSCRIPT"
            : input.decision,
          {
            status: input.decision === "REJECTED" ? "CHANGES_REQUESTED" : input.decision,
            approval,
            outputs,
          },
          { action: input.decision, comment: note },
        );
      }),
    discard: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        comment?: string | undefined;
        outputId?: string | undefined;
      },
    ) =>
      transaction(async (client) => {
        await access(client, ctx);
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        active(pkg);
        const capabilities = await distributionCapabilities(client, ctx);
        if (!studioCanDiscard(pkg.status, capabilities, input.outputId ? "output" : "package"))
          throw new Error("FORBIDDEN");
        if (input.outputId) {
          if (!pkg.outputs.some((value) => value.id === input.outputId))
            throw new Error("NOT_FOUND");
          return save(
            client,
            pkg,
            ctx.userId,
            "DISCARDED",
            {
              status: studioStatusAfterOutputDiscard(pkg.status),
              outputs: pkg.outputs.map((value) =>
                value.id === input.outputId ? { ...value, included: false } : value,
              ),
              approval: null,
              // A curator changing the draft selection contributes to that revision.
              // Review-stage exclusion is an approver decision, not content authorship.
              contributorIds: studioCanEdit(pkg.status, capabilities)
                ? [...new Set([...pkg.contributorIds, ctx.userId])]
                : pkg.contributorIds,
            },
            { action: "DISCARDED", comment: comment(input.comment) },
          );
        }
        return save(
          client,
          pkg,
          ctx.userId,
          "DISCARDED",
          { status: "DISCARDED", approval: null },
          { action: "DISCARDED", comment: comment(input.comment) },
        );
      }),
    getOutputAsset: (
      ctx: DistributionContext,
      id: string,
      outputId: string,
      input: {
        kind: "asset" | "caption" | "thumbnail";
        language?: string | undefined;
        forExport?: boolean | undefined;
      },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, input.forExport ? "content.publish" : undefined);
        const pkg = await load(client, ctx.isTest, id);
        active(pkg);
        await sourceCurrent(client, pkg);
        if (input.forExport) await publicationEligible(client, pkg, false);
        const output = pkg.outputs.find((value) => value.id === outputId);
        if (input.forExport && !output?.included) throw new Error("OUTPUT_EXCLUDED");
        const asset =
          input.kind === "asset"
            ? output?.asset
            : input.kind === "thumbnail"
              ? output?.thumbnail
              : output?.captions.find((value) => value.language === input.language)?.asset;
        if (!asset) throw new Error("NOT_FOUND");
        return asset;
      }),
    claimGeneration: (input: {
      isTest: boolean;
      workerId: string;
      jobId?: string | undefined;
      leaseMs?: number | undefined;
    }) =>
      transaction(async (client): Promise<StudioGenerationClaim | null> => {
        const leaseMs = worker(input);
        for (let i = 0; i < 20; i++) {
          const candidate = await client.query(
            "SELECT * FROM distribution.studio_generation_job WHERE is_test=$1 AND ($2::uuid IS NULL OR id=$2) AND ((status='QUEUED' AND available_at<=clock_timestamp()) OR (status='RUNNING' AND lease_until<=clock_timestamp())) ORDER BY created_at,id LIMIT 1",
            [input.isTest, input.jobId ?? null],
          );
          const row = candidate.rows[0];
          if (!row) return null;
          const pkg = await load(client, input.isTest, row.package_id, true);
          const locked = await client.query(
            "SELECT * FROM distribution.studio_generation_job WHERE id=$1 AND is_test=$2 AND ((status='QUEUED' AND available_at<=clock_timestamp()) OR (status='RUNNING' AND lease_until<=clock_timestamp())) FOR UPDATE SKIP LOCKED",
            [row.id, input.isTest],
          );
          const current = locked.rows[0];
          if (!current) continue;
          let reason: string | null = null;
          if (
            pkg.revision !== current.package_revision ||
            !["QUEUED", "GENERATING"].includes(pkg.status)
          )
            reason = "PACKAGE_CHANGED";
          else if (current.attempts >= 3) reason = "RETRY_EXHAUSTED";
          else if (!(await fresh(current.requested_by, input.isTest, "content.create")))
            reason = "REQUESTER_ROLE_REVOKED";
          else {
            try {
              await sourceCurrent(client, pkg);
            } catch (error) {
              if (!(error instanceof Error) || error.message !== "SOURCE_DEPENDENCY_CHANGED")
                throw error;
              reason = error.message;
            }
          }
          if (reason) {
            await generationState(client, row.id, input.isTest, "STALE", reason);
            if (
              pkg.revision === current.package_revision &&
              ["QUEUED", "GENERATING"].includes(pkg.status)
            )
              await save(client, pkg, current.requested_by, "GENERATION_FAILED", {
                status: "FAILED",
                failure: reason,
              });
            continue;
          }
          const leaseToken = randomUUID();
          await client.query(
            "UPDATE distribution.studio_generation_job SET status='RUNNING',attempts=attempts+1,lease_token=$3,lease_owner=$4,lease_until=clock_timestamp()+($5::int*interval '1 millisecond'),last_error=NULL,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
            [row.id, input.isTest, leaseToken, input.workerId, leaseMs],
          );
          const { source, master } = await loadStudioSource(
            client,
            input.isTest,
            pkg.source.masterId,
          );
          return {
            id: row.id,
            checkpoint: (
              await client.query(
                "SELECT generation_checkpoint FROM distribution.studio_package WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
                [pkg.id, pkg.isTest],
              )
            ).rows[0].generation_checkpoint,
            package: { ...pkg, status: "GENERATING" },
            source,
            transcript: await currentStudioTranscript(client, input.isTest, pkg.source.versionId),
            externalProcessing: studioExternalProcessingDecision(
              master,
              pkg.request,
              new Date().toISOString(),
            ),
            leaseToken,
            leaseOwner: input.workerId,
            attempts: current.attempts + 1,
          };
        }
        return null;
      }),
    renewGeneration: (claim: StudioGenerationClaim, leaseMs = 240000) =>
      transaction(async (client) => {
        worker({ isTest: claim.package.isTest, workerId: claim.leaseOwner, leaseMs });
        let state: Awaited<ReturnType<typeof checkedGeneration>>;
        try {
          state = await checkedGeneration(client, claim);
        } catch (error) {
          if (error instanceof Error && error.message === "STUDIO_LEASE_LOST") return false;
          throw error;
        }
        const { pkg, row } = state;
        if (pkg.revision !== row.package_revision || !["QUEUED", "GENERATING"].includes(pkg.status))
          return false;
        if (!(await fresh(row.requested_by, pkg.isTest, "content.create"))) return false;
        try {
          const master = await sourceCurrent(client, pkg);
          if (
            claim.externalProcessing.allowed &&
            !studioExternalProcessingDecision(master, pkg.request, new Date().toISOString()).allowed
          )
            return false;
        } catch (error) {
          if (error instanceof Error && error.message === "SOURCE_DEPENDENCY_CHANGED") return false;
          throw error;
        }
        const changed = await client.query(
          "UPDATE distribution.studio_generation_job SET lease_until=clock_timestamp()+($3::int*interval '1 millisecond'),updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 AND lease_token=$4 AND lease_until>clock_timestamp()",
          [row.id, pkg.isTest, leaseMs, claim.leaseToken],
        );
        return changed.rowCount === 1;
      }),
    checkpointGeneration: (
      claim: StudioGenerationClaim,
      input:
        | { key: string; fingerprint: string; value: unknown }
        | { progress: StudioGenerationProgress },
    ) =>
      transaction(async (client) => {
        const { pkg, row } = await checkedGeneration(client, claim);
        if (pkg.revision !== row.package_revision || !["QUEUED", "GENERATING"].includes(pkg.status))
          throw new Error("STUDIO_LEASE_LOST");
        if (!(await fresh(row.requested_by, pkg.isTest, "content.create")))
          throw new Error("REQUESTER_ROLE_REVOKED");
        const master = await sourceCurrent(client, pkg);
        if (
          claim.externalProcessing.allowed &&
          !studioExternalProcessingDecision(master, pkg.request, new Date().toISOString()).allowed
        )
          throw new Error("STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED");
        if ("progress" in input) {
          await client.query(
            "UPDATE distribution.studio_generation_job SET progress=$3,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
            [claim.id, pkg.isTest, input.progress],
          );
        } else {
          if (
            !/^[a-z0-9:_-]{1,160}$/.test(input.key) ||
            !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
            JSON.stringify(input.value).length > 4 * 1024 * 1024
          )
            throw new Error("STUDIO_CACHE_INVALID");
          await client.query(
            "UPDATE distribution.studio_package SET generation_checkpoint=jsonb_set(generation_checkpoint,ARRAY[$3::text],$4::jsonb) WHERE id=$1 AND is_test=$2",
            [
              pkg.id,
              pkg.isTest,
              input.key,
              JSON.stringify({ fingerprint: input.fingerprint, value: input.value }),
            ],
          );
        }
      }),
    deferGeneration: (
      claim: StudioGenerationClaim,
      code: string,
      delayMs: number,
      progress: StudioGenerationProgress,
    ) =>
      transaction(async (client) => {
        const { pkg, row } = await checkedGeneration(client, claim);
        if (pkg.revision !== row.package_revision || !["QUEUED", "GENERATING"].includes(pkg.status))
          return false;
        if (row.attempts >= 3) return false;
        const delay = Math.min(3600000, Math.max(30000, delayMs));
        await client.query(
          "UPDATE distribution.studio_generation_job SET status='QUEUED',available_at=clock_timestamp()+($3::int*interval '1 millisecond'),last_error=$4,progress=$5,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
          [
            claim.id,
            pkg.isTest,
            delay,
            failure(code),
            {
              ...progress,
              errorCode: failure(code),
              retryAt: new Date(Date.now() + delay).toISOString(),
            },
          ],
        );
        return true;
      }),
    completeGeneration: (
      claim: StudioGenerationClaim,
      result: { outputs: StudioOutput[]; provenance: StudioProvenance },
    ) =>
      transaction(async (client): Promise<Eligibility> => {
        const { pkg, row } = await checkedGeneration(client, claim);
        if (
          pkg.revision !== row.package_revision ||
          !["QUEUED", "GENERATING"].includes(pkg.status)
        ) {
          await generationState(client, row.id, pkg.isTest, "STALE", "PACKAGE_CHANGED");
          return { accepted: false, reason: "PACKAGE_CHANGED" };
        }
        if (!(await fresh(row.requested_by, pkg.isTest, "content.create"))) {
          await generationState(client, row.id, pkg.isTest, "STALE", "REQUESTER_ROLE_REVOKED");
          await save(client, pkg, row.requested_by, "GENERATION_FAILED", {
            status: "FAILED",
            failure: "REQUESTER_ROLE_REVOKED",
          });
          return { accepted: false, reason: "REQUESTER_ROLE_REVOKED" };
        }
        try {
          await sourceCurrent(client, pkg);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "SOURCE_DEPENDENCY_CHANGED")
            throw error;
          await generationState(client, row.id, pkg.isTest, "STALE", error.message);
          await save(client, pkg, row.requested_by, "GENERATION_FAILED", {
            status: "FAILED",
            failure: error.message,
          });
          return { accepted: false, reason: error.message };
        }
        validateStudioProvenance(result.provenance);
        if (
          result.provenance.provider !== "local" ||
          result.provenance.transcript.recognition !== undefined ||
          claim.externalProcessing.allowed
        ) {
          const master = await sourceCurrent(client, pkg);
          if (
            !claim.externalProcessing.allowed ||
            !studioExternalProcessingDecision(master, pkg.request, new Date().toISOString()).allowed
          ) {
            await generationState(
              client,
              row.id,
              pkg.isTest,
              "STALE",
              "STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED",
            );
            await save(client, pkg, row.requested_by, "GENERATION_FAILED", {
              status: "FAILED",
              failure: "STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED",
            });
            return { accepted: false, reason: "STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED" };
          }
        }
        if (pkg.generation)
          assertStudioCorrectionIsolation(pkg.outputs, result.outputs, pkg.generation.outputIds);
        validateStudioOutputs(result.outputs, {
          packageId: pkg.id,
          source: pkg.source,
          request: pkg.request,
          provenance: result.provenance,
        });
        await transcriptCurrent(client, { ...pkg, provenance: result.provenance });
        const next = await save(client, pkg, row.requested_by, "GENERATED", {
          status: "DRAFT",
          outputs: result.outputs,
          generation: null,
          provenance: result.provenance,
          approval: null,
          failure: null,
        });
        await generationState(client, row.id, pkg.isTest, "SUCCEEDED", null);
        return { accepted: true, package: next };
      }),
    failGeneration: (
      claim: StudioGenerationClaim,
      code: string,
      progress?: StudioGenerationProgress,
    ) =>
      transaction(async (client) => {
        const { pkg, row } = await checkedGeneration(client, claim);
        const reason = failure(code);
        // Persist the cause and terminal state atomically. Recording a failure must not
        // depend on another external role lookup that could mask the original exception.
        if (progress)
          await client.query(
            "UPDATE distribution.studio_generation_job SET progress=$3 WHERE id=$1 AND is_test=$2",
            [claim.id, pkg.isTest, { ...progress, errorCode: reason }],
          );
        await generationState(client, row.id, pkg.isTest, "FAILED", reason);
        if (pkg.revision === row.package_revision && ["QUEUED", "GENERATING"].includes(pkg.status))
          await save(client, pkg, row.requested_by, "GENERATION_FAILED", {
            status: "FAILED",
            failure: reason,
          });
      }),
    publish: (
      ctx: DistributionContext,
      id: string,
      input: { expectedRevision: number; accounts?: Partial<Record<StudioChannel, string>> },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.publish");
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        await publicationEligible(client, pkg);
        const previous = await client.query(
          "SELECT * FROM distribution.studio_publication_job WHERE package_id=$1 AND is_test=$2 AND package_revision=$3 FOR UPDATE",
          [pkg.id, pkg.isTest, pkg.revision],
        );
        for (const row of previous.rows) {
          const selected = input.accounts?.[row.channel as StudioChannel];
          if (!selected || row.account_id === selected) continue;
          if (
            row.account_id ||
            !["QUEUED", "BLOCKED"].includes(row.status) ||
            row.remote_id ||
            row.checkpoint
          )
            throw Error("STUDIO_PUBLISH_ACCOUNT_CHANGED");
          await client.query(
            "UPDATE distribution.studio_publication_job SET account_id=$3 WHERE id=$1 AND is_test=$2",
            [row.id, pkg.isTest, selected],
          );
        }
        for (const output of pkg.outputs.filter((value) => value.included))
          await client.query(
            "INSERT INTO distribution.studio_publication_job(package_id,is_test,package_revision,output_id,channel,requested_by,account_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(package_id,is_test,package_revision,output_id) DO NOTHING",
            [
              pkg.id,
              pkg.isTest,
              pkg.revision,
              output.id,
              output.channel,
              ctx.userId,
              input.accounts?.[output.channel] ?? null,
            ],
          );
        const blocked = await client.query(
          "SELECT * FROM distribution.studio_publication_job WHERE package_id=$1 AND is_test=$2 AND package_revision=$3 AND status='BLOCKED' AND remote_id IS NULL AND checkpoint IS NULL FOR UPDATE",
          [pkg.id, pkg.isTest, pkg.revision],
        );
        for (const row of blocked.rows) {
          await client.query(
            "UPDATE distribution.studio_publication_job SET status='QUEUED',last_error=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
            [row.id, pkg.isTest],
          );
          await attempt(client, row, "QUEUED", {
            action: "EXPLICIT_RETRY",
            requestedBy: ctx.userId,
            previousError: row.last_error,
          });
        }
        const rows = await client.query(
          "SELECT * FROM distribution.studio_publication_job WHERE package_id=$1 AND is_test=$2 AND package_revision=$3 ORDER BY created_at,id",
          [pkg.id, pkg.isTest, pkg.revision],
        );
        return rows.rows.map(publication);
      }),
    listPublications: (ctx: DistributionContext, id: string) =>
      transaction(async (client) => {
        await access(client, ctx);
        await load(client, ctx.isTest, id);
        const rows = await client.query(
          "SELECT * FROM distribution.studio_publication_job WHERE package_id=$1 AND is_test=$2 ORDER BY created_at,id",
          [id, ctx.isTest],
        );
        return rows.rows.map(publication);
      }),
    claimPublication: (input: {
      isTest: boolean;
      workerId: string;
      publicationId?: string | undefined;
      leaseMs?: number | undefined;
    }) =>
      transaction(async (client): Promise<StudioPublicationClaim | null> => {
        const leaseMs = worker(input);
        for (let i = 0; i < 20; i++) {
          const rows = await client.query(
            "SELECT * FROM distribution.studio_publication_job WHERE is_test=$1 AND ($2::uuid IS NULL OR id=$2) AND ((status IN ('QUEUED','PROCESSING') AND available_at<=clock_timestamp()) OR (status='RUNNING' AND lease_until<=clock_timestamp())) ORDER BY created_at,id LIMIT 1",
            [input.isTest, input.publicationId ?? null],
          );
          const initial = rows.rows[0];
          if (!initial) return null;
          const pkg = await load(client, input.isTest, initial.package_id, true);
          const locked = await client.query(
            "SELECT * FROM distribution.studio_publication_job WHERE id=$1 AND is_test=$2 AND ((status IN ('QUEUED','PROCESSING') AND available_at<=clock_timestamp()) OR (status='RUNNING' AND lease_until<=clock_timestamp())) FOR UPDATE SKIP LOCKED",
            [initial.id, input.isTest],
          );
          const row = locked.rows[0];
          if (!row) continue;
          if (row.status === "RUNNING") {
            await publicationState(client, row, "UNCERTAIN", "PUBLICATION_LEASE_EXPIRED");
            continue;
          }
          if (pkg.revision !== row.package_revision) {
            await publicationState(client, row, "CANCELLED", "PACKAGE_CHANGED");
            continue;
          }
          try {
            await publicationEligible(client, pkg);
            if (!(await fresh(row.requested_by, input.isTest, "content.publish")))
              throw new Error("PUBLISHER_ROLE_REVOKED");
          } catch (error) {
            if (!(error instanceof Error) || !publicationRefusals.has(error.message)) throw error;
            await publicationState(
              client,
              row,
              "BLOCKED",
              error instanceof Error ? error.message : "PUBLICATION_BLOCKED",
            );
            continue;
          }
          const output = pkg.outputs.find((value) => value.id === row.output_id && value.included);
          if (!output) {
            await publicationState(client, row, "CANCELLED", "OUTPUT_CHANGED");
            continue;
          }
          if (row.status === "PROCESSING" && (!row.checkpoint || !row.remote_id)) {
            await publicationState(client, row, "UNCERTAIN", "PROCESSING_CHECKPOINT_MISSING");
            continue;
          }
          const leaseToken = randomUUID();
          const updated = await client.query(
            "UPDATE distribution.studio_publication_job SET status='RUNNING',attempts=attempts+1,lease_token=$3,lease_owner=$4,lease_until=clock_timestamp()+($5::int*interval '1 millisecond'),updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 RETURNING *",
            [row.id, input.isTest, leaseToken, input.workerId, leaseMs],
          );
          const claimed = updated.rows[0] as QueryResultRow;
          await attempt(client, claimed, "RUNNING", { resuming: row.status === "PROCESSING" });
          return {
            publication: publication(claimed),
            package: pkg,
            output,
            checkpoint: row.checkpoint ?? null,
            leaseToken,
            leaseOwner: input.workerId,
          };
        }
        return null;
      }),
    revalidatePublication: (claim: StudioPublicationClaim) =>
      transaction(async (client): Promise<Eligibility> => {
        const { pkg, row } = await checkedPublication(client, claim);
        try {
          if (pkg.revision !== row.package_revision) throw new Error("PACKAGE_CHANGED");
          await publicationEligible(client, pkg);
          if (!(await fresh(row.requested_by, pkg.isTest, "content.publish")))
            throw new Error("PUBLISHER_ROLE_REVOKED");
          return { accepted: true, package: pkg };
        } catch (error) {
          if (!(error instanceof Error) || !publicationRefusals.has(error.message)) throw error;
          const reason = error instanceof Error ? error.message : "PUBLICATION_BLOCKED";
          await publicationState(client, row, "BLOCKED", reason);
          return { accepted: false, reason };
        }
      }),
    completePublication: (
      claim: StudioPublicationClaim,
      input: {
        status: "PUBLISHED" | "PROCESSING" | "SIMULATED" | "BLOCKED" | "FAILED" | "UNCERTAIN";
        accountId?: string | null;
        remoteId?: string | null;
        remoteUrl?: string | null;
        error?: string | null;
        checkpoint?: Record<string, unknown> | null;
        retryAfterSeconds?: number;
      },
    ) =>
      transaction(async (client) => {
        const { pkg, row } = await checkedPublication(client, claim);
        if (
          !["PUBLISHED", "PROCESSING", "SIMULATED", "BLOCKED", "FAILED", "UNCERTAIN"].includes(
            input.status,
          ) ||
          (pkg.isTest && ["PUBLISHED", "PROCESSING"].includes(input.status)) ||
          (!pkg.isTest && input.status === "SIMULATED")
        )
          throw new Error("INVALID_PUBLICATION_RESULT");
        const checkpoint = input.checkpoint ?? row.checkpoint ?? null;
        const remoteId = input.remoteId ?? row.remote_id ?? null;
        const remoteUrl = input.remoteUrl ?? row.remote_url ?? null;
        const retryAfterSeconds = input.retryAfterSeconds ?? 30;
        if (
          !Number.isSafeInteger(retryAfterSeconds) ||
          retryAfterSeconds < 1 ||
          retryAfterSeconds > 86400 ||
          JSON.stringify(checkpoint).length > 16000 ||
          [input.accountId, remoteId, remoteUrl, input.error].some(
            (value) =>
              value != null &&
              (typeof value !== "string" || value.length > 2000 || value.includes("\u0000")),
          ) ||
          (input.status === "PROCESSING" && (!checkpoint || !remoteId)) ||
          (remoteUrl && !/^https:\/\/[^\s]+$/.test(remoteUrl))
        )
          throw new Error("INVALID_PUBLICATION_RESULT");
        const rows = await client.query(
          "UPDATE distribution.studio_publication_job SET status=$3,account_id=coalesce($4,account_id),remote_id=$5,remote_url=$6,last_error=$7,checkpoint=$8,available_at=clock_timestamp()+($9::int*interval '1 second'),lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 RETURNING *",
          [
            row.id,
            pkg.isTest,
            input.status,
            input.accountId ?? null,
            remoteId,
            remoteUrl,
            input.error ?? null,
            checkpoint,
            retryAfterSeconds,
          ],
        );
        await attempt(client, row, input.status, { remoteId, error: input.error ?? null });
        return publication(rows.rows[0] as QueryResultRow);
      }),
    publicationMedia: (id: string) =>
      transaction(async (client) => {
        const row = await publicationRow(client, false, id);
        if (!["RUNNING", "PROCESSING", "PUBLISHED"].includes(row.status))
          throw new Error("NOT_FOUND");
        const pkg = await load(client, false, row.package_id);
        if (pkg.revision !== row.package_revision) throw new Error("PACKAGE_CHANGED");
        await publicationEligible(client, pkg);
        const output = pkg.outputs.find((value) => value.id === row.output_id && value.included);
        if (!output?.asset) throw new Error("NOT_FOUND");
        return { publication: publication(row), package: pkg, output };
      }),
    publishedBlog: (id: string) =>
      transaction(async (client) => {
        const row = await publicationRow(client, false, id);
        if (row.status !== "PUBLISHED" || row.channel !== "website") throw new Error("NOT_FOUND");
        const pkg = await load(client, false, row.package_id);
        if (pkg.revision !== row.package_revision) throw new Error("PACKAGE_CHANGED");
        await publicationEligible(client, pkg);
        const output = pkg.outputs.find(
          (value) => value.id === row.output_id && value.included && value.format === "blog",
        );
        if (!output?.asset) throw new Error("NOT_FOUND");
        return { publication: publication(row), package: pkg, output };
      }),
  };
}

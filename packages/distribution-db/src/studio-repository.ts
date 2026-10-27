import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sourceRequiresLanguageAssignment } from "@satsang/distribution-domain";
import { isOnlineBundle } from "@satsang/distribution-domain";
import {
  type ContentMaster,
  type DistributionChannel,
  type PlaylistCuration,
  type PostingCheck,
  STUDIO_PUBLISHING_PAUSE_REJECTIONS,
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
  assertStudioDiscoveryIsolation,
  contentExportDecision,
  postingCheckBlock,
  prepareStudioYoutubeClosingRefresh,
  requireContentRevision,
  requireIndependentContentReview,
  requirePlaylistSettingsEditable,
  studioAggregateFileStatus,
  studioCanDiscard,
  studioCanEdit,
  studioCanEditFile,
  studioCorrectionTargets,
  studioExternalProcessingDecision,
  studioFileApproval,
  studioFileStatus,
  studioKnownPostingMatch,
  studioNeedsSuitabilityReview,
  studioPackageBlockers,
  studioPublicationRetryDecision,
  studioPublishingFormatBlock,
  studioPublishingShouldPause,
  studioRetractionDecision,
  studioSelectedOutputs,
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
import { validateStudioClosingReplacement } from "./studio-closing-replacement.js";
import { materializeFileWorkflows, studioFileFingerprint } from "./studio-file-review.js";
import { studioGenerationPreviews } from "./studio-generation-previews.js";
import { createStudioGenerationRecovery } from "./studio-generation-recovery.js";
import { joinStudioQueueFence } from "./studio-queue-fence.js";
import { createStudioSeriesWorkflow } from "./studio-series-workflow.js";
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
  "STUDIO_EXPORT_CARD_MISMATCH",
  "STUDIO_EXPORT_CAPTIONS_INVALID",
  "STUDIO_EXPORT_INVALID",
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
  "RENDER_TIMEOUT",
  "RENDER_STALLED",
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
  "STUDIO_PROVIDER_SPEND_CAP_REACHED",
  "STUDIO_PROVIDER_BILLING_REQUIRED",
  "STUDIO_PROVIDER_REQUEST_INVALID",
  "STUDIO_NO_SUITABLE_CHANNELS",
  "STUDIO_TRANSCRIPTION_START_UNCERTAIN",
  "STUDIO_TRANSCRIPTION_CONTEXT_LIMIT",
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
  "STUDIO_CLOSING_PRESERVATION_FAILED",
  "STUDIO_CLOSING_FOOTER_REVIEW_REQUIRED",
  "STUDIO_CLOSING_TIMELINE_CHANGED",
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
  "STUDIO_DISCOVERY_REVIEW_INVALID",
  "STUDIO_DISCOVERY_ISOLATION_REQUIRED",
  "INVALID_STUDIO_DISCOVERY_COVERAGE",
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
    duplicateCheck: row.duplicate_check ?? null,
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
      await joinStudioQueueFence(client);
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
  /** A revoked-authority refusal names the operator so an Admin can review that account. */
  function revoked(code: "REVIEWER_ROLE_REVOKED" | "REQUESTER_ROLE_REVOKED", operatorId: string) {
    return Object.assign(new Error(code), { operatorId });
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
      "SELECT r.snapshot,r.action FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision WHERE p.id=$1 AND p.is_test=$2 AND p.deleted_at IS NULL",
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
    // Only the audited pause revision may expose unfinished draft checkpoints.
    // Editing the package or completing generation ends this read-only exception.
    const pausedForSettings =
      result.status === "DRAFT" && rows.rows[0]?.action === "PLAYLIST_SETTINGS_PAUSED";
    if (["QUEUED", "GENERATING", "FAILED"].includes(result.status) || pausedForSettings) {
      const jobs = await client.query(
        `SELECT j.status,j.progress,j.created_at,j.package_revision,
          CASE WHEN (j.status IN ('RUNNING','QUEUED','FAILED') OR $4::boolean) AND $3::boolean THEN
            (SELECT jsonb_object_agg(e.key,e.value) FROM distribution.studio_package p,
              LATERAL jsonb_each(p.generation_checkpoint) e
              WHERE p.id=j.package_id AND p.is_test=j.is_test AND e.key LIKE 'output:%')
          ELSE NULL END AS previews
         FROM distribution.studio_generation_job j WHERE j.package_id=$1 AND j.is_test=$2 ORDER BY j.package_revision DESC LIMIT 1`,
        [
          id,
          isTest,
          !result.outputs.length && !result.generation && !result.approval,
          pausedForSettings,
        ],
      );
      if (jobs.rows[0]?.status === "RUNNING") result.status = "GENERATING";
      result.generationProgress = pausedForSettings ? null : (jobs.rows[0]?.progress ?? null);
      const job = jobs.rows[0];
      result.generationPreviews =
        job &&
        (pausedForSettings ||
          job.package_revision === result.revision ||
          (result.status === "FAILED" &&
            job.status === "FAILED" &&
            job.package_revision === result.revision - 1))
          ? studioGenerationPreviews(result, iso(job.created_at), job.previews, pausedForSettings)
          : [];
    }
    return result;
  }
  // A playlist must not perform four queries per recording or transfer every
  // full transcript just to show its files. Detail/review reads still use load().
  async function loadMany(
    client: PoolClient,
    isTest: boolean,
    ids: string[],
    summaryOnly: boolean,
  ): Promise<StudioPackage[]> {
    if (!ids.length) return [];
    const rows = await client.query(
      `SELECT p.id,r.action,CASE WHEN $3::boolean THEN r.snapshot - 'provenance'
        ELSE r.snapshot END AS snapshot,
        CASE WHEN $3::boolean THEN r.snapshot #>> '{provenance,generatedAt}' END AS generated_at
       FROM distribution.studio_package p JOIN distribution.studio_revision r
         ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision
       WHERE p.id=ANY($1::uuid[]) AND p.is_test=$2 AND p.deleted_at IS NULL`,
      [ids, isTest, summaryOnly],
    );
    const packages = new Map<string, StudioPackage>();
    const pausedIds = new Set<string>();
    for (const row of rows.rows) {
      const pkg = row.snapshot as StudioPackage;
      if (pkg.status === "DRAFT" && row.action === "PLAYLIST_SETTINGS_PAUSED")
        pausedIds.add(pkg.id);
      pkg.feedback = [];
      if (summaryOnly) {
        pkg.provenance = null;
        pkg.outputs = pkg.outputs.map((output) =>
          output.generatedAt || !row.generated_at
            ? output
            : { ...output, generatedAt: row.generated_at },
        );
      }
      packages.set(row.id, pkg);
    }
    if (packages.size !== ids.length) throw Error("NOT_FOUND");
    const feedback = await client.query(
      `SELECT * FROM distribution.studio_feedback WHERE package_id=ANY($1::uuid[])
        AND is_test=$2 ORDER BY package_id,revision,created_at,id`,
      [ids, isTest],
    );
    for (const row of feedback.rows)
      packages.get(row.package_id)?.feedback.push({
        id: row.id,
        actorId: row.actor_id,
        action: row.action,
        comment: row.comment,
        revision: row.revision,
        createdAt: iso(row.created_at),
      });
    const pendingIds = [...packages.values()]
      .filter(
        (pkg) => ["QUEUED", "GENERATING", "FAILED"].includes(pkg.status) || pausedIds.has(pkg.id),
      )
      .map((pkg) => pkg.id);
    if (pendingIds.length) {
      const jobs = await client.query(
        `SELECT j.*,CASE WHEN (j.status IN ('RUNNING','QUEUED','FAILED')
          OR (r.action='PLAYLIST_SETTINGS_PAUSED' AND r.snapshot->>'status'='DRAFT'))
          AND jsonb_array_length(r.snapshot->'outputs')=0
          AND COALESCE(r.snapshot->'generation','null'::jsonb)='null'::jsonb
          AND COALESCE(r.snapshot->'approval','null'::jsonb)='null'::jsonb
          THEN (SELECT jsonb_object_agg(e.key,e.value)
            FROM jsonb_each(p.generation_checkpoint) e WHERE e.key LIKE 'output:%')
          ELSE NULL END AS previews
         FROM (SELECT DISTINCT ON (package_id) package_id,package_revision,status,progress,created_at
           FROM distribution.studio_generation_job WHERE package_id=ANY($1::uuid[]) AND is_test=$2
           ORDER BY package_id,package_revision DESC) j
         JOIN distribution.studio_package p ON p.id=j.package_id AND p.is_test=$2
         JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision`,
        [pendingIds, isTest],
      );
      const latest = new Map(jobs.rows.map((job) => [job.package_id, job]));
      for (const id of pendingIds) {
        const pkg = packages.get(id);
        if (!pkg) throw Error("NOT_FOUND");
        const job = latest.get(id);
        const pausedForSettings = pausedIds.has(id);
        if (job?.status === "RUNNING") pkg.status = "GENERATING";
        pkg.generationProgress = pausedForSettings ? null : (job?.progress ?? null);
        pkg.generationPreviews =
          job &&
          (pausedForSettings ||
            job.package_revision === pkg.revision ||
            (pkg.status === "FAILED" &&
              job.status === "FAILED" &&
              job.package_revision === pkg.revision - 1))
            ? studioGenerationPreviews(pkg, iso(job.created_at), job.previews, pausedForSettings)
            : [];
      }
    }
    return ids.map((id) => {
      const pkg = packages.get(id);
      if (!pkg) throw Error("NOT_FOUND");
      return pkg;
    });
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
      generationPreviews: [],
      id: pkg.id,
      isTest: pkg.isTest,
      source: pkg.source,
      createdBy: pkg.createdBy,
      createdAt: pkg.createdAt,
      revision: pkg.revision + 1,
      feedback: [],
      updatedAt: new Date().toISOString(),
    };
    // Only current Content Curators are recorded as contributors. Administrative
    // maintenance records its actor on the revision, never on the contributor list,
    // because posting rechecks every contributor's curator role and an administrator
    // can never hold it.
    for (const id of next.contributorIds.filter((value) => !pkg.contributorIds.includes(value)))
      if (!(await fresh(id, pkg.isTest, "content.create")))
        throw Error("STUDIO_CONTRIBUTOR_NOT_CURATOR");
    if (pkg.outputs.some((o) => o.workflow)) {
      const reviewAction =
        action.startsWith("APPROVED_") || ["SUBMITTED", "REJECTED", "DISCARDED"].includes(action);
      if (!reviewAction) {
        for (const old of pkg.outputs.filter((o) =>
          ["IN_REVIEW", "APPROVED"].includes(studioFileStatus(pkg, o)),
        )) {
          const output = next.outputs.find((o) => o.id === old.id);
          if (!output || studioFileFingerprint(pkg, old) !== studioFileFingerprint(next, output))
            throw Error("STUDIO_FILE_LOCKED");
        }
      }
      if (!["QUEUED", "GENERATING", "FAILED", "DISCARDED"].includes(next.status))
        next.status = studioAggregateFileStatus(next.outputs);
    }
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
    if (sourceRequiresLanguageAssignment(pkg.source.language)) {
      const grants = await client.query(
        "SELECT 1 FROM distribution.native_reviewer WHERE user_id=$1 AND is_test=$2 AND language=$3",
        [reviewerId, pkg.isTest, pkg.source.language],
      );
      if (!grants.rowCount) throw new Error("NATIVE_REVIEWER_REQUIRED");
    }
  }
  async function submitFiles(
    client: PoolClient,
    ctx: DistributionContext,
    pkg: StudioPackage,
    input: { outputIds?: string[] | undefined; comment?: string | undefined },
  ) {
    active(pkg);
    if (["QUEUED", "GENERATING"].includes(pkg.status)) throw Error("INVALID_STUDIO_TRANSITION");
    const selected = studioSelectedOutputs(
      pkg.outputs,
      input.outputIds ??
        pkg.outputs
          .filter((o) => ["DRAFT", "CHANGES_REQUESTED"].includes(studioFileStatus(pkg, o)))
          .map((o) => o.id),
    );
    if (selected.some((o) => !studioCanEditFile(pkg, o, ["content.create"])))
      throw Error("STUDIO_FILE_LOCKED");
    if (selected.some((o) => o.correction?.state === "pending"))
      throw Error("STUDIO_CORRECTIONS_PENDING");
    const blockers = studioPackageBlockers(
      { ...pkg, outputs: selected },
      await sourceCurrent(client, pkg),
    );
    if (blockers.length) throw Error(blockers[0]);
    const ids = new Set(selected.map((o) => o.id));
    const outputs = materializeFileWorkflows(pkg).map((o) =>
      ids.has(o.id)
        ? {
            ...o,
            workflow: {
              status: "IN_REVIEW" as const,
              actorId: ctx.userId,
              updatedAt: new Date().toISOString(),
            },
            ...(o.correction?.state === "revised"
              ? { correction: { ...o.correction, state: "submitted" as const } }
              : {}),
          }
        : o,
    );
    return save(
      client,
      pkg,
      ctx.userId,
      "SUBMITTED",
      { outputs, status: studioAggregateFileStatus(outputs), approval: null },
      { action: "SUBMITTED", comment: comment(input.comment) },
    );
  }
  async function reviewFiles(
    client: PoolClient,
    ctx: DistributionContext,
    pkg: StudioPackage,
    input: {
      outputIds?: string[] | undefined;
      decision: "APPROVED" | "REJECTED" | "DISCARDED";
      comment?: string | undefined;
      confirmTranscript?: boolean | undefined;
      confirmTeachingIntegrity?: boolean | undefined;
    },
  ) {
    active(pkg);
    if (["QUEUED", "GENERATING"].includes(pkg.status)) throw Error("INVALID_STUDIO_TRANSITION");
    const selected = studioSelectedOutputs(
      pkg.outputs,
      input.outputIds ??
        pkg.outputs.filter((o) => studioFileStatus(pkg, o) === "IN_REVIEW").map((o) => o.id),
    );
    if (selected.some((o) => studioFileStatus(pkg, o) !== "IN_REVIEW"))
      throw Error("INVALID_STUDIO_TRANSITION");
    requireIndependentContentReview(
      ctx.userId,
      pkg.contributorIds,
      await reviewerRoles(ctx.userId, ctx.isTest),
    );
    const note = comment(input.comment, input.decision === "REJECTED");
    let approval: StudioPackage["approval"] = null;
    if (input.decision === "APPROVED") {
      const scope = { ...pkg, outputs: selected };
      const blockers = studioPackageBlockers(scope);
      if (blockers.length) throw Error(blockers[0]);
      if (!input.confirmTeachingIntegrity) throw Error("TEACHING_INTEGRITY_CONFIRMATION_REQUIRED");
      if (
        pkg.provenance?.transcript.provenance === "MACHINE_TRANSCRIPT" &&
        !input.confirmTranscript
      )
        throw Error("MACHINE_TRANSCRIPT_CONFIRMATION_REQUIRED");
      const master = await sourceRights(client, scope);
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
    const ids = new Set(selected.map((o) => o.id));
    const outputs = materializeFileWorkflows(pkg).map((o) => {
      if (!ids.has(o.id)) return o;
      const workflow = {
        status: input.decision === "REJECTED" ? ("CHANGES_REQUESTED" as const) : input.decision,
        actorId: ctx.userId,
        updatedAt: new Date().toISOString(),
        ...(approval
          ? { approval: { ...approval, fingerprint: studioFileFingerprint(pkg, o) } }
          : {}),
      };
      if (input.decision === "REJECTED")
        return {
          ...o,
          workflow,
          correction: {
            comment: note,
            reviewerId: ctx.userId,
            requestedAt: new Date().toISOString(),
            state: "pending" as const,
            before: {
              title: o.title,
              body: o.body,
              sourceSegmentIds: o.sourceSegmentIds,
              ...(o.mediaEdits ? { mediaEdits: o.mediaEdits } : {}),
              ...(o.sourceTrim ? { sourceTrim: o.sourceTrim } : {}),
              ...(o.captionCues ? { captionCues: o.captionCues } : {}),
              ...(o.aiReview ? { aiReview: o.aiReview } : {}),
            },
          },
        };
      return {
        ...o,
        workflow,
        ...(input.decision === "DISCARDED" ? { included: false } : {}),
        ...(o.correction && input.decision === "APPROVED"
          ? { correction: { ...o.correction, state: "resolved" as const } }
          : {}),
      };
    });
    const status = studioAggregateFileStatus(outputs);
    return save(
      client,
      pkg,
      ctx.userId,
      input.decision === "APPROVED" ? "APPROVED_SELECTED_FILES" : input.decision,
      { outputs, status, approval: status === "APPROVED" ? approval : null },
      { action: input.decision, comment: note },
    );
  }
  async function publicationEligible(
    client: PoolClient,
    pkg: StudioPackage,
    publishing = true,
    outputIds?: string[],
  ) {
    if (publishing) {
      for (const output of studioSelectedOutputs(pkg.outputs, outputIds)) {
        const block = studioPublishingFormatBlock(output);
        if (block) throw Error(block);
      }
    }
    if (pkg.outputs.some((o) => o.workflow)) {
      active(pkg);
      const selected = studioSelectedOutputs(pkg.outputs, outputIds);
      for (const output of selected) {
        const approval = studioFileApproval(pkg, output);
        if (
          !approval ||
          output.workflow?.approval?.fingerprint !== studioFileFingerprint(pkg, output)
        )
          throw Error("STUDIO_NOT_APPROVED");
        requireIndependentContentReview(
          approval.reviewerId,
          pkg.contributorIds,
          await reviewerRoles(approval.reviewerId, pkg.isTest),
        );
        const scope = { ...pkg, outputs: [output], approval };
        const blockers = studioPackageBlockers(scope);
        if (blockers.length) throw Error(blockers[0]);
        if (publishing && unconfiguredStudioClosingChannels([output]).length)
          throw Error("STUDIO_CLOSING_CHANNEL_REQUIRED");
        await sourceRights(client, scope, true);
        await qualifiedReviewer(client, pkg, approval.reviewerId);
        if (!(await fresh(approval.reviewerId, pkg.isTest, "content.review")))
          throw revoked("REVIEWER_ROLE_REVOKED", approval.reviewerId);
      }
      for (const contributor of pkg.contributorIds)
        if (!(await fresh(contributor, pkg.isTest, "content.create")))
          throw revoked("REQUESTER_ROLE_REVOKED", contributor);
      return;
    }
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
      throw revoked("REVIEWER_ROLE_REVOKED", pkg.approval.reviewerId);
    for (const contributor of pkg.contributorIds)
      if (!(await fresh(contributor, pkg.isTest, "content.create")))
        throw revoked("REQUESTER_ROLE_REVOKED", contributor);
  }
  async function publicationUnchanged(client: PoolClient, pkg: StudioPackage, row: QueryResultRow) {
    if (pkg.revision === row.package_revision) return true;
    const output = pkg.outputs.find((o) => o.id === row.output_id);
    if (!output?.workflow?.approval || studioFileStatus(pkg, output) !== "APPROVED") return false;
    const previous = await client.query(
      "SELECT snapshot FROM distribution.studio_revision WHERE package_id=$1 AND is_test=$2 AND revision=$3",
      [pkg.id, pkg.isTest, row.package_revision],
    );
    const snapshot = previous.rows[0]?.snapshot as StudioPackage | undefined;
    const original = snapshot?.outputs.find((o) => o.id === row.output_id);
    return Boolean(
      snapshot &&
        original &&
        studioFileApproval(snapshot, original) &&
        studioFileFingerprint(snapshot, original) === studioFileFingerprint(pkg, output) &&
        studioFileApproval(snapshot, original)?.approvedAt === output.workflow.approval.approvedAt,
    );
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
  async function postingMatches(
    client: PoolClient,
    pkg: StudioPackage,
    output: StudioOutput,
    accountId: string,
    destination: string,
    excludeId: string | null = null,
  ) {
    const rows = await client.query(
      `SELECT j.*,r.snapshot FROM distribution.studio_publication_job j
       JOIN distribution.studio_revision r ON r.package_id=j.package_id AND r.is_test=j.is_test AND r.revision=j.package_revision
       WHERE j.is_test=$1 AND j.channel=$2 AND (j.destination_key=$3 OR (j.destination_key IS NULL AND j.account_id=$4 AND j.status<>'RUNNING'))
         AND ($5::uuid IS NULL OR j.id<>$5) AND j.status IN ('RUNNING','PROCESSING','PUBLISHED','UNCERTAIN','FAILED')`,
      [pkg.isTest, output.channel, destination, accountId, excludeId],
    );
    return rows.rows.flatMap((row) => {
      const match = studioKnownPostingMatch(pkg.source.sha256, output, {
        publication: publication(row),
        package: row.snapshot,
      });
      return match ? [match] : [];
    });
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
      ...(input.request.youtubeFormat ? { youtubeFormat: input.request.youtubeFormat } : {}),
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
      mode?: "ai" | "render" | "closing" | "discover" | undefined;
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
    if (
      (
        await client.query(
          "SELECT 1 FROM distribution.online_import WHERE is_test=$1 AND deleted_at IS NULL AND curation->>'pausedForSettings'='true' AND EXISTS (SELECT 1 FROM jsonb_each(curation->'items') member WHERE member.value->>'packageId'=$2)",
          [ctx.isTest, id],
        )
      ).rowCount
    )
      throw Error("PLAYLIST_SETTINGS_PAUSED");
    active(pkg);
    if (pkg.outputs.some((o) => o.workflow)) {
      if (["QUEUED", "GENERATING", "DISCARDED"].includes(pkg.status))
        throw Error("INVALID_STUDIO_TRANSITION");
    } else if (!studioCanEdit(pkg.status, ["content.create"]))
      throw Error("INVALID_STUDIO_TRANSITION");
    await sourceCurrent(client, pkg);
    const request = input.request ?? pkg.request;
    if (
      input.mode === "discover" &&
      (input.outputIds?.length ||
        input.steadyOpening ||
        input.closingDestinations ||
        input.illustrationTimings ||
        !request.allCompleteMessages ||
        request.channels.some((c) => !["youtube", "facebook", "instagram", "tiktok"].includes(c)))
    )
      throw Error("STUDIO_SELECT_OUTPUTS");
    const outputIds =
      input.mode === "discover" ? [] : studioCorrectionTargets(pkg, input.outputIds);
    if (
      pkg.outputs.some((o) => o.workflow) &&
      pkg.outputs.some(
        (o) =>
          (outputIds.includes(o.id) || input.mode === "discover") &&
          !studioCanEditFile(pkg, o, ["content.create"]),
      )
    )
      throw Error("STUDIO_FILE_LOCKED");
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
      generation:
        input.mode === "discover"
          ? { outputIds: [], mode: "discover" as const }
          : outputIds.length
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
    ...createStudioSeriesWorkflow({
      transaction,
      access,
      fresh,
      load,
      sourceCurrent,
      requestGeneration,
    }),
    ...createStudioGenerationRecovery({ transaction, fresh, load, requestGeneration }),
    enqueueClosingVerification: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        target?: import("@satsang/distribution-domain").StudioYoutubeClosing | undefined;
      },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        if (!(await fresh(ctx.userId, ctx.isTest, "content.create")))
          throw Error("REQUESTER_ROLE_REVOKED");
        let pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        active(pkg);
        await sourceCurrent(client, pkg);
        if (
          pkg.status !== "DRAFT" ||
          pkg.approval ||
          pkg.generation ||
          pkg.outputs.some((o) => !studioCanEditFile(pkg, o, ["content.create"]))
        )
          throw Error("STUDIO_FILE_LOCKED");
        const outputIds = pkg.outputs
          .filter((o) => o.included && ["short", "video", "reel"].includes(o.format))
          .map((o) => o.id);
        if (!outputIds.length) throw Error("STUDIO_SELECT_OUTPUTS");
        if (input.target) {
          const target = studioYoutubeClosing(input.target);
          if (!same(target, pkg.request.youtubeClosing))
            pkg = await save(client, pkg, ctx.userId, "CLOSING_SETTINGS_UPDATED", {
              request: { ...pkg.request, youtubeClosing: target },
              contributorIds: [...new Set([...pkg.contributorIds, ctx.userId])],
            });
        }
        // Saving the target and accepting its closing-only job is one transaction.
        // A lost response is resolved by reading the new revision, never by replaying it.
        return requestGeneration(client, ctx, id, {
          expectedRevision: pkg.revision,
          mode: "closing",
          outputIds,
        });
      }),
    publicationPreflight: (
      ctx: DistributionContext,
      id: string,
      expectedRevision: number,
      outputIds: string[],
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.publish");
        const pkg = await load(client, ctx.isTest, id);
        requireContentRevision(pkg.revision, expectedRevision);
        try {
          await publicationEligible(client, pkg, true, outputIds);
          return { blocker: null, operatorId: null };
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(code)) throw error;
          return { blocker: code, operatorId: studioBlockedOperatorId(error) };
        }
      }),
    replaceDraftClosingCards: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        target: import("@satsang/distribution-domain").StudioYoutubeClosing;
        outputs: StudioOutput[];
      },
    ) =>
      transaction(async (client) => {
        await requireDistributionCapability(client, ctx, ["operations.manage"]);
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        active(pkg);
        await sourceCurrent(client, pkg);
        if (
          pkg.status !== "DRAFT" ||
          pkg.approval ||
          pkg.generation ||
          !pkg.outputs.length ||
          pkg.outputs.some((output) => !studioCanEditFile(pkg, output, ["content.create"]))
        )
          throw Error("STUDIO_FILE_LOCKED");
        const target = studioYoutubeClosing(input.target);
        if (
          target.url !== pkg.request.youtubeClosing?.url ||
          input.outputs.length !== pkg.outputs.length
        )
          throw Error("STUDIO_TARGET_SETTINGS_CHANGED");
        for (const [index, prior] of pkg.outputs.entries()) {
          const next = input.outputs[index];
          if (!next) throw Error("STUDIO_SELECT_OUTPUTS");
          if (
            same(prior, next) &&
            same(prior.presentationReview?.closingCard?.youtubeClosing, target)
          )
            continue;
          validateStudioClosingReplacement(pkg, prior, next, target);
        }
        if (
          (
            await client.query(
              "SELECT 1 FROM distribution.studio_generation_job WHERE package_id=$1 AND is_test=$2 AND status IN ('RUNNING','QUEUED')",
              [id, ctx.isTest],
            )
          ).rowCount
        )
          throw Error("STUDIO_DESTINATION_BUSY");
        return save(
          client,
          pkg,
          ctx.userId,
          "CLOSING_CARDS_REFRESHED",
          {
            request: { ...pkg.request, youtubeClosing: target },
            outputs: input.outputs,
          },
          {
            action: "REVISED",
            comment:
              "Closing-card watch and subscription links updated. Verified original audio, captions and preceding pictures preserved. Human approval is still required.",
          },
        );
      }),
    replaceGenerationPreview: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        target?: import("@satsang/distribution-domain").StudioYoutubeClosing;
        key: string;
        before: { fingerprint: string; value: unknown };
        after: { fingerprint: string; value: unknown };
      },
    ) =>
      transaction(async (client) => {
        await requireDistributionCapability(client, ctx, ["operations.manage"]);
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        active(pkg);
        await sourceCurrent(client, pkg);
        const destination = input.target ?? pkg.request.youtubeClosing;
        if (!destination) throw Error("STUDIO_CLOSING_CHANNEL_REQUIRED");
        const target = studioYoutubeClosing(destination);
        if (target.url !== pkg.request.youtubeClosing?.url)
          throw Error("STUDIO_TARGET_SETTINGS_CHANGED");
        const prior = input.before.value as StudioOutput;
        const next = input.after.value as StudioOutput;
        if (
          !/^[a-f0-9]{64}$/.test(input.after.fingerprint) ||
          !studioGenerationPreviews(pkg, "1970-01-01T00:00:00Z", { [input.key]: input.before })
            .length ||
          !studioGenerationPreviews(pkg, "1970-01-01T00:00:00Z", { [input.key]: input.after })
            .length
        )
          throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
        validateStudioClosingReplacement(pkg, prior, next, target, true);
        // Compare-and-swap the one checkpoint. Do not change the package revision or active lease.
        // A new render finishing concurrently wins; an administrator cannot overwrite it.
        const updated = await client.query(
          `UPDATE distribution.studio_package SET generation_checkpoint=
          jsonb_set(jsonb_set(generation_checkpoint,ARRAY[$3::text],$4::jsonb),ARRAY[$6::text],$7::jsonb)
          WHERE id=$1 AND is_test=$2 AND generation_checkpoint->$3=$5::jsonb`,
          [
            id,
            ctx.isTest,
            input.key,
            input.after,
            input.before,
            `preview-history:${prior.id}:${input.before.fingerprint}`,
            { ...input.before, refreshedBy: ctx.userId, refreshedAt: new Date().toISOString() },
          ],
        );
        if (updated.rowCount !== 1) throw Error("STUDIO_PREVIEW_CHANGED");
        return { outputId: next.id, revision: pkg.revision };
      }),
    refreshYoutubeDestination: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        target: import("@satsang/distribution-domain").StudioYoutubeClosing;
      },
    ) =>
      transaction(async (client) => {
        // Changing an approved destination is explicit administrator maintenance,
        // never a curator shortcut around immutable approval.
        await requireDistributionCapability(client, ctx, ["operations.manage"]);
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        active(pkg);
        // Administrators do not inherit curator permissions. The audited change
        // is theirs; generation remains under the original, still-active curator
        // and the worker rechecks that authority before accepting the job.
        if (!(await fresh(pkg.createdBy, pkg.isTest, "content.create")))
          throw Error("REQUESTER_ROLE_REVOKED");
        await sourceCurrent(client, pkg);
        const prepared = prepareStudioYoutubeClosingRefresh(pkg, input.target, {
          userId: ctx.userId,
          at: new Date().toISOString(),
        });
        if (prepared === pkg) return pkg;
        if (
          (
            await client.query(
              `SELECT 1 FROM distribution.studio_publication_job WHERE package_id=$1 AND is_test=$2 AND status IN ('QUEUED','RUNNING','PROCESSING','UNCERTAIN') LIMIT 1`,
              [id, ctx.isTest],
            )
          ).rowCount
        )
          throw Error("STUDIO_DESTINATION_BUSY");
        const pendingRenders = await client.query(
          "SELECT id,package_revision FROM distribution.studio_generation_job WHERE package_id=$1 AND is_test=$2 AND status IN ('QUEUED','RUNNING') FOR UPDATE",
          [id, ctx.isTest],
        );
        if (
          pendingRenders.rowCount &&
          (pkg.generation?.mode !== "closing" ||
            pendingRenders.rows.some((job) => job.package_revision !== pkg.revision))
        )
          throw Error("STUDIO_DESTINATION_BUSY");
        // A newer explicit destination supersedes only an older closing-only job.
        // Invalidating its lease and appending the replacement revision happen in
        // one transaction, so an in-flight renderer cannot commit obsolete cards.
        for (const job of pendingRenders.rows)
          await generationState(
            client,
            job.id,
            ctx.isTest,
            "STALE",
            "STUDIO_DESTINATION_SUPERSEDED",
          );
        if (!prepared.outputs.length)
          return save(client, pkg, ctx.userId, "CLOSING_DESTINATION_UPDATED", {
            request: prepared.request,
          });
        // Reopen review without changing any reviewed content, then append the new
        // destination and enqueue its closing-only render in the SAME transaction.
        const reopened = await save(client, pkg, ctx.userId, "CLOSING_REVIEW_REOPENED", {
          status: "DRAFT",
          approval: null,
          outputs: pkg.outputs.map((output) => ({
            ...output,
            workflow: {
              status: "DRAFT" as const,
              actorId: ctx.userId,
              updatedAt: new Date().toISOString(),
            },
          })),
        });
        const outputIds = prepared.outputs.filter((o) => o.asset).map((o) => o.id);
        const next = await save(
          client,
          reopened,
          ctx.userId,
          "CLOSING_DESTINATION_UPDATED",
          {
            ...prepared,
            status: outputIds.length ? "QUEUED" : "DRAFT",
            generation: outputIds.length ? { outputIds, mode: "closing" } : null,
            // The administrator is the revision's actor, not a content contributor:
            // posting rechecks every contributor's curator role, which an
            // administrator never holds.
            contributorIds: pkg.contributorIds,
          },
          {
            action: "REVISED",
            comment: `Administrator changed the subscription destination to ${prepared.request.youtubeClosing?.url}. Existing edits are preserved; changed files require fresh human approval.`,
          },
        );
        if (outputIds.length) await enqueue(client, next, pkg.createdBy);
        return next;
      }),
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
    discoverPlaylist: (ctx: DistributionContext, id: string) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        if (!(await fresh(ctx.userId, ctx.isTest, "content.create")))
          throw Error("REQUESTER_ROLE_REVOKED");
        const row = (
          await client.query(
            "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL FOR UPDATE",
            [id, ctx.isTest],
          )
        ).rows[0];
        if (!row || !isOnlineBundle(row.source) || !row.curation) throw Error("PLAYLIST_NOT_READY");
        const plan = row.curation as PlaylistCuration;
        let queued = 0;
        for (const member of Object.values(plan.items).sort((a, b) =>
          (a.packageId ?? "").localeCompare(b.packageId ?? ""),
        )) {
          if (!member.packageId) continue;
          const pkg = await load(client, ctx.isTest, member.packageId, true);
          if (!studioCanEdit(pkg.status, ["content.create"]) || pkg.approval) continue;
          await requestGeneration(client, ctx, pkg.id, {
            expectedRevision: pkg.revision,
            mode: "discover",
          });
          member.status = "QUEUED";
          Reflect.deleteProperty(member, "error");
          queued++;
        }
        await client.query(
          "UPDATE distribution.online_import SET curation=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
          [id, ctx.isTest, plan],
        );
        return { queued };
      }),
    pausePlaylistSettings: (ctx: DistributionContext, id: string) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        if (!(await fresh(ctx.userId, ctx.isTest, "content.create")))
          throw Error("ONLINE_IMPORT_FORBIDDEN");
        const row = (
          await client.query(
            "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL FOR UPDATE",
            [id, ctx.isTest],
          )
        ).rows[0];
        if (!row || !isOnlineBundle(row.source) || !row.curation) throw Error("PLAYLIST_NOT_READY");
        const plan = row.curation as PlaylistCuration;
        if (plan.pausedForSettings) return;
        for (const member of Object.values(plan.items).sort((a, b) =>
          (a.packageId ?? "").localeCompare(b.packageId ?? ""),
        )) {
          if (!member.packageId) continue;
          const pkg = await load(client, ctx.isTest, member.packageId, true);
          requirePlaylistSettingsEditable(pkg, member.existing);
          const jobs = await client.query(
            "SELECT * FROM distribution.studio_generation_job WHERE package_id=$1 AND is_test=$2 AND status IN ('QUEUED','RUNNING') FOR UPDATE",
            [pkg.id, ctx.isTest],
          );
          if (
            jobs.rows.some(
              (j) =>
                j.status === "RUNNING" &&
                !["drafting", "reviewing", "rendering"].includes(j.progress?.phase),
            )
          )
            throw Error("PLAYLIST_PAUSE_WAIT");
          for (const job of jobs.rows)
            await generationState(client, job.id, ctx.isTest, "STALE", "PLAYLIST_SETTINGS_PAUSED");
          await save(client, pkg, ctx.userId, "PLAYLIST_SETTINGS_PAUSED", {
            status: "DRAFT",
            failure: null,
          });
          member.status = "DRAFT";
          Reflect.deleteProperty(member, "error");
        }
        plan.pausedForSettings = true;
        // Also reserve unstarted members so an older draining worker cannot enqueue
        // them during a rolling upgrade. These markers are removed only on resume.
        for (const childId of row.child_ids) {
          if (!plan.items[childId]?.packageId)
            plan.items[childId] = { error: "PLAYLIST_SETTINGS_PAUSED" };
        }
        await client.query(
          "UPDATE distribution.online_import SET curation=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
          [id, ctx.isTest, plan],
        );
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
        if (!row || row.deleted_at || !isOnlineBundle(row.source) || !row.child_ids?.length)
          throw Error("PLAYLIST_NOT_READY");
        if (row.curation?.pausedForSettings) {
          const plan = row.curation as PlaylistCuration;
          for (const member of Object.values(plan.items).sort((a, b) =>
            (a.packageId ?? "").localeCompare(b.packageId ?? ""),
          )) {
            if (!member.packageId) continue;
            const pkg = await load(client, ctx.isTest, member.packageId, true);
            requirePlaylistSettingsEditable(pkg, member.existing);
            const { master } = await loadStudioSource(
              client,
              ctx.isTest,
              pkg.source.masterId,
              true,
            );
            if (!same(master.rights, plan.rights)) throw Error("PLAYLIST_SETTINGS_LOCKED");
            if (!same(master.rights, input.rights))
              await recordContentRights(client, ctx, master, input.rights);
            await sourceCurrent(client, pkg);
            const next = await save(client, pkg, ctx.userId, "PLAYLIST_SETTINGS_RESUMED", {
              status: "QUEUED",
              request: input.request,
              generation: null,
              approval: null,
              failure: null,
              contributorIds: [...new Set([...pkg.contributorIds, ctx.userId])],
            });
            await enqueue(client, next, ctx.userId);
            member.status = "QUEUED";
            Reflect.deleteProperty(member, "error");
          }
          Reflect.deleteProperty(plan, "pausedForSettings");
          for (const [childId, member] of Object.entries(plan.items)) {
            if (!member.packageId) delete plan.items[childId];
          }
          plan.rights = input.rights;
          plan.request = input.request;
          plan.requestedBy = ctx.userId;
          plan.confirmedAt = new Date().toISOString();
          await client.query(
            "UPDATE distribution.online_import SET curation=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
            [id, ctx.isTest, plan],
          );
          return;
        }
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
        if (plan.pausedForSettings) throw Error("PLAYLIST_SETTINGS_PAUSED");
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
                closingDestinations: pkg.generation?.closingDestinations,
                steadyOpening: pkg.generation?.steadyOpening,
                illustrationTimings: pkg.generation?.illustrationTimings,
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
        if (plan?.pausedForSettings) throw Error("PLAYLIST_SETTINGS_PAUSED");
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
          `SELECT p.* FROM distribution.online_import p WHERE p.is_test=$1 AND p.deleted_at IS NULL AND p.curation IS NOT NULL AND p.curation->>'pausedForCleanup' IS DISTINCT FROM 'true' AND p.curation->>'pausedForSettings' IS DISTINCT FROM 'true' AND EXISTS (
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
        summaryOnly?: boolean;
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
           ORDER BY p.updated_at DESC,p.id LIMIT CASE WHEN $4::uuid IS NULL THEN 100 ELSE NULL END`,
          [
            ctx.isTest,
            input.masterId ?? null,
            input.includeWithdrawn ?? false,
            input.playlistId ?? null,
          ],
        );
        const values = await loadMany(
          client,
          ctx.isTest,
          rows.rows.map((row) => row.id),
          input.summaryOnly ?? false,
        );
        return input.status ? values.filter((value) => value.status === input.status) : values;
      }),
    enqueueGeneration: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        request?: StudioGenerationRequest | undefined;
        outputIds?: string[] | undefined;
        mode?: "ai" | "render" | "closing" | "discover" | undefined;
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
        render?: boolean | undefined;
        outputs: (Pick<StudioOutput, "id" | "title" | "body" | "included"> & {
          sourceSegmentIds?: string[] | undefined;
          captionCues?: StudioOutput["captionCues"] | undefined;
          mediaEdits?: StudioOutput["mediaEdits"] | undefined;
          sourceTrim?: StudioOutput["sourceTrim"] | undefined;
        })[];
        comment: string;
      },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        active(pkg);
        if (pkg.outputs.some((o) => o.workflow)) {
          if (
            input.outputs.some((edit) => {
              const output = pkg.outputs.find((o) => o.id === edit.id);
              return output && !studioCanEditFile(pkg, output, ["content.create"]);
            })
          )
            throw Error("STUDIO_FILE_LOCKED");
        } else if (!studioCanEdit(pkg.status, ["content.create"]))
          throw Error("INVALID_STUDIO_TRANSITION");
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
          const sourceTrim = edit.sourceTrim === undefined ? output.sourceTrim : edit.sourceTrim;
          const range = studioSourceRange(sourceSegmentIds, transcript, output.format, sourceTrim);
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
          const mediaEdits = edit.mediaEdits ?? output.mediaEdits;
          const changed =
            edit.title !== output.title ||
            edit.body !== output.body ||
            !same(sourceSegmentIds, output.sourceSegmentIds) ||
            !same(captionCues, output.captionCues) ||
            !same(sourceTrim, output.sourceTrim) ||
            !same(mediaEdits, output.mediaEdits);
          const revised = {
            ...output,
            ...(output.workflow
              ? {
                  workflow: {
                    status: "DRAFT" as const,
                    actorId: ctx.userId,
                    updatedAt: new Date().toISOString(),
                  },
                }
              : {}),
            title: edit.title,
            body: edit.body,
            included: edit.included,
            sourceSegmentIds,
            ...(sourceTrim !== undefined ? { sourceTrim } : {}),
            ...(["short", "reel", "video"].includes(output.format)
              ? { startMs: range.startMs, endMs: range.endMs }
              : {}),
            ...(captionCues ? { captionCues } : {}),
            ...(mediaEdits ? { mediaEdits } : {}),
            ...(output.presentationReview?.closingCard?.destination
              ? { closingDestination: output.presentationReview.closingCard.destination }
              : {}),
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
        const saved = await save(
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
        // Saving edits and queuing their rebuild must commit or roll back together.
        if (input.render)
          return requestGeneration(client, ctx, id, {
            expectedRevision: saved.revision,
            outputIds: input.outputs.filter((output) => output.included).map((output) => output.id),
            mode: "render",
          });
        return saved;
      }),
    submit: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        comment?: string | undefined;
        outputIds?: string[] | undefined;
      },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.create");
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        if (input.outputIds || pkg.outputs.some((o) => o.workflow))
          return submitFiles(client, ctx, pkg, input);
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
        if (input.outputIds || pkg.outputs.some((o) => o.workflow))
          return reviewFiles(client, ctx, pkg, input);
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
                    ...(o.mediaEdits ? { mediaEdits: o.mediaEdits } : {}),
                    title: o.title,
                    body: o.body,
                    sourceSegmentIds: o.sourceSegmentIds,
                    ...(o.sourceTrim ? { sourceTrim: o.sourceTrim } : {}),
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
        if (pkg.outputs.some((o) => o.workflow)) {
          const selected = input.outputId
            ? pkg.outputs.filter((o) => o.id === input.outputId)
            : pkg.outputs;
          if (!selected.length) throw Error("NOT_FOUND");
          if (
            selected.some(
              (o) =>
                !studioCanDiscard(
                  studioFileStatus(pkg, o),
                  capabilities,
                  input.outputId ? "output" : "package",
                ),
            )
          )
            throw Error("STUDIO_FILE_LOCKED");
          const ids = new Set(selected.map((o) => o.id));
          const outputs = materializeFileWorkflows(pkg).map((o) =>
            ids.has(o.id)
              ? {
                  ...o,
                  included: false,
                  workflow: {
                    status: "DISCARDED" as const,
                    actorId: ctx.userId,
                    updatedAt: new Date().toISOString(),
                  },
                }
              : o,
          );
          return save(
            client,
            pkg,
            ctx.userId,
            "DISCARDED",
            {
              outputs,
              status: studioAggregateFileStatus(outputs),
              approval: null,
            },
            { action: "DISCARDED", comment: comment(input.comment) },
          );
        }
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
        preview?: boolean | undefined;
      },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, input.forExport ? "content.publish" : undefined);
        const pkg = await load(client, ctx.isTest, id);
        active(pkg);
        await sourceCurrent(client, pkg);
        if (input.forExport) await publicationEligible(client, pkg, false, [outputId]);
        if (input.preview && input.forExport) throw new Error("FORBIDDEN");
        const output =
          pkg.outputs.find((value) => value.id === outputId) ??
          (input.preview
            ? pkg.generationPreviews?.find((value) => value.id === outputId)
            : undefined);
        if (input.forExport && (!output || !("included" in output) || !output.included))
          throw new Error("OUTPUT_EXCLUDED");
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
        if (pkg.generation?.mode === "discover")
          assertStudioDiscoveryIsolation(pkg.outputs, result.outputs);
        else if (pkg.generation)
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
          outputs: pkg.outputs.some((o) => o.workflow)
            ? result.outputs.map((o) =>
                !pkg.outputs.some((old) => old.id === o.id) ||
                (pkg.generation?.outputIds.includes(o.id) &&
                  !same(
                    pkg.outputs.find((old) => old.id === o.id),
                    o,
                  ))
                  ? {
                      ...o,
                      workflow: {
                        status: "DRAFT" as const,
                        actorId: row.requested_by,
                        updatedAt: new Date().toISOString(),
                      },
                    }
                  : o,
              )
            : result.outputs,
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
      input: {
        expectedRevision: number;
        accounts?: Partial<Record<StudioChannel, string>>;
        outputIds?: string[] | undefined;
      },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.publish");
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        const outputs = studioSelectedOutputs(
          pkg.outputs,
          input.outputIds ??
            (pkg.outputs.some((o) => o.workflow)
              ? pkg.outputs.filter((o) => studioFileStatus(pkg, o) === "APPROVED").map((o) => o.id)
              : undefined),
        );
        await publicationEligible(
          client,
          pkg,
          true,
          outputs.map((o) => o.id),
        );
        const previous = await client.query(
          "SELECT * FROM distribution.studio_publication_job WHERE package_id=$1 AND is_test=$2 ORDER BY created_at DESC,id FOR UPDATE",
          [pkg.id, pkg.isTest],
        );
        const result: StudioPublication[] = [];
        for (const output of outputs) {
          let row: QueryResultRow | undefined;
          for (const candidate of previous.rows.filter((r) => r.output_id === output.id)) {
            if (await publicationUnchanged(client, pkg, candidate)) {
              row = candidate;
              break;
            }
          }
          const account = input.accounts?.[output.channel] ?? null;
          if (row && account && row.account_id !== account) {
            if (
              row.account_id ||
              !["QUEUED", "BLOCKED"].includes(row.status) ||
              row.remote_id ||
              row.checkpoint
            )
              throw Error("STUDIO_PUBLISH_ACCOUNT_CHANGED");
            row = (
              await client.query(
                "UPDATE distribution.studio_publication_job SET account_id=$3 WHERE id=$1 AND is_test=$2 RETURNING *",
                [row.id, pkg.isTest, account],
              )
            ).rows[0];
          }
          if (!row)
            row = (
              await client.query(
                "INSERT INTO distribution.studio_publication_job(package_id,is_test,package_revision,output_id,channel,requested_by,account_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(package_id,is_test,package_revision,output_id) DO NOTHING RETURNING *",
                [pkg.id, pkg.isTest, pkg.revision, output.id, output.channel, ctx.userId, account],
              )
            ).rows[0];
          if (!row) throw Error("STUDIO_ACTION_UNCONFIRMED");
          const retry = studioPublicationRetryDecision(publication(row), Boolean(row.checkpoint));
          if (retry) {
            // A channel-rejected request gets a fresh provider post. The rejected
            // provider record is never published; its id stays in the attempt history.
            await attempt(client, row, "QUEUED", {
              action: "EXPLICIT_RETRY",
              requestedBy: ctx.userId,
              previousError: row.last_error,
              ...(retry === "FRESH_ATTEMPT"
                ? { previousRemoteId: row.remote_id, previousAttempt: row.attempts }
                : {}),
            });
            row = (
              await client.query(
                retry === "FRESH_ATTEMPT"
                  ? "UPDATE distribution.studio_publication_job SET status='QUEUED',last_error=NULL,remote_id=NULL,remote_url=NULL,checkpoint=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 RETURNING *"
                  : "UPDATE distribution.studio_publication_job SET status='QUEUED',last_error=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 RETURNING *",
                [row.id, pkg.isTest],
              )
            ).rows[0] as QueryResultRow;
          }
          result.push(publication(row));
        }
        return result.sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
      }),
    retract: (
      ctx: DistributionContext,
      id: string,
      input: { expectedRevision: number; publicationIds: string[] },
    ) =>
      transaction(async (client) => {
        await access(client, ctx, "content.publish");
        const pkg = await load(client, ctx.isTest, id, true);
        requireContentRevision(pkg.revision, input.expectedRevision);
        if (
          !input.publicationIds.length ||
          input.publicationIds.length > 200 ||
          new Set(input.publicationIds).size !== input.publicationIds.length
        )
          throw Error("INVALID_STUDIO_PUBLICATION_SELECTION");
        // Lock in the same order as the sender. A queued cancellation wins before a
        // claim, or the already claimed send is reported as unconfirmed, never erased.
        const selected = await client.query(
          "SELECT * FROM distribution.studio_publication_job WHERE package_id=$1 AND is_test=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE",
          [id, ctx.isTest, input.publicationIds],
        );
        if (selected.rows.length !== input.publicationIds.length)
          throw Error("INVALID_STUDIO_PUBLICATION_SELECTION");
        const results = [];
        for (const row of selected.rows) {
          const result = studioRetractionDecision(publication(row), Boolean(row.checkpoint));
          if (result === "CANCELLED") {
            await publicationState(client, row, "CANCELLED", "STUDIO_PUBLICATION_RETRACTED");
            await attempt(client, row, "CANCELLED", {
              action: "RETRACTED",
              requestedBy: ctx.userId,
            });
          } else if (result !== "ALREADY_CANCELLED") {
            await attempt(client, row, row.status, {
              action: "RETRACTION_REQUIRES_CHANNEL",
              requestedBy: ctx.userId,
            });
          }
          const current = await publicationRow(client, ctx.isTest, row.id);
          results.push({ publication: publication(current), result });
        }
        return results;
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
    listPublicationsForPackages: (ctx: DistributionContext, ids: readonly string[]) =>
      transaction(async (client) => {
        await access(client, ctx);
        if (!ids.length) return [];
        const rows = await client.query(
          `SELECT j.* FROM distribution.studio_publication_job j
           JOIN distribution.studio_package p ON p.id=j.package_id AND p.is_test=j.is_test
           JOIN distribution.content_master m ON m.id=p.master_id AND m.is_test=p.is_test
           WHERE j.is_test=$1 AND j.package_id=ANY($2::uuid[])
             AND p.deleted_at IS NULL AND m.deleted_at IS NULL
           ORDER BY j.created_at,j.id`,
          [ctx.isTest, [...new Set(ids)]],
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
          if (!(await publicationUnchanged(client, pkg, row))) {
            await publicationState(client, row, "CANCELLED", "PACKAGE_CHANGED");
            continue;
          }
          try {
            await publicationEligible(client, pkg, true, [row.output_id]);
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
    checkPostingHistory: (
      ctx: DistributionContext,
      id: string,
      accountId: string,
      destination: string,
      channel: StudioChannel,
    ) =>
      transaction(async (client) => {
        await access(client, ctx);
        const pkg = await load(client, ctx.isTest, id);
        const results: Record<string, PostingCheck["matches"]> = {};
        for (const output of pkg.outputs.filter((o) => o.channel === channel))
          results[output.id] = await postingMatches(client, pkg, output, accountId, destination);
        return results;
      }),
    reservePublicationDestination: (
      claim: StudioPublicationClaim,
      accountId: string,
      check: PostingCheck,
    ) =>
      transaction(async (client) => {
        // Serialize checks for a real channel even when two packages/account aliases race.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `studio-posting:${claim.publication.isTest}:${check.destination}`,
        ]);
        const { pkg, row } = await checkedPublication(client, claim);
        if (row.account_id && row.account_id !== accountId)
          throw Error("PUBLISHING_ACCOUNT_CHANGED");
        if (check.error) {
          // Failed discovery has no verified physical channel identity. Do not pin its
          // fallback identifier and make the recovered connection impossible to retry.
          await client.query(
            "UPDATE distribution.studio_publication_job SET duplicate_check=$3 WHERE id=$1 AND is_test=$2",
            [row.id, pkg.isTest, check],
          );
          await publicationState(client, row, "BLOCKED", check.error);
          return { allowed: false, check };
        }
        if (row.destination_key && row.destination_key !== check.destination)
          throw Error("PUBLISHING_ACCOUNT_CHANGED");
        if (
          Date.now() - Date.parse(check.checkedAt) > 60000 ||
          Date.parse(check.checkedAt) > Date.now() + 1000 ||
          !Number.isFinite(Date.parse(check.checkedAt))
        )
          throw Error("STUDIO_POSTING_CHECK_STALE");
        const output = pkg.outputs.find((o) => o.id === row.output_id);
        if (!output) throw Error("OUTPUT_CHANGED");
        const matches = await postingMatches(
          client,
          pkg,
          output,
          accountId,
          check.destination,
          row.id,
        );
        const result: PostingCheck = { ...check, matches: [...matches, ...check.matches] };
        await client.query(
          "UPDATE distribution.studio_publication_job SET account_id=$3,destination_key=$4,duplicate_check=$5 WHERE id=$1 AND is_test=$2",
          [row.id, pkg.isTest, accountId, check.destination, result],
        );
        const block = postingCheckBlock(result);
        if (block) await publicationState(client, row, "BLOCKED", block);
        return { allowed: !block, check: result };
      }),
    revalidatePublication: (claim: StudioPublicationClaim) =>
      transaction(async (client): Promise<Eligibility> => {
        const { pkg, row } = await checkedPublication(client, claim);
        try {
          if (!(await publicationUnchanged(client, pkg, row))) throw new Error("PACKAGE_CHANGED");
          await publicationEligible(client, pkg, true, [row.output_id]);
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
    /** After repeated channel rejections, hold the rest of that account's queue.
     * Paused requests are BLOCKED without a provider record, so an explicit Post resumes them. */
    pausePublicationsAfterRejections: (claim: StudioPublicationClaim, accountId: string) =>
      transaction(async (client) => {
        const recent = await client.query(
          "SELECT status FROM distribution.studio_publication_job WHERE is_test=$1 AND account_id=$2 AND status IN ('PUBLISHED','SIMULATED','FAILED','UNCERTAIN') ORDER BY updated_at DESC,id LIMIT $3",
          [claim.publication.isTest, accountId, STUDIO_PUBLISHING_PAUSE_REJECTIONS],
        );
        if (!studioPublishingShouldPause(recent.rows.map((row) => String(row.status)))) return 0;
        const paused = await client.query(
          "UPDATE distribution.studio_publication_job SET status='BLOCKED',last_error='STUDIO_PUBLISHING_PAUSED_AFTER_REJECTIONS',updated_at=clock_timestamp() WHERE is_test=$1 AND status='QUEUED' AND channel=$3 AND (account_id=$2 OR account_id IS NULL) AND lease_token IS NULL RETURNING *",
          [claim.publication.isTest, accountId, claim.publication.channel],
        );
        for (const row of paused.rows)
          await attempt(client, row, "BLOCKED", {
            error: "STUDIO_PUBLISHING_PAUSED_AFTER_REJECTIONS",
            afterPublicationId: claim.publication.id,
          });
        return paused.rowCount ?? 0;
      }),
    publicationMedia: (id: string) =>
      transaction(async (client) => {
        const row = await publicationRow(client, false, id);
        if (!["RUNNING", "PROCESSING", "PUBLISHED"].includes(row.status))
          throw new Error("NOT_FOUND");
        const pkg = await load(client, false, row.package_id);
        if (!(await publicationUnchanged(client, pkg, row))) throw new Error("PACKAGE_CHANGED");
        await publicationEligible(client, pkg, true, [row.output_id]);
        const output = pkg.outputs.find((value) => value.id === row.output_id && value.included);
        if (!output?.asset) throw new Error("NOT_FOUND");
        return { publication: publication(row), package: pkg, output };
      }),
    publishedBlog: (id: string) =>
      transaction(async (client) => {
        const row = await publicationRow(client, false, id);
        if (row.status !== "PUBLISHED" || row.channel !== "website") throw new Error("NOT_FOUND");
        const pkg = await load(client, false, row.package_id);
        if (!(await publicationUnchanged(client, pkg, row))) throw new Error("PACKAGE_CHANGED");
        await publicationEligible(client, pkg, true, [row.output_id]);
        const output = pkg.outputs.find(
          (value) => value.id === row.output_id && value.included && value.format === "blog",
        );
        if (!output?.asset) throw new Error("NOT_FOUND");
        return { publication: publication(row), package: pkg, output };
      }),
  };
}
/** The operator a revoked-authority refusal names, so an Admin can review that account. */
export function studioBlockedOperatorId(error: unknown): string | null {
  const value = error instanceof Error ? (error as { operatorId?: unknown }).operatorId : undefined;
  return typeof value === "string" ? value : null;
}

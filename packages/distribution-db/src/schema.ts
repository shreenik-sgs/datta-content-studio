import type {
  ContentRights,
  CtaDefinition,
  DistributionCapability,
  OutreachCampaign,
  QuoteCandidate,
  RenderRecipe,
  TranscriptVersion,
} from "@satsang/distribution-domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const distributionSchema = pgSchema("distribution");
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const distributionModuleState = distributionSchema.table("module_state", {
  id: text("id").primaryKey(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const distributionOnlineImportService = distributionSchema.table(
  "online_import_service",
  {
    provider: text("provider").notNull(),
    isTest: boolean("is_test").notNull(),
    error: text("error").notNull(),
    attempts: integer("attempts").notNull().default(1),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.isTest] }),
    check("online_import_service_provider", sql`${t.provider} IN ('youtube','facebook')`),
    check("online_import_service_attempts", sql`${t.attempts} > 0`),
    check(
      "online_import_service_error",
      sql`${t.error} IN ('ONLINE_PROVIDER_VERIFICATION_REQUIRED','ONLINE_PROVIDER_RATE_LIMITED')`,
    ),
  ],
);
export const distributionContentMaster = distributionSchema.table(
  "content_master",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    title: text("title").notNull(),
    language: text("language").notNull(),
    category: text("category").notNull(),
    state: text("state").notNull().default("DRAFT"),
    revision: integer("revision").notNull().default(1),
    currentVersionNumber: integer("current_version_number").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("content_master_world").on(table.id, table.isTest),
    index("content_master_library").on(table.isTest, table.updatedAt, table.id),
    check(
      "content_master_revision",
      sql`${table.revision} > 0 AND ${table.currentVersionNumber} > 0`,
    ),
    check(
      "content_master_state",
      sql`${table.state} IN ('DRAFT','RIGHTS_CLEARED','APPROVED','PUBLISHED','WITHDRAWN')`,
    ),
  ],
);
export const distributionContentVersion = distributionSchema.table(
  "content_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    masterId: uuid("master_id").notNull(),
    isTest: boolean("is_test").notNull(),
    number: integer("number").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    mimeType: text("mime_type").notNull(),
    originalName: text("original_name").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("content_version_world").on(table.id, table.isTest),
    unique("content_version_number").on(table.masterId, table.isTest, table.number),
    unique("content_version_storage_key").on(table.storageKey),
    foreignKey({
      name: "version_master_world_fk",
      columns: [table.masterId, table.isTest],
      foreignColumns: [distributionContentMaster.id, distributionContentMaster.isTest],
    }),
    check("content_version_bytes", sql`${table.byteSize} > 0 AND ${table.byteSize} <= 21474836480`),
    check("content_version_sha256", sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);
export const distributionContentRights = distributionSchema.table(
  "content_rights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id").notNull(),
    isTest: boolean("is_test").notNull(),
    revision: integer("revision").notNull(),
    rights: jsonb("rights").$type<ContentRights>().notNull(),
    attestedBy: text("attested_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("content_rights_revision").on(table.versionId, table.isTest, table.revision),
    foreignKey({
      name: "rights_version_world_fk",
      columns: [table.versionId, table.isTest],
      foreignColumns: [distributionContentVersion.id, distributionContentVersion.isTest],
    }),
  ],
);
export const distributionApprovalDecision = distributionSchema.table(
  "approval_decision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id").notNull(),
    isTest: boolean("is_test").notNull(),
    approvedRevision: integer("approved_revision").notNull(),
    reviewerId: text("reviewer_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("approval_version_revision").on(table.versionId, table.isTest, table.approvedRevision),
    foreignKey({
      name: "approval_version_world_fk",
      columns: [table.versionId, table.isTest],
      foreignColumns: [distributionContentVersion.id, distributionContentVersion.isTest],
    }),
  ],
);
export const distributionCapabilityGrant = distributionSchema.table(
  "capability_grant",
  {
    userId: text("user_id").notNull(),
    isTest: boolean("is_test").notNull(),
    capability: text("capability").$type<DistributionCapability>().notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.isTest, table.capability] })],
);
export const distributionAuditEvent = distributionSchema.table(
  "audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    masterId: uuid("master_id").notNull(),
    isTest: boolean("is_test").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    revision: integer("revision").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_event_master").on(table.masterId, table.isTest, table.createdAt),
    foreignKey({
      name: "audit_master_world_fk",
      columns: [table.masterId, table.isTest],
      foreignColumns: [distributionContentMaster.id, distributionContentMaster.isTest],
    }),
  ],
);

// R2 editorial sources and decisions remain immutable; a new row represents every correction.
export const distributionTranscriptVersion = distributionSchema.table(
  "transcript_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    masterVersionId: uuid("master_version_id").notNull(),
    parentVersionId: uuid("parent_version_id"),
    language: text("language").notNull(),
    number: integer("number").notNull(),
    transcript: jsonb("transcript").$type<TranscriptVersion>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("transcript_world").on(table.id, table.isTest),
    unique("transcript_source_number").on(
      table.masterVersionId,
      table.isTest,
      table.language,
      table.number,
    ),
    unique("transcript_single_child").on(table.parentVersionId, table.isTest),
    foreignKey({
      name: "transcript_source_world_fk",
      columns: [table.masterVersionId, table.isTest],
      foreignColumns: [distributionContentVersion.id, distributionContentVersion.isTest],
    }),
    foreignKey({
      name: "transcript_parent_world_fk",
      columns: [table.parentVersionId, table.isTest],
      foreignColumns: [table.id, table.isTest],
    }),
    check("transcript_number", sql`${table.number} > 0`),
  ],
);
export const distributionTranscriptReview = distributionSchema.table(
  "transcript_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    transcriptVersionId: uuid("transcript_version_id").notNull(),
    revision: integer("revision").notNull(),
    decision: text("decision").notNull(),
    reviewerId: text("reviewer_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("transcript_review_revision").on(
      table.transcriptVersionId,
      table.isTest,
      table.revision,
    ),
    foreignKey({
      name: "transcript_review_world_fk",
      columns: [table.transcriptVersionId, table.isTest],
      foreignColumns: [distributionTranscriptVersion.id, distributionTranscriptVersion.isTest],
    }),
    check("transcript_review_decision", sql`${table.decision} IN ('APPROVED','REJECTED')`),
    check("transcript_review_revision_positive", sql`${table.revision} > 1`),
  ],
);
export const distributionQuoteCandidate = distributionSchema.table(
  "quote_candidate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    masterVersionId: uuid("master_version_id").notNull(),
    transcriptVersionId: uuid("transcript_version_id").notNull(),
    candidate: jsonb("candidate").$type<QuoteCandidate>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("quote_candidate_world").on(table.id, table.isTest),
    index("quote_candidate_source").on(table.masterVersionId, table.isTest, table.createdAt),
    foreignKey({
      name: "quote_source_world_fk",
      columns: [table.masterVersionId, table.isTest],
      foreignColumns: [distributionContentVersion.id, distributionContentVersion.isTest],
    }),
    foreignKey({
      name: "quote_transcript_world_fk",
      columns: [table.transcriptVersionId, table.isTest],
      foreignColumns: [distributionTranscriptVersion.id, distributionTranscriptVersion.isTest],
    }),
  ],
);
export const distributionQuoteReview = distributionSchema.table(
  "quote_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    quoteId: uuid("quote_id").notNull(),
    revision: integer("revision").notNull(),
    decision: text("decision").notNull(),
    reviewerId: text("reviewer_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("quote_review_revision").on(table.quoteId, table.isTest, table.revision),
    foreignKey({
      name: "quote_review_world_fk",
      columns: [table.quoteId, table.isTest],
      foreignColumns: [distributionQuoteCandidate.id, distributionQuoteCandidate.isTest],
    }),
    check("quote_review_decision", sql`${table.decision} IN ('APPROVED','REJECTED')`),
    check("quote_review_revision_positive", sql`${table.revision} > 1`),
  ],
);
export const distributionGlossaryVersion = distributionSchema.table(
  "glossary_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    parentVersionId: uuid("parent_version_id"),
    term: text("term").notNull(),
    preferred: text("preferred").notNull(),
    language: text("language").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("glossary_world").on(table.id, table.isTest),
    unique("glossary_single_child").on(table.parentVersionId, table.isTest),
    index("glossary_language").on(table.isTest, table.language, table.term),
    foreignKey({
      name: "glossary_parent_world_fk",
      columns: [table.parentVersionId, table.isTest],
      foreignColumns: [table.id, table.isTest],
    }),
  ],
);

// R3 queue leases are mutable; recipes, artifacts and human decisions are append-only.
export const distributionRenderJob = distributionSchema.table(
  "render_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    masterId: uuid("master_id").notNull(),
    sourceVersionId: uuid("source_version_id").notNull(),
    recipeSha256: text("recipe_sha256").notNull(),
    recipe: jsonb("recipe").$type<RenderRecipe>().notNull(),
    requestedBy: text("requested_by").notNull(),
    status: text("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("render_job_world").on(table.id, table.isTest),
    unique("render_job_recipe_world").on(table.recipeSha256, table.isTest),
    index("render_job_claim").on(table.isTest, table.status, table.availableAt, table.createdAt),
    foreignKey({
      name: "render_job_master_world_fk",
      columns: [table.masterId, table.isTest],
      foreignColumns: [distributionContentMaster.id, distributionContentMaster.isTest],
    }),
    foreignKey({
      name: "render_job_source_world_fk",
      columns: [table.sourceVersionId, table.isTest],
      foreignColumns: [distributionContentVersion.id, distributionContentVersion.isTest],
    }),
    check("render_job_hash", sql`${table.recipeSha256} ~ '^[a-f0-9]{64}$'`),
    check(
      "render_job_attempts",
      sql`${table.maxAttempts} = 3 AND ${table.attempts} >= 0 AND ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check(
      "render_job_status",
      sql`${table.status} IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','STALE')`,
    ),
    check(
      "render_job_lease",
      sql`(${table.status} = 'RUNNING' AND ${table.leaseToken} IS NOT NULL AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL) OR (${table.status} <> 'RUNNING' AND ${table.leaseToken} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseUntil} IS NULL)`,
    ),
  ],
);
export const distributionRenderArtifact = distributionSchema.table(
  "render_artifact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull(),
    isTest: boolean("is_test").notNull(),
    recipeSha256: text("recipe_sha256").notNull(),
    assetSha256: text("asset_sha256").notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("render_artifact_world").on(table.id, table.isTest),
    unique("render_artifact_job_world").on(table.jobId, table.isTest),
    foreignKey({
      name: "render_artifact_job_world_fk",
      columns: [table.jobId, table.isTest],
      foreignColumns: [distributionRenderJob.id, distributionRenderJob.isTest],
    }),
    check(
      "render_artifact_hashes",
      sql`${table.recipeSha256} ~ '^[a-f0-9]{64}$' AND ${table.assetSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);
export const distributionRenderArtifactReview = distributionSchema.table(
  "render_artifact_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id").notNull(),
    isTest: boolean("is_test").notNull(),
    revision: integer("revision").notNull(),
    decision: text("decision").notNull(),
    recipeSha256: text("recipe_sha256").notNull(),
    assetSha256: text("asset_sha256").notNull(),
    reviewerId: text("reviewer_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("render_artifact_review_revision").on(table.artifactId, table.isTest, table.revision),
    foreignKey({
      name: "render_artifact_review_world_fk",
      columns: [table.artifactId, table.isTest],
      foreignColumns: [distributionRenderArtifact.id, distributionRenderArtifact.isTest],
    }),
    check("render_artifact_review_decision", sql`${table.decision} IN ('APPROVED','REJECTED')`),
    check("render_artifact_review_revision_positive", sql`${table.revision} > 1`),
    check(
      "render_artifact_review_hashes",
      sql`${table.recipeSha256} ~ '^[a-f0-9]{64}$' AND ${table.assetSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** Stable world-scoped IDs; every authoring and review transition appends a revision. */
export const distributionOutreachCampaign = distributionSchema.table(
  "outreach_campaign",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [unique("outreach_campaign_world").on(table.id, table.isTest)],
);
export const distributionOutreachCampaignRevision = distributionSchema.table(
  "outreach_campaign_revision",
  {
    campaignId: uuid("campaign_id").notNull(),
    isTest: boolean("is_test").notNull(),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<OutreachCampaign>().notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.isTest, table.revision] }),
    foreignKey({
      columns: [table.campaignId, table.isTest],
      foreignColumns: [distributionOutreachCampaign.id, distributionOutreachCampaign.isTest],
    }),
    index("outreach_campaign_revision_latest").on(table.isTest, table.campaignId, table.revision),
    check(
      "outreach_campaign_revision_valid",
      sql`${table.revision}>0 AND (${table.snapshot}->>'revision')::int=${table.revision} AND ${table.snapshot}->>'id'=${table.campaignId}::text AND ${table.snapshot}->>'kind'='OUTREACH'`,
    ),
    check(
      "outreach_campaign_revision_action",
      sql`${table.action} IN ('CREATED','EDITED','APPROVED','PAUSED','STOPPED')`,
    ),
  ],
);
export const distributionCtaDefinition = distributionSchema.table(
  "cta_definition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [unique("cta_definition_world").on(table.id, table.isTest)],
);
export const distributionCtaRevision = distributionSchema.table(
  "cta_revision",
  {
    ctaId: uuid("cta_id").notNull(),
    isTest: boolean("is_test").notNull(),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<CtaDefinition>().notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.ctaId, table.isTest, table.revision] }),
    foreignKey({
      columns: [table.ctaId, table.isTest],
      foreignColumns: [distributionCtaDefinition.id, distributionCtaDefinition.isTest],
    }),
    index("cta_revision_latest").on(table.isTest, table.ctaId, table.revision),
    check(
      "cta_revision_valid",
      sql`${table.revision}>0 AND (${table.snapshot}->>'revision')::int=${table.revision} AND ${table.snapshot}->>'id'=${table.ctaId}::text`,
    ),
    check("cta_revision_action", sql`${table.action} IN ('CREATED','EDITED','APPROVED')`),
  ],
);

/** Immutable manual-release bindings and a durable signed-cache materialization outbox. */
export const distributionActivation = distributionSchema.table(
  "activation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    masterId: uuid("master_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    ctaId: uuid("cta_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    token: text("token").notNull(),
    sequence: integer("sequence").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("activation_world").on(t.id, t.isTest),
    unique("activation_token").on(t.token),
    foreignKey({
      columns: [t.masterId, t.isTest],
      foreignColumns: [distributionContentMaster.id, distributionContentMaster.isTest],
    }),
    foreignKey({
      columns: [t.campaignId, t.isTest],
      foreignColumns: [distributionOutreachCampaign.id, distributionOutreachCampaign.isTest],
    }),
    foreignKey({
      columns: [t.ctaId, t.isTest],
      foreignColumns: [distributionCtaDefinition.id, distributionCtaDefinition.isTest],
    }),
    foreignKey({
      columns: [t.artifactId, t.isTest],
      foreignColumns: [distributionRenderArtifact.id, distributionRenderArtifact.isTest],
    }),
    check("activation_token_shape", sql`${t.token} ~ '^[A-Za-z0-9_-]{43}$'`),
    check("activation_sequence_nonnegative", sql`${t.sequence} >= 0`),
    index("activation_master_world").on(t.isTest, t.masterId),
    index("activation_campaign_world").on(t.isTest, t.campaignId),
    index("activation_cta_world").on(t.isTest, t.ctaId),
  ],
);
export const distributionActivationRevision = distributionSchema.table(
  "activation_revision",
  {
    activationId: uuid("activation_id").notNull(),
    isTest: boolean("is_test").notNull(),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.activationId, t.isTest, t.revision] }),
    foreignKey({
      columns: [t.activationId, t.isTest],
      foreignColumns: [distributionActivation.id, distributionActivation.isTest],
    }),
    check(
      "activation_revision_valid",
      sql`${t.revision}>0 AND (${t.snapshot}->>'revision')::int=${t.revision} AND ${t.snapshot}->>'id'=${t.activationId}::text`,
    ),
    check(
      "activation_revision_action",
      sql`${t.action} IN ('CREATED','EDITED','DESTINATION_VALIDATED','APPROVED','STOPPED','INVALIDATED')`,
    ),
  ],
);
export const distributionLinkOutbox = distributionSchema.table(
  "link_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    activationId: uuid("activation_id").notNull(),
    isTest: boolean("is_test").notNull(),
    sequence: integer("sequence").notNull(),
    record: jsonb("record").$type<Record<string, unknown>>().notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("link_outbox_sequence").on(t.activationId, t.isTest, t.sequence),
    foreignKey({
      columns: [t.activationId, t.isTest],
      foreignColumns: [distributionActivation.id, distributionActivation.isTest],
    }),
    check(
      "link_outbox_sequence_valid",
      sql`${t.sequence}>0 AND (${t.record}->>'sequence')::int=${t.sequence}`,
    ),
    index("link_outbox_pending").on(t.isTest, t.deliveredAt, t.createdAt),
  ],
);

// Native governance persists once enrolled, even when its authoring flags are off.
export const distributionNativeSource = distributionSchema.table(
  "native_source",
  {
    masterId: uuid("master_id").notNull(),
    isTest: boolean("is_test").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.masterId, t.isTest] }),
    foreignKey({
      columns: [t.masterId, t.isTest],
      foreignColumns: [distributionContentMaster.id, distributionContentMaster.isTest],
    }),
  ],
);
export const distributionNativeAnalysis = distributionSchema.table(
  "native_analysis",
  {
    sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity(),
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    masterId: uuid("master_id").notNull(),
    transcriptId: uuid("transcript_id").notNull(),
    requestId: uuid("request_id").notNull(),
    createdBy: text("created_by").notNull(),
    analysis: jsonb("analysis")
      .$type<import("@satsang/distribution-domain").NativeAnalysis>()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("native_analysis_world").on(t.id, t.isTest),
    unique("native_analysis_request").on(t.createdBy, t.isTest, t.requestId),
    foreignKey({
      columns: [t.masterId, t.isTest],
      foreignColumns: [distributionContentMaster.id, distributionContentMaster.isTest],
    }),
    foreignKey({
      columns: [t.transcriptId, t.isTest],
      foreignColumns: [distributionTranscriptVersion.id, distributionTranscriptVersion.isTest],
    }),
    index("native_analysis_master").on(t.masterId, t.isTest),
  ],
);
export const distributionNativeReview = distributionSchema.table(
  "native_review",
  {
    analysisId: uuid("analysis_id").notNull(),
    isTest: boolean("is_test").notNull(),
    candidateId: text("candidate_id").notNull(),
    revision: integer("revision").notNull(),
    requestId: uuid("request_id").notNull(),
    review: jsonb("review").$type<import("@satsang/distribution-domain").NativeReview>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.analysisId, t.isTest, t.candidateId, t.revision] }),
    unique("native_review_request").on(t.analysisId, t.isTest, t.requestId),
    foreignKey({
      columns: [t.analysisId, t.isTest],
      foreignColumns: [distributionNativeAnalysis.id, distributionNativeAnalysis.isTest],
    }),
    check("native_review_revision_positive", sql`${t.revision}>0`),
  ],
);
export const distributionNativeReviewer = distributionSchema.table(
  "native_reviewer",
  {
    userId: text("user_id").notNull(),
    isTest: boolean("is_test").notNull(),
    language: text("language").notNull(),
    grantedBy: text("granted_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.isTest, t.language] }),
    check("native_reviewer_language", sql`${t.language} IN ('te','kn','ta')`),
  ],
);

// R6 analytics is an independent event plane. None of these tables grants practice credit.
export const distributionAnalyticsPolicy = distributionSchema.table(
  "analytics_policy",
  {
    isTest: boolean("is_test").primaryKey(),
    requestId: uuid("request_id").notNull(),
    retentionDays: integer("retention_days").notNull(),
    approvalReference: uuid("approval_reference").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [check("analytics_retention_bounds", sql`${t.retentionDays} between 7 and 90`)],
);
export const distributionAnalyticsReceipt = distributionSchema.table(
  "analytics_receipt",
  {
    id: uuid("id").notNull(),
    isTest: boolean("is_test").notNull(),
    source: text("source").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    name: text("name").notNull(),
    fingerprint: text("fingerprint").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.isTest] }),
    unique("analytics_source_dedupe").on(t.isTest, t.source, t.sourceEventId, t.name),
  ],
);
export const distributionAnalyticsEvent = distributionSchema.table(
  "analytics_event",
  {
    id: uuid("id").notNull(),
    isTest: boolean("is_test").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    event: jsonb("event").$type<import("@satsang/distribution-domain").AnalyticsEvent>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.isTest, t.receivedAt] }),
    index("analytics_campaign_window").on(t.isTest, t.campaignId, t.occurredAt),
    foreignKey({
      columns: [t.campaignId, t.isTest],
      foreignColumns: [distributionOutreachCampaign.id, distributionOutreachCampaign.isTest],
    }),
  ],
);
export const distributionAggregateSnapshot = distributionSchema.table(
  "aggregate_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    report: jsonb("report")
      .$type<import("@satsang/distribution-domain").AnalyticsAggregate>()
      .notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("analytics_snapshot_input").on(
      t.isTest,
      t.campaignId,
      t.windowStart,
      t.windowEnd,
      t.sourceFingerprint,
    ),
    index("analytics_latest_snapshot").on(t.isTest, t.campaignId, t.generatedAt),
  ],
);
export const distributionProviderMetricSnapshot = distributionSchema.table(
  "provider_metric_snapshot",
  {
    id: uuid("id").notNull(),
    isTest: boolean("is_test").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    provider: text("provider").notNull(),
    metric: text("metric").notNull(),
    value: bigint("value", { mode: "number" }).notNull(),
    currency: text("currency"),
    definitionVersion: integer("definition_version").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    fingerprint: text("fingerprint").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.isTest] }),
    index("analytics_provider_latest").on(t.isTest, t.campaignId, t.observedAt),
  ],
);

export const distributionOnlineImport = distributionSchema.table(
  "online_import",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    source: jsonb("source")
      .$type<import("@satsang/distribution-domain").OnlineVideoSource>()
      .notNull(),
    sourceKey: text("source_key").notNull(),
    requestedBy: text("requested_by").notNull(),
    language: text("language").notNull(),
    category: text("category").notNull(),
    title: text("title"),
    status: text("status").notNull().default("QUEUED"),
    masterId: uuid("master_id"),
    parentId: uuid("parent_id"),
    childIds: jsonb("child_ids").$type<string[]>(),
    curation: jsonb("curation").$type<import("@satsang/distribution-domain").PlaylistCuration>(),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("online_import_source_world")
      .on(t.sourceKey, t.isTest)
      .where(sql`${t.deletedAt} IS NULL`),
    unique("online_import_world").on(t.id, t.isTest),
    index("online_import_queue").on(t.isTest, t.status, t.createdAt),
    foreignKey({
      name: "online_import_master_world_fk",
      columns: [t.masterId, t.isTest],
      foreignColumns: [distributionContentMaster.id, distributionContentMaster.isTest],
    }),
    check("online_import_status", sql`${t.status} IN ('QUEUED','DOWNLOADING','COMPLETE','FAILED')`),
  ],
);

/** Durable media erasure outbox. Metadata/history remain as an audit trail. */
export const distributionStorageCleanup = distributionSchema.table("storage_cleanup", {
  id: uuid("id").primaryKey().defaultRandom(),
  isTest: boolean("is_test").notNull(),
  requestedBy: text("requested_by").notNull(),
  title: text("title").notNull(),
  selection: jsonb("selection").notNull(),
  files: jsonb("files").notNull(),
  removed: jsonb("removed").notNull().default([]),
  status: text("status").notNull().default("QUEUED"),
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

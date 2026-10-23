import type { StudioPackage } from "@satsang/distribution-domain";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  distributionContentMaster,
  distributionContentVersion,
  distributionSchema,
} from "./schema.js";
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const distributionStudioPackage = distributionSchema.table(
  "studio_package",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    masterId: uuid("master_id").notNull(),
    sourceVersionId: uuid("source_version_id").notNull(),
    creationKey: text("creation_key").notNull(),
    generationCheckpoint: jsonb("generation_checkpoint").notNull().default({}),
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("studio_package_world").on(table.id, table.isTest),
    uniqueIndex("studio_package_creation")
      .on(table.creationKey, table.isTest)
      .where(sql`${table.deletedAt} IS NULL`),
    index("studio_package_library").on(table.isTest, table.masterId, table.createdAt),
    foreignKey({
      name: "studio_package_master_fk",
      columns: [table.masterId, table.isTest],
      foreignColumns: [distributionContentMaster.id, distributionContentMaster.isTest],
    }),
    foreignKey({
      name: "studio_package_source_fk",
      columns: [table.sourceVersionId, table.isTest],
      foreignColumns: [distributionContentVersion.id, distributionContentVersion.isTest],
    }),
    check("studio_package_revision_positive", sql`${table.revision}>0`),
    check("studio_package_creation_hash", sql`${table.creationKey} ~ '^[a-f0-9]{64}$'`),
  ],
);
export const distributionStudioRevision = distributionSchema.table(
  "studio_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id").notNull(),
    isTest: boolean("is_test").notNull(),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<StudioPackage>().notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("studio_revision_identity").on(table.packageId, table.isTest, table.revision),
    foreignKey({
      name: "studio_revision_package_fk",
      columns: [table.packageId, table.isTest],
      foreignColumns: [distributionStudioPackage.id, distributionStudioPackage.isTest],
    }),
    check("studio_revision_positive", sql`${table.revision}>0`),
  ],
);
export const distributionStudioFeedback = distributionSchema.table(
  "studio_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id").notNull(),
    isTest: boolean("is_test").notNull(),
    revision: integer("revision").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    comment: text("comment").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "studio_feedback_revision_fk",
      columns: [table.packageId, table.isTest, table.revision],
      foreignColumns: [
        distributionStudioRevision.packageId,
        distributionStudioRevision.isTest,
        distributionStudioRevision.revision,
      ],
    }),
    check(
      "studio_feedback_action",
      sql`${table.action} IN ('APPROVED','REJECTED','DISCARDED','REVISED','SUBMITTED')`,
    ),
    check(
      "studio_feedback_comment",
      sql`length(${table.comment})<=4000 AND (${table.action}<>'REJECTED' OR length(trim(${table.comment}))>0)`,
    ),
  ],
);
const lease = () => ({
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid("lease_token"),
  leaseOwner: text("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const distributionStudioGenerationJob = distributionSchema.table(
  "studio_generation_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id").notNull(),
    isTest: boolean("is_test").notNull(),
    packageRevision: integer("package_revision").notNull(),
    requestedBy: text("requested_by").notNull(),
    status: text("status").notNull().default("QUEUED"),
    progress: jsonb("progress"),
    ...lease(),
  },
  (table) => [
    unique("studio_generation_identity").on(table.packageId, table.isTest, table.packageRevision),
    index("studio_generation_queue").on(table.isTest, table.status, table.availableAt),
    foreignKey({
      name: "studio_generation_revision_fk",
      columns: [table.packageId, table.isTest, table.packageRevision],
      foreignColumns: [
        distributionStudioRevision.packageId,
        distributionStudioRevision.isTest,
        distributionStudioRevision.revision,
      ],
    }),
    check(
      "studio_generation_status",
      sql`${table.status} IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','STALE')`,
    ),
    check("studio_generation_attempts", sql`${table.attempts}>=0 AND ${table.attempts}<=3`),
  ],
);
export const distributionStudioPublicationJob = distributionSchema.table(
  "studio_publication_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id").notNull(),
    isTest: boolean("is_test").notNull(),
    packageRevision: integer("package_revision").notNull(),
    outputId: uuid("output_id").notNull(),
    channel: text("channel").notNull(),
    requestedBy: text("requested_by").notNull(),
    status: text("status").notNull().default("QUEUED"),
    accountId: text("account_id"),
    remoteId: text("remote_id"),
    remoteUrl: text("remote_url"),
    checkpoint: jsonb("checkpoint"),
    destinationKey: text("destination_key"),
    duplicateCheck: jsonb("duplicate_check"),
    ...lease(),
  },
  (table) => [
    unique("studio_publication_world").on(table.id, table.isTest),
    unique("studio_publication_identity").on(
      table.packageId,
      table.isTest,
      table.packageRevision,
      table.outputId,
    ),
    index("studio_publication_destination").on(table.isTest, table.destinationKey, table.status),
    index("studio_publication_queue").on(table.isTest, table.status, table.availableAt),
    foreignKey({
      name: "studio_publication_revision_fk",
      columns: [table.packageId, table.isTest, table.packageRevision],
      foreignColumns: [
        distributionStudioRevision.packageId,
        distributionStudioRevision.isTest,
        distributionStudioRevision.revision,
      ],
    }),
    check(
      "studio_publication_status",
      sql`${table.status} IN ('QUEUED','RUNNING','PROCESSING','PUBLISHED','SIMULATED','BLOCKED','FAILED','UNCERTAIN','CANCELLED')`,
    ),
    check(
      "studio_publication_world_delivery",
      sql`NOT ${table.isTest} OR ${table.status} NOT IN ('PUBLISHED','PROCESSING')`,
    ),
    check("studio_publication_attempts", sql`${table.attempts}>=0`),
  ],
);
export const distributionStudioPublicationAttempt = distributionSchema.table(
  "studio_publication_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicationId: uuid("publication_id").notNull(),
    isTest: boolean("is_test").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    detail: jsonb("detail").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "studio_attempt_publication_fk",
      columns: [table.publicationId, table.isTest],
      foreignColumns: [
        distributionStudioPublicationJob.id,
        distributionStudioPublicationJob.isTest,
      ],
    }),
    check("studio_attempt_positive", sql`${table.attempt}>=0`),
  ],
);

export const distributionStudioSettings = distributionSchema.table(
  "studio_settings",
  {
    isTest: boolean("is_test").primaryKey(),
    sealed: text("sealed").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("studio_settings_size", sql`octet_length(${table.sealed}) <= 65536`)],
);

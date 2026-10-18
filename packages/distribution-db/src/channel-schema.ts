import type { ChannelAdoption, ChannelPublication } from "@satsang/distribution-domain";
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
  uuid,
} from "drizzle-orm/pg-core";
import type { ChannelAccountSnapshot, LocalChannelPlan } from "./channel-repository.js";
import { distributionActivation, distributionSchema } from "./schema.js";
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
/** R5 local rehearsal only. Every table is append-only for the runtime role. */
export const distributionChannelAccount = distributionSchema.table(
  "channel_account",
  {
    id: uuid("id").primaryKey(),
    isTest: boolean("is_test").notNull(),
    channel: text("channel").$type<ChannelAdoption["channel"]>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("channel_account_world").on(table.id, table.isTest),
    check("channel_account_test_only", sql`${table.isTest}=true`),
    check("channel_account_channel", sql`${table.channel} IN ('youtube','telegram')`),
  ],
);
export const distributionChannelAccountRevision = distributionSchema.table(
  "channel_account_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    isTest: boolean("is_test").notNull(),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<ChannelAccountSnapshot>().notNull(),
    requestId: uuid("request_id").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("channel_account_revision_unique").on(table.accountId, table.isTest, table.revision),
    unique("channel_account_request_unique").on(table.accountId, table.isTest, table.requestId),
    foreignKey({
      name: "channel_account_revision_world_fk",
      columns: [table.accountId, table.isTest],
      foreignColumns: [distributionChannelAccount.id, distributionChannelAccount.isTest],
    }),
    check("channel_account_revision_positive", sql`${table.revision}>0`),
    check("channel_account_revision_test_only", sql`${table.isTest}=true`),
  ],
);
export const distributionChannelPublication = distributionSchema.table(
  "channel_publication",
  {
    id: uuid("id").primaryKey(),
    isTest: boolean("is_test").notNull(),
    accountId: uuid("account_id").notNull(),
    activationId: uuid("activation_id").notNull(),
    activationRevision: integer("activation_revision").notNull(),
    publicationKey: text("publication_key").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    plan: jsonb("plan").$type<LocalChannelPlan>().notNull(),
    simulationOnly: boolean("simulation_only").notNull().default(true),
    approvedBy: text("approved_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("channel_publication_world").on(table.id, table.isTest),
    unique("channel_publication_identity").on(table.publicationKey),
    index("channel_publication_calendar").on(table.isTest, table.createdAt, table.id),
    foreignKey({
      name: "channel_publication_account_world_fk",
      columns: [table.accountId, table.isTest],
      foreignColumns: [distributionChannelAccount.id, distributionChannelAccount.isTest],
    }),
    foreignKey({
      name: "channel_publication_activation_world_fk",
      columns: [table.activationId, table.isTest],
      foreignColumns: [distributionActivation.id, distributionActivation.isTest],
    }),
    check(
      "channel_publication_local_only",
      sql`${table.isTest}=true AND ${table.simulationOnly}=true`,
    ),
    check("channel_publication_sha", sql`${table.payloadSha256} ~ '^[a-f0-9]{64}$'`),
  ],
);
export const distributionChannelPublicationRevision = distributionSchema.table(
  "channel_publication_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicationId: uuid("publication_id").notNull(),
    isTest: boolean("is_test").notNull(),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").$type<ChannelPublication>().notNull(),
    action: text("action").notNull(),
    requestId: uuid("request_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique("channel_publication_revision_unique").on(
      table.publicationId,
      table.isTest,
      table.revision,
    ),
    unique("channel_publication_request_unique").on(
      table.publicationId,
      table.isTest,
      table.requestId,
    ),
    foreignKey({
      name: "channel_publication_revision_world_fk",
      columns: [table.publicationId, table.isTest],
      foreignColumns: [distributionChannelPublication.id, distributionChannelPublication.isTest],
    }),
    check("channel_publication_revision_positive", sql`${table.revision}>0`),
    check("channel_publication_revision_test_only", sql`${table.isTest}=true`),
    check(
      "channel_publication_revision_action",
      sql`${table.action} IN ('PREPARED','CLAIMED','SIMULATED_RESULT','RECOVERED')`,
    ),
  ],
);

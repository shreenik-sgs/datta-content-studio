import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { distributionContentMaster, distributionSchema } from "./schema";
import { distributionStudioPackage } from "./studio-schema";
const time = (name: string) => timestamp(name, { withTimezone: true });
export const distributionLiveMonitor = distributionSchema.table(
  "live_monitor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    channelId: text("channel_id").notNull(),
    settings: jsonb("settings").notNull(),
    revision: integer("revision").notNull().default(1),
    requestedBy: text("requested_by").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    checkedAt: time("checked_at"),
    error: text("error"),
    availableAt: time("available_at").notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseUntil: time("lease_until"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("live_monitor_world").on(t.id, t.isTest),
    unique("live_monitor_channel").on(t.channelId, t.isTest),
    check("live_monitor_revision", sql`${t.revision}>0`),
  ],
);
export const distributionLiveBroadcast = distributionSchema.table(
  "live_broadcast",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    monitorId: uuid("monitor_id").notNull(),
    videoId: text("video_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("CAPTURING"),
    state: jsonb("state").notNull(),
    error: text("error"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("live_broadcast_world").on(t.id, t.isTest),
    unique("live_broadcast_video").on(t.videoId, t.isTest),
    foreignKey({
      columns: [t.monitorId, t.isTest],
      foreignColumns: [distributionLiveMonitor.id, distributionLiveMonitor.isTest],
    }),
    check("live_broadcast_status", sql`${t.status} IN ('CAPTURING','ENDED','NEEDS_ATTENTION')`),
  ],
);
export const distributionLiveWindow = distributionSchema.table(
  "live_window",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isTest: boolean("is_test").notNull(),
    broadcastId: uuid("broadcast_id").notNull(),
    number: integer("number").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    ownedEndMs: integer("owned_end_ms").notNull(),
    masterId: uuid("master_id").notNull(),
    packageId: uuid("package_id"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("live_window_identity").on(t.broadcastId, t.isTest, t.number),
    foreignKey({
      columns: [t.broadcastId, t.isTest],
      foreignColumns: [distributionLiveBroadcast.id, distributionLiveBroadcast.isTest],
    }),
    foreignKey({
      columns: [t.masterId, t.isTest],
      foreignColumns: [distributionContentMaster.id, distributionContentMaster.isTest],
    }),
    foreignKey({
      columns: [t.packageId, t.isTest],
      foreignColumns: [distributionStudioPackage.id, distributionStudioPackage.isTest],
    }),
    check(
      "live_window_span",
      sql`${t.startMs}>=0 AND ${t.endMs}>${t.startMs} AND ${t.ownedEndMs}>0 AND ${t.ownedEndMs}<=${t.endMs}-${t.startMs}+1`,
    ),
  ],
);

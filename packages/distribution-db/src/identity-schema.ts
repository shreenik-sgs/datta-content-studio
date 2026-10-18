import { boolean, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { distributionSchema } from "./schema";
export const studioOperator = distributionSchema.table("operator", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  roles: jsonb("roles").$type<string[]>().notNull(),
  isTest: boolean("is_test").notNull(),
  active: boolean("active").notNull().default(true),
  locale: text("locale").notNull().default("en"),
});
export const studioSession = distributionSchema.table("operator_session", {
  tokenHash: text("token_hash").primaryKey(),
  operatorId: uuid("operator_id")
    .notNull()
    .references(() => studioOperator.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const studioLoginAttempt = distributionSchema.table("login_attempt", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

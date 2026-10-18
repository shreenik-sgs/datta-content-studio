import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/schema.ts",
    "./src/channel-schema.ts",
    "./src/studio-schema.ts",
    "./src/live-schema.ts",
    "./src/identity-schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DISTRIBUTION_MIGRATION_DATABASE_URL ?? "" },
  migrations: { schema: "distribution_migrations", table: "__distribution_migrations" },
  strict: true,
  verbose: true,
});

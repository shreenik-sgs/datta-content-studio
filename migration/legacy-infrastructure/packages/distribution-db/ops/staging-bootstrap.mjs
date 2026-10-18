// Explicit pre-deploy job. Never run by an application container.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { bootstrapConfig } from "./bootstrap-config.mjs";

async function main() {
  const { target, runtimeUrl, migrationUrl, database, migrator, runtime } = bootstrapConfig(
    process.env,
  );
  const admin = new pg.Pool({
    host: process.env.HUB_DATABASE_HOST,
    port: 5432,
    database: "postgres",
    user: process.env.HUB_DATABASE_ADMIN_USER,
    password: process.env.HUB_DATABASE_ADMIN_PASSWORD,
    ssl: { rejectUnauthorized: true },
    max: 1,
  });
  const quote = (value) => `"${value.replaceAll('"', '""')}"`;
  try {
    for (const [url, role] of [
      [migrationUrl, migrator],
      [runtimeUrl, runtime],
    ]) {
      const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
      if (!exists.rowCount)
        await admin.query(
          `CREATE ROLE ${role} LOGIN PASSWORD '${url.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
        );
    }
    await admin.query(`GRANT ${migrator} TO ${quote(process.env.HUB_DATABASE_ADMIN_USER)}`);
    const existing = await admin.query(
      "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
      [database],
    );
    if (!existing.rowCount) await admin.query(`CREATE DATABASE ${database} OWNER ${migrator}`);
    else if (existing.rows[0].owner !== migrator) throw Error("UNEXPECTED_DATABASE_OWNER");
    await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${runtime}`);
  } finally {
    await admin.end();
  }
  const owner = new pg.Pool({ connectionString: migrationUrl.href, max: 1 });
  try {
    await owner.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
    await migrate(drizzle(owner), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      migrationsSchema: "distribution_migrations",
      migrationsTable: "__distribution_migrations",
    });
    const grants = await readFile(new URL("./runtime-grants.sql", import.meta.url), "utf8");
    await owner.query(grants.replaceAll(":'distribution_runtime_role'", `'${runtime}'`));
  } finally {
    await owner.end();
  }
  const restricted = new pg.Pool({ connectionString: runtimeUrl.href, max: 1 });
  try {
    await restricted.query("SELECT count(*) FROM distribution.module_state");
    for (const sql of [
      "SELECT * FROM distribution_migrations.__distribution_migrations",
      "CREATE TABLE distribution.__forbidden_probe(id integer)",
    ]) {
      let denied = false;
      try {
        await restricted.query(sql);
      } catch (error) {
        if (error.code === "42501") denied = true;
        else throw error;
      }
      if (!denied) throw Error("DATABASE_BOUNDARY_FAILED");
    }
  } finally {
    await restricted.end();
  }
  console.info(
    `${target} Hub migration, restricted runtime access and settings initialization passed.`,
  );
}
main().catch(() => {
  console.error("HUB_BOOTSTRAP_FAILED");
  process.exitCode = 1;
});

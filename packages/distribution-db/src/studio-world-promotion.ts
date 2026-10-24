import { createHash, createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import { parseStudioProviderConfig, sealStudioProviderConfig } from "./studio-provider-config";

// One-shot operator tooling for an isolated clone, never an application boot migration.
const supported = new Set([
  "operator",
  "operator_session",
  "login_attempt",
  "module_state",
  "capability_grant",
  "content_master",
  "content_version",
  "content_rights",
  "approval_decision",
  "audit_event",
  "native_reviewer",
  "reviewer_language_audit",
  "online_import",
  "storage_cleanup",
  "studio_package",
  "studio_revision",
  "studio_feedback",
  "studio_generation_job",
  "studio_settings",
]);
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)]),
    );
  return value;
}
const worldKey = (test: boolean, key: string) =>
  createHmac("sha256", Buffer.from(key, "hex"))
    .update(`studio-settings-world:${test}`)
    .digest("hex");

/** The caller must restore a fresh backup into this separate database with all workers stopped. */
export async function promoteGbadptClone(
  client: PoolClient,
  input: { key: string; apply: boolean },
) {
  if (!/^[a-f0-9]{64}$/i.test(input.key)) throw Error("PROMOTION_KEY_REQUIRED");
  await client.query("BEGIN");
  try {
    const database = (await client.query("SELECT current_database() name")).rows[0].name;
    if (database !== "datta_content_studio_gbadpt_live") throw Error("PROMOTION_WRONG_DATABASE");
    await client.query("SELECT pg_advisory_xact_lock(74490321)");
    const tables: string[] = (
      await client.query(`SELECT c.relname name FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='distribution' AND c.relkind IN ('r','p') AND NOT c.relispartition
      ORDER BY c.relname`)
    ).rows.map((r) => r.name);
    await client.query(
      `LOCK TABLE ${tables.map((t) => `distribution.${identifier(t)}`).join(",")} IN ACCESS EXCLUSIVE MODE`,
    );
    const before = new Map<string, Record<string, unknown>[]>();
    for (const table of tables) {
      const rows = (
        await client.query(
          `SELECT to_jsonb(t) value FROM distribution.${identifier(table)} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows.map((r) => r.value);
      if (rows.length && !supported.has(table)) throw Error(`PROMOTION_UNSUPPORTED_TABLE_${table}`);
      if (rows.some((row: Record<string, unknown>) => "is_test" in row && row.is_test !== true))
        throw Error("PROMOTION_REQUIRES_TEST_ONLY_CLONE");
      before.set(table, rows);
    }
    if (
      (before.get("studio_generation_job") ?? []).some((r) => r.status === "RUNNING") ||
      (before.get("online_import") ?? []).some((r) => r.status === "DOWNLOADING")
    )
      throw Error("PROMOTION_WORKERS_MUST_BE_DRAINED");
    if ((before.get("storage_cleanup") ?? []).some((r) => r.status !== "COMPLETE"))
      throw Error("PROMOTION_CLEANUP_MUST_BE_COMPLETE");
    const heartbeats = before.get("module_state") ?? [];
    if (
      heartbeats.some(
        (row) =>
          !["online-import-worker:true", "live-curation-worker:true"].includes(String(row.id)) ||
          row.schema_version !== 1,
      )
    )
      throw Error("PROMOTION_UNKNOWN_MODULE_STATE");
    const settings = before.get("studio_settings");
    if (settings?.length !== 1) throw Error("PROMOTION_SETTINGS_REQUIRED");
    const config = parseStudioProviderConfig(
      JSON.parse(String(settings[0]?.sealed)),
      worldKey(true, input.key),
    );
    const target = config.accounts.find(
      (a) => a.platform === "youtube" && a.enabled && a.isDefault,
    );
    if (
      target?.channelUrl !== "https://www.youtube.com/@gurubhavana" ||
      target.transport !== "buffer" ||
      !target.accessToken ||
      !target.providerAccountId ||
      target.connectionPending
    )
      throw Error("PROMOTION_DESTINATION_MISMATCH");
    const expected = new Map<string, Record<string, unknown>[]>();
    for (const [table, rows] of before) {
      expected.set(
        table,
        table === "operator_session" || table === "module_state"
          ? []
          : rows.map((row) => {
              const next = structuredClone(row);
              if ("is_test" in next) next.is_test = false;
              if (table === "studio_revision") {
                const snapshot = next.snapshot as Record<string, unknown>;
                if (snapshot.isTest !== true) throw Error("PROMOTION_SNAPSHOT_WORLD_MISMATCH");
                snapshot.isTest = false;
              }
              if (table === "studio_settings")
                next.sealed = sealStudioProviderConfig(config, worldKey(false, input.key));
              return next;
            }),
      );
    }
    const constraints = (
      await client.query(`SELECT c.conname, t.relname, c.condeferrable, c.condeferred
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='distribution' AND c.contype='f' AND c.conparentid=0`)
    ).rows;
    for (const c of constraints)
      await client.query(
        `ALTER TABLE distribution.${identifier(c.relname)} ALTER CONSTRAINT ${identifier(c.conname)} DEFERRABLE INITIALLY DEFERRED`,
      );
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    for (const [table, rows] of before) {
      if (rows.some((row) => "is_test" in row))
        await client.query(`UPDATE distribution.${identifier(table)} SET is_test=false`);
    }
    await client.query(
      "UPDATE distribution.studio_revision SET snapshot=jsonb_set(snapshot,'{isTest}','false'::jsonb)",
    );
    await client.query("UPDATE distribution.studio_settings SET sealed=$1", [
      expected.get("studio_settings")?.[0]?.sealed,
    ]);
    // An existing TEST browser session must never silently acquire real-posting access.
    await client.query("DELETE FROM distribution.operator_session");
    // TEST worker liveness is not evidence that a LIVE worker has started.
    await client.query("DELETE FROM distribution.module_state");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const c of constraints)
      await client.query(
        `ALTER TABLE distribution.${identifier(c.relname)} ALTER CONSTRAINT ${identifier(c.conname)} ${c.condeferrable ? `DEFERRABLE INITIALLY ${c.condeferred ? "DEFERRED" : "IMMEDIATE"}` : "NOT DEFERRABLE"}`,
      );
    const stable = (rows: Record<string, unknown>[]) =>
      rows.map((r) => JSON.stringify(sorted(r))).sort();
    // Compare PostgreSQL-normalized JSON to retain nested content and evidence exactly.
    for (const [table, rows] of expected) {
      const actual = (
        await client.query(`SELECT to_jsonb(t) value FROM distribution.${identifier(table)} t`)
      ).rows.map((r) => r.value);
      const normalized = (
        await client.query("SELECT value FROM jsonb_array_elements($1::jsonb) value", [
          JSON.stringify(rows),
        ])
      ).rows.map((r) => r.value);
      if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(normalized)))
        throw Error(`PROMOTION_CONTENT_CHANGED_${table}`);
    }
    const verifySettings = parseStudioProviderConfig(
      JSON.parse(String(expected.get("studio_settings")?.[0]?.sealed)),
      worldKey(false, input.key),
    );
    if (digest(verifySettings) !== digest(config)) throw Error("PROMOTION_SETTINGS_CHANGED");
    const report = {
      applied: input.apply,
      tables: [...before]
        .filter(([, rows]) => rows.length)
        .map(([table, rows]) => ({ table, rows: rows.length })),
      sessionsRevoked: before.get("operator_session")?.length ?? 0,
      workerHeartbeatsReset: heartbeats.length,
      preservedRevisions: before.get("studio_revision")?.length ?? 0,
      destination: target.channelUrl,
      publicationJobs: 0,
    };
    await client.query(input.apply ? "COMMIT" : "ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

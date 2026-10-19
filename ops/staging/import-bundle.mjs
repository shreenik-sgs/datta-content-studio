import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
// Explicit one-shot migration into an EMPTY independent staging database.
// Never imports sessions, production rows, publication jobs or original passwords.
import { createRequire } from "node:module";
const require = createRequire("/repo/apps/distribution-worker/package.json");
const { Pool } = require("pg");
const url = new URL(process.env.DISTRIBUTION_MIGRATION_DATABASE_URL ?? "");
if (url.hostname !== "127.0.0.1" || url.pathname !== "/datta_content_studio_staging")
  throw Error("WRONG_TARGET");
const raw = await readFile("/import/series.json");
if (createHash("sha256").update(raw).digest("hex") !== process.env.STUDIO_IMPORT_SHA256)
  throw Error("SNAPSHOT_CHANGED");
const data = JSON.parse(raw);
const tables = [
  "operator",
  "capability_grant",
  "content_master",
  "content_version",
  "content_rights",
  "approval_decision",
  "audit_event",
  "transcript_version",
  "transcript_review",
  "studio_package",
  "studio_revision",
  "studio_feedback",
  "studio_generation_job",
  "studio_publication_job",
  "online_import",
];
if (
  data.content_master.length !== 51 ||
  data.studio_package.length !== 51 ||
  data.online_import.length !== 52 ||
  data.studio_publication_job.length ||
  data.approval_decision.length
)
  throw Error("UNEXPECTED_BUNDLE");
if (data.studio_generation_job.some((x) => ["QUEUED", "RUNNING"].includes(x.status)))
  throw Error("ACTIVE_JOBS");
const pool = new Pool({ connectionString: url.toString(), max: 1 });
const c = await pool.connect();
const canonical = (x) => JSON.stringify(sort(x));
function sort(x) {
  return Array.isArray(x)
    ? x.map(sort)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sort(x[k])]),
        )
      : x;
}
try {
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(78194621)");
  for (const table of tables) {
    if ((await c.query(`SELECT 1 FROM distribution.${table} LIMIT 1`)).rowCount)
      throw Error(`TARGET_NOT_EMPTY_${table}`);
    const rows = data[table];
    if (rows.some((row) => row.is_test !== true)) throw Error("NON_TEST_ROWS");
    if (!rows.length) continue;
    await c.query(
      `INSERT INTO distribution.${table} SELECT * FROM jsonb_populate_recordset(NULL::distribution.${table},$1::jsonb)`,
      [JSON.stringify(rows)],
    );
    const actual = (await c.query(`SELECT to_jsonb(t) row FROM distribution.${table} t`)).rows.map(
      (x) => x.row,
    );
    const expected = rows.map(canonical).sort();
    if (canonical(actual.map(canonical).sort()) !== canonical(expected))
      throw Error(`ROW_MISMATCH_${table}`);
  }
  const current = (
    await c.query(
      "SELECT r.snapshot FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision",
    )
  ).rows.map((x) => x.snapshot);
  const outputs = current.flatMap((p) => p.outputs.filter((o) => o.included && o.asset));
  if (outputs.length !== 95 || current.some((p) => !["DRAFT", "FAILED"].includes(p.status)))
    throw Error("DRAFT_STATE_MISMATCH");
  await c.query("COMMIT");
  console.info(
    JSON.stringify({
      imported: true,
      recordings: current.length,
      shorts: outputs.length,
      publishing: false,
    }),
  );
} catch (error) {
  await c.query("ROLLBACK");
  throw error;
} finally {
  c.release();
  await pool.end();
}

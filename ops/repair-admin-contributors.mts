// Removes administrators who were recorded as package contributors by administrative
// maintenance alone (the 26 October 2026 subscription-destination retarget), so the
// posting check stops refusing every package for a role an administrator never holds.
// Dry run by default; --apply writes the current revision's contributor list with the
// migration account. Former curators who authored content are reported, never removed.
// Usage: DISTRIBUTION_HUB_STAGE=TEST DISTRIBUTION_MIGRATION_DATABASE_URL=... \
//   node --import tsx ops/repair-admin-contributors.mts [--apply] [--report file.json]
import { writeFileSync } from "node:fs";
import { studioIdentityPool } from "../packages/distribution-db/src/operator-store";
import {
  type StudioContributorRecord,
  studioRepairContributors,
} from "../packages/distribution-domain/src/studio-contributors";
type Report = {
  packageId: string;
  revision: number;
  removed: { id: string; roles: string[] | null }[];
  revoked: { id: string; roles: string[] | null }[];
};
async function main() {
  const apply = process.argv.includes("--apply");
  const reportIndex = process.argv.indexOf("--report");
  const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
  const stage = process.env.DISTRIBUTION_HUB_STAGE ?? "";
  if (
    !["TEST", "LIMITED", "ON"].includes(stage) ||
    !process.env.DISTRIBUTION_MIGRATION_DATABASE_URL
  )
    throw Error("Set DISTRIBUTION_MIGRATION_DATABASE_URL and the Hub stage.");
  const isTest = stage === "TEST";
  const pool = studioIdentityPool({
    DISTRIBUTION_DATABASE_URL: process.env.DISTRIBUTION_MIGRATION_DATABASE_URL,
  });
  const client = await pool.connect();
  const reports: Report[] = [];
  try {
    await client.query("BEGIN");
    const packages = await client.query(
      `SELECT p.id::text AS id, p.revision, r.snapshot->>'createdBy' AS created_by,
              r.snapshot->'contributorIds' AS contributor_ids
       FROM distribution.studio_package p
       JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision
       WHERE p.is_test=$1 AND p.deleted_at IS NULL ORDER BY p.created_at, p.id FOR UPDATE OF p`,
      [isTest],
    );
    const operators = await client.query(
      "SELECT id::text AS id, roles, active FROM distribution.operator WHERE is_test=$1",
      [isTest],
    );
    const operatorById = new Map<string, { roles: string[]; active: boolean }>(
      operators.rows.map((row) => [
        String(row.id),
        { roles: Array.isArray(row.roles) ? row.roles.map(String) : [], active: !!row.active },
      ]),
    );
    for (const row of packages.rows) {
      const contributorIds: string[] = Array.isArray(row.contributor_ids)
        ? row.contributor_ids.map(String)
        : [];
      const actions = await client.query(
        "SELECT actor_id, array_agg(DISTINCT action) AS actions FROM distribution.studio_revision WHERE package_id=$1 AND is_test=$2 GROUP BY actor_id",
        [row.id, isTest],
      );
      const records = new Map<string, StudioContributorRecord>();
      for (const id of contributorIds) {
        const operator = operatorById.get(id);
        records.set(id, {
          id,
          roles: operator ? operator.roles : null,
          active: operator?.active ?? false,
          actions: actions.rows.find((entry) => String(entry.actor_id) === id)?.actions ?? [],
        });
      }
      const decision = studioRepairContributors({
        createdBy: String(row.created_by ?? ""),
        contributorIds,
        records,
      });
      if (!decision.removed.length && !decision.revoked.length) continue;
      const describe = (id: string) => ({ id, roles: operatorById.get(id)?.roles ?? null });
      reports.push({
        packageId: row.id,
        revision: row.revision,
        removed: decision.removed.map(describe),
        revoked: decision.revoked.map(describe),
      });
      if (apply && decision.removed.length) {
        const updated = await client.query(
          "UPDATE distribution.studio_revision SET snapshot=jsonb_set(snapshot,'{contributorIds}',$3::jsonb) WHERE package_id=$1 AND is_test=$2 AND revision=$4",
          [row.id, isTest, JSON.stringify(decision.contributorIds), row.revision],
        );
        if (updated.rowCount !== 1) throw Error("REVISION_CHANGED");
      }
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  const removed = reports.filter((r) => r.removed.length).length;
  const revoked = reports.filter((r) => r.revoked.length).length;
  for (const report of reports)
    console.info(
      `${report.packageId} rev ${report.revision}: ${apply ? "removed" : "would remove"} ${report.removed.map((r) => r.id).join(", ") || "none"}${report.revoked.length ? `; revoked curators kept: ${report.revoked.map((r) => r.id).join(", ")}` : ""}`,
    );
  console.info(
    `${apply ? "Applied" : "Dry run"}: ${removed} package(s) with administrators removed from contributors; ${revoked} package(s) still name a revoked curator for Admin review.`,
  );
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ apply, isTest, reports }, null, 2));
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Contributor repair failed.");
  process.exitCode = 1;
});

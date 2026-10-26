import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { createStudioRoleAuthority } from "../packages/distribution-db/src/studio-authority.ts";
import { createIntelligentContentRepository } from "../packages/distribution-db/src/studio-repository.ts";
import {
  type StudioPackage,
  prepareStudioYoutubeClosingRefresh,
  studioYoutubeClosing,
} from "../packages/distribution-domain/src/index.ts";

// Explicit owner-authorized maintenance, with immutable history and no publishing.
// Dry run first. The original assets remain available in history; replacement
// assets cannot be submitted until the closing renderer has verified preservation.
const env = process.env;
const database = new URL(env.DISTRIBUTION_DATABASE_URL ?? "");
const isTest = env.DISTRIBUTION_HUB_STAGE === "TEST";
const origin = env.DISTRIBUTION_APP_ORIGIN;
const local =
  isTest &&
  database.pathname === "/datta_content_studio_local" &&
  origin === "http://localhost:3070";
const hosted =
  !isTest &&
  env.DISTRIBUTION_HUB_STAGE === "ON" &&
  database.pathname === "/datta_content_studio_gbadpt_live" &&
  origin === "https://gbadpt.sgsdattasannidhi.org" &&
  process.argv.includes("--allow-live-drafts");
if (
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  env.STUDIO_IDENTITY !== "gbadpt" ||
  (!local && !hosted)
)
  throw Error("WRONG_TARGET");
const bundleId = env.STUDIO_BUNDLE_ID ?? "";
if (!/^[0-9a-f-]{36}$/.test(bundleId)) throw Error("BUNDLE_REQUIRED");
const target = studioYoutubeClosing({
  label: env.STUDIO_CLOSING_LABEL ?? "",
  url: env.STUDIO_CLOSING_URL ?? "",
});
const apply = process.argv.includes("--apply");
const onlyPackage = env.STUDIO_ONLY_PACKAGE_ID;
const pool = new Pool({ connectionString: database.toString(), max: 4 });
try {
  const actor = (
    await pool.query(
      "SELECT id,roles FROM distribution.operator WHERE email=$1 AND is_test=$2 AND active=true",
      [env.STUDIO_ACTOR_EMAIL, isTest],
    )
  ).rows[0];
  if (!actor?.roles?.includes("SUPER_ADMIN")) throw Error("ADMIN_REQUIRED");
  const ctx = { userId: actor.id as string, isTest, roles: actor.roles as string[] };
  const root = (
    await pool.query(
      "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
      [bundleId, isTest],
    )
  ).rows[0];
  if (!root?.curation?.request || !root.child_ids?.length) throw Error("BUNDLE_NOT_READY");
  const ids = [
    ...new Set(
      Object.values(root.curation.items as Record<string, { packageId?: string }>)
        .map((item) => item.packageId)
        .filter(Boolean),
    ),
  ];
  const rows = (
    await pool.query(
      "SELECT p.id,r.snapshot FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision WHERE p.id=ANY($1::uuid[]) AND p.is_test=$2 AND p.deleted_at IS NULL ORDER BY p.id",
      [ids, isTest],
    )
  ).rows as { id: string; snapshot: StudioPackage }[];
  if (rows.length !== ids.length || rows.length !== Number(env.STUDIO_EXPECTED_PACKAGES))
    throw Error("PACKAGE_COUNT_CHANGED");
  const outputs = rows.flatMap((row) => row.snapshot.outputs.filter((o) => o.asset));
  if (outputs.length !== Number(env.STUDIO_EXPECTED_OUTPUTS)) throw Error("OUTPUT_COUNT_CHANGED");
  if (onlyPackage && !ids.includes(onlyPackage)) throw Error("PACKAGE_NOT_IN_BUNDLE");
  const selected = rows.filter((row) => !onlyPackage || row.id === onlyPackage);
  const changes = selected.filter(
    (row) =>
      row.snapshot.request.youtubeClosing?.url !== target.url ||
      row.snapshot.request.youtubeClosing?.label !== target.label,
  );
  // Validate the entire batch before changing any package. A revision check in
  // each transaction also protects a curator editing during this operation.
  for (const row of changes)
    prepareStudioYoutubeClosingRefresh(row.snapshot, target, {
      userId: ctx.userId,
      at: new Date().toISOString(),
    });
  if (
    (
      await pool.query(
        "SELECT 1 FROM distribution.studio_publication_job WHERE package_id=ANY($1::uuid[]) AND is_test=$2 AND status IN ('QUEUED','RUNNING','PROCESSING','UNCERTAIN') LIMIT 1",
        [selected.map((row) => row.id), isTest],
      )
    ).rowCount
  )
    throw Error("PUBLICATION_BUSY");
  console.info(
    JSON.stringify({
      dryRun: !apply,
      origin,
      bundleId,
      packages: rows.length,
      outputs: outputs.length,
      changes: changes.length,
      target,
    }),
  );
  if (apply) {
    if (!env.STUDIO_RETARGET_BACKUP_PATH) throw Error("BACKUP_REQUIRED");
    await writeFile(
      env.STUDIO_RETARGET_BACKUP_PATH,
      JSON.stringify({ at: new Date().toISOString(), origin, root, packages: rows }),
      { mode: 0o600, flag: "wx" },
    );
    const repo = createIntelligentContentRepository(pool, {
      authorize: createStudioRoleAuthority(env, pool),
    });
    for (const row of changes) {
      const next = await repo.refreshYoutubeDestination(ctx, row.id, {
        expectedRevision: row.snapshot.revision,
        target,
      });
      console.info(
        JSON.stringify({
          packageId: next.id,
          revision: next.revision,
          state: next.status,
          replacementCards: next.generation?.outputIds?.length ?? 0,
        }),
      );
    }
    if (!onlyPackage) {
      const updated = {
        ...root.curation,
        request: { ...root.curation.request, youtubeClosing: target },
      };
      const result = await pool.query(
        "UPDATE distribution.online_import SET curation=$3,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 AND curation=$4::jsonb",
        [bundleId, isTest, updated, root.curation],
      );
      if (result.rowCount !== 1) throw Error("BUNDLE_SETTINGS_CHANGED_RELOAD_AND_RETRY");
    }
  }
} finally {
  await pool.end();
}

import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  type StudioPackage,
  retargetStudioYoutubeClosing,
  reviseStudioYoutubeClosing,
  studioYoutubeClosing,
  validateStudioOutputs,
} from "../packages/distribution-domain/src/index.ts";

// Explicit, audited TEST-bundle maintenance. Reviewed snapshots and media stay immutable.
const url = new URL(
  process.env.DISTRIBUTION_MIGRATION_DATABASE_URL ?? process.env.DISTRIBUTION_DATABASE_URL ?? "",
);
const isolatedLiveClone =
  url.pathname === "/datta_content_studio_gbadpt_live" &&
  process.env.STUDIO_IDENTITY === "gbadpt" &&
  process.env.DISTRIBUTION_HUB_STAGE === "TEST" &&
  process.env.STUDIO_PUBLISHING_ENABLED === "false";
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  (!isolatedLiveClone &&
    !["/datta_content_studio_local", "/datta_content_studio_staging"].includes(url.pathname))
)
  throw Error("WRONG_TARGET");
const bundle = process.env.STUDIO_BUNDLE_ID ?? "";
if (!/^[0-9a-f-]{36}$/.test(bundle)) throw Error("BUNDLE_REQUIRED");
const target = studioYoutubeClosing({
  label: process.env.STUDIO_CLOSING_LABEL ?? "",
  url: process.env.STUDIO_CLOSING_URL ?? "",
});
const apply = process.argv.includes("--apply");
// Use only after explicit owner authorization to invalidate reviewed copies.
const reviseReviewed = process.argv.includes("--revise-reviewed");
const pool = new Pool({ connectionString: url.toString(), max: 1 });
const c = await pool.connect();
try {
  await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  const root = (
    await c.query(
      "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=true AND deleted_at IS NULL FOR UPDATE",
      [bundle],
    )
  ).rows[0];
  if (!root?.curation?.request || !root.child_ids?.length) throw Error("BUNDLE_NOT_READY");
  const ids = [
    ...new Set(
      Object.values(root.curation.items as Record<string, { packageId?: string }>)
        .map((v) => v.packageId)
        .filter(Boolean),
    ),
  ];
  const rows = (
    await c.query(
      "SELECT p.id,p.revision,r.snapshot FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision WHERE p.is_test=true AND p.deleted_at IS NULL AND p.id=ANY($1::uuid[]) ORDER BY p.id FOR UPDATE OF p",
      [ids],
    )
  ).rows;
  if (rows.length !== Number(process.env.STUDIO_EXPECTED_PACKAGES) || rows.length !== ids.length)
    throw Error("PACKAGE_COUNT_CHANGED");
  if (
    (
      await c.query(
        "SELECT 1 FROM distribution.studio_generation_job WHERE is_test=true AND package_id=ANY($1::uuid[]) AND status IN ('QUEUED','RUNNING') UNION ALL SELECT 1 FROM distribution.studio_publication_job WHERE is_test=true AND package_id=ANY($1::uuid[]) LIMIT 1",
        [ids],
      )
    ).rowCount
  )
    throw Error("ACTIVE_OR_PUBLISHED");
  const actor = (
    await c.query(
      "SELECT id FROM distribution.operator WHERE is_test=true AND active=true AND email=$1 AND roles ? 'CONTENT_COORDINATOR'",
      [process.env.STUDIO_ACTOR_EMAIL],
    )
  ).rows[0];
  if (!actor) throw Error("CURATOR_REQUIRED");
  const changes = rows.map((row) => {
    const pkg = row.snapshot as StudioPackage;
    const next = reviseReviewed
      ? reviseStudioYoutubeClosing(pkg, target, { userId: actor.id, at: new Date().toISOString() })
      : retargetStudioYoutubeClosing(pkg, target);
    validateStudioOutputs(next.outputs, {
      packageId: next.id,
      source: next.source,
      request: next.request,
      provenance: next.provenance,
    });
    return { before: pkg, next };
  });
  const outputs = changes.flatMap((x) => x.next.outputs.filter((o) => o.included && o.asset));
  if (outputs.length !== Number(process.env.STUDIO_EXPECTED_OUTPUTS))
    throw Error("OUTPUT_COUNT_CHANGED");
  const changed = changes.filter((x) => x.before !== x.next);
  if (apply) {
    const backup = process.env.STUDIO_RETARGET_BACKUP_PATH;
    if (!backup) throw Error("BACKUP_REQUIRED");
    await writeFile(
      backup,
      JSON.stringify({ at: new Date().toISOString(), bundle: root, packages: rows }),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    for (const { before, next } of changed) {
      const saved = {
        ...next,
        revision: before.revision + 1,
        updatedAt: new Date().toISOString(),
        contributorIds: [...new Set([...next.contributorIds, actor.id])],
      };
      await c.query(
        "INSERT INTO distribution.studio_revision(package_id,is_test,revision,snapshot,actor_id,action) VALUES($1,true,$2,$3,$4,$5)",
        [saved.id, saved.revision, saved, actor.id, "CLOSING_DESTINATION_UPDATED"],
      );
      const result = await c.query(
        "UPDATE distribution.studio_package SET revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND is_test=true AND revision=$3",
        [saved.id, saved.revision, before.revision],
      );
      if (result.rowCount !== 1) throw Error("REVISION_CONFLICT");
      await c.query(
        "INSERT INTO distribution.studio_feedback(package_id,is_test,revision,actor_id,action,comment) VALUES($1,true,$2,$3,'REVISED',$4)",
        [
          saved.id,
          saved.revision,
          actor.id,
          `Subscription destination updated to ${target.url}. Video, audio, subtitles, file versions and AI screening evidence are unchanged; human approval is still required.`,
        ],
      );
    }
    const curation = {
      ...root.curation,
      request: { ...root.curation.request, youtubeClosing: target },
    };
    await c.query(
      "UPDATE distribution.online_import SET curation=$2,updated_at=clock_timestamp() WHERE id=$1 AND is_test=true",
      [bundle, curation],
    );
    await c.query("COMMIT");
  } else await c.query("ROLLBACK");
  console.info(
    JSON.stringify({
      applied: apply,
      packages: rows.length,
      changed: changed.length,
      outputs: outputs.length,
      target,
      videoFilesRebuilt: 0,
      revisedDrafts: changed.filter((x) => x.next.status === "DRAFT").length,
    }),
  );
} catch (error) {
  await c.query("ROLLBACK");
  throw error;
} finally {
  c.release();
  await pool.end();
}

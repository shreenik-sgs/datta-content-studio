import { createHash } from "node:crypto";
import {
  type CleanupFile,
  type CleanupPreview,
  type CleanupSelection,
  cleanupAllowed,
  cleanupFiles,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient } from "pg";
import {
  type DistributionContext,
  distributionCapabilities,
  distributionWorld,
  requireDistributionCapability,
} from "./repository";
import type { StudioRoleAuthority } from "./studio-authority";

export function createStorageCleanupRepository(pool: Pool, authorize: StudioRoleAuthority) {
  async function tx<T>(run: (client: PoolClient) => Promise<T>, locked = false) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (locked) {
        await client.query("SET LOCAL lock_timeout='3s'");
        await client.query("SELECT distribution.lock_storage_cleanup()");
      }
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function permitted(client: PoolClient, ctx: DistributionContext) {
    distributionWorld(ctx);
    await requireDistributionCapability(client, ctx, ["content.create", "content.review"]);
    const caps = await distributionCapabilities(client, ctx);
    const reviewer =
      caps.includes("content.review") &&
      (await authorize({ userId: ctx.userId, isTest: ctx.isTest, capability: "content.review" }));
    if (
      !reviewer &&
      !(
        caps.includes("content.create") &&
        (await authorize({ userId: ctx.userId, isTest: ctx.isTest, capability: "content.create" }))
      )
    )
      throw Error("FORBIDDEN");
    return reviewer;
  }
  async function plan(client: PoolClient, ctx: DistributionContext, selection: CleanupSelection) {
    const reviewer = await permitted(client, ctx);
    let masterIds: string[] = [];
    let packageIds: string[] = [];
    let importIds: string[] = [];
    let title = "";
    let owner = "";
    const blockers: string[] = [];
    const approverRequired =
      "A Content Approver must delete another curator’s content or content already submitted for review, approved or published.";
    if (selection.kind === "playlist") {
      const root = (
        await client.query(
          "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL AND source->>'kind' IN ('playlist','bundle')",
          [selection.id, ctx.isTest],
        )
      ).rows[0];
      if (!root) throw Error("NOT_FOUND");
      title = root.title ?? "Playlist";
      owner = root.requested_by;
      importIds = [root.id, ...(root.child_ids ?? [])];
      const children = (
        await client.query(
          "SELECT master_id FROM distribution.online_import WHERE is_test=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL",
          [ctx.isTest, importIds],
        )
      ).rows;
      masterIds = [
        ...new Set(children.flatMap((r) => (r.master_id ? [r.master_id as string] : []))),
      ];
      const shared = await client.query(
        "SELECT 1 FROM distribution.online_import WHERE is_test=$1 AND deleted_at IS NULL AND id<>$2 AND source->>'kind' IN ('playlist','bundle') AND child_ids ?| $3::text[] LIMIT 1",
        [ctx.isTest, root.id, root.child_ids ?? []],
      );
      if (shared.rowCount)
        blockers.push(
          "Some recordings also belong to another playlist. Remove those separately after checking the other playlist.",
        );
    } else if (selection.kind === "master") {
      const master = (
        await client.query(
          "SELECT * FROM distribution.content_master WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
          [selection.id, ctx.isTest],
        )
      ).rows[0];
      if (!master) throw Error("NOT_FOUND");
      title = master.title;
      owner = master.created_by;
      masterIds = [master.id];
      importIds = (
        await client.query(
          "SELECT id FROM distribution.online_import WHERE master_id=$1 AND is_test=$2 AND deleted_at IS NULL",
          [master.id, ctx.isTest],
        )
      ).rows.map((r) => r.id);
      if (selection.mode === "all") {
        const parent = await client.query(
          "SELECT 1 FROM distribution.online_import WHERE is_test=$1 AND deleted_at IS NULL AND child_ids ?| $2::text[] LIMIT 1",
          [ctx.isTest, importIds],
        );
        if (parent.rowCount)
          blockers.push(
            "This recording belongs to a playlist. Select the playlist to remove its masters together, or delete only this recording’s generated packages.",
          );
      }
    } else {
      const row = (
        await client.query(
          "SELECT p.*,r.snapshot FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision WHERE p.id=$1 AND p.is_test=$2 AND p.deleted_at IS NULL",
          [selection.id, ctx.isTest],
        )
      ).rows[0];
      if (!row) throw Error("NOT_FOUND");
      packageIds = [row.id];
      title = row.snapshot.source.title;
      owner = row.created_by;
    }
    if (selection.kind === "playlist" && masterIds.length) {
      const external = await client.query(
        "SELECT 1 FROM distribution.online_import WHERE is_test=$1 AND deleted_at IS NULL AND master_id=ANY($2::uuid[]) AND NOT(id=ANY($3::uuid[])) LIMIT 1",
        [ctx.isTest, masterIds, importIds],
      );
      if (external.rowCount)
        blockers.push(
          "A master is also used by a source outside this playlist. Manage that master separately to review all affected content.",
        );
    }
    if (masterIds.length)
      packageIds = (
        await client.query(
          "SELECT id FROM distribution.studio_package WHERE is_test=$1 AND master_id=ANY($2::uuid[]) AND deleted_at IS NULL",
          [ctx.isTest, masterIds],
        )
      ).rows.map((r) => r.id);
    const packages = (
      await client.query(
        "SELECT p.*,r.snapshot FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision WHERE p.is_test=$1 AND p.id=ANY($2::uuid[])",
        [ctx.isTest, packageIds],
      )
    ).rows;
    if (
      !cleanupAllowed({
        reviewer,
        userId: ctx.userId,
        owner,
        statuses: packages.map((p) => p.snapshot.status),
      }) ||
      (!reviewer && packages.some((p) => p.created_by !== ctx.userId))
    )
      blockers.push(approverRequired);
    const active = await client.query(
      `SELECT 1 FROM distribution.studio_generation_job WHERE is_test=$1 AND package_id=ANY($2::uuid[]) AND status='RUNNING'
      UNION ALL SELECT 1 FROM distribution.studio_publication_job WHERE is_test=$1 AND package_id=ANY($2::uuid[]) AND status IN ('QUEUED','RUNNING','PROCESSING','UNCERTAIN')
      UNION ALL SELECT 1 FROM distribution.online_import WHERE is_test=$1 AND id=ANY($3::uuid[]) AND status='DOWNLOADING'
      UNION ALL SELECT 1 FROM distribution.render_job WHERE is_test=$1 AND master_id=ANY($4::uuid[]) AND status IN ('QUEUED','RUNNING')
      UNION ALL SELECT 1 FROM distribution.live_window w JOIN distribution.live_broadcast b ON b.id=w.broadcast_id AND b.is_test=w.is_test WHERE w.is_test=$1 AND (w.master_id=ANY($4::uuid[]) OR w.package_id=ANY($2::uuid[])) AND b.status='CAPTURING' LIMIT 1`,
      [ctx.isTest, packageIds, importIds, masterIds],
    );
    if (active.rowCount)
      blockers.push(
        "Download, generation, publishing or live capture is active. Let it finish before deleting these files.",
      );
    const removeMasters = selection.mode === "all" && selection.kind !== "package" ? masterIds : [];
    if (!reviewer && removeMasters.length) {
      const protectedMasters = await client.query(
        "SELECT 1 FROM distribution.content_master WHERE is_test=$1 AND id=ANY($2::uuid[]) AND (created_by<>$3 OR state IN ('APPROVED','PUBLISHED')) LIMIT 1",
        [ctx.isTest, removeMasters, ctx.userId],
      );
      if (protectedMasters.rowCount && !blockers.includes(approverRequired))
        blockers.push(approverRequired);
    }
    const linked = await client.query(
      "SELECT 1 FROM distribution.activation WHERE is_test=$1 AND master_id=ANY($2::uuid[]) LIMIT 1",
      [ctx.isTest, removeMasters],
    );
    if (linked.rowCount)
      blockers.push(
        "A campaign or published invitation still uses this master. Keep the master and remove only unused generated packages.",
      );
    const versions = (
      await client.query(
        'SELECT storage_key AS "storageKey",sha256,byte_size::float8 AS "byteSize",mime_type AS "mimeType",original_name AS "originalName" FROM distribution.content_version WHERE is_test=$1 AND master_id=ANY($2::uuid[])',
        [ctx.isTest, removeMasters],
      )
    ).rows;
    const snapshots = (
      await client.query(
        "SELECT snapshot FROM distribution.studio_revision WHERE is_test=$1 AND package_id=ANY($2::uuid[])",
        [ctx.isTest, packageIds],
      )
    ).rows;
    const renders = (
      await client.query(
        "SELECT a.output FROM distribution.render_artifact a JOIN distribution.render_job j ON j.id=a.job_id AND j.is_test=a.is_test WHERE j.is_test=$1 AND j.master_id=ANY($2::uuid[])",
        [ctx.isTest, removeMasters],
      )
    ).rows;
    // A studio snapshot also names its source: only output/checkpoint descriptors may be erased here.
    const masterKeys = new Set(versions.map((v) => v.storageKey));
    const candidates = cleanupFiles([
      versions,
      snapshots.map((r) => r.snapshot.outputs),
      packages.map((p) => p.generation_checkpoint),
      renders,
    ]).filter(
      (f) => !f.storageKey.startsWith("distribution/masters/") || masterKeys.has(f.storageKey),
    );
    const protectedKeys = new Set<string>();
    // Check both worlds, all revisions and render exports; shared physical media is kept.
    const other = await client.query(
      "SELECT r.snapshot->'outputs' AS value FROM distribution.studio_revision r JOIN distribution.studio_package p ON p.id=r.package_id AND p.is_test=r.is_test WHERE p.deleted_at IS NULL AND NOT(p.is_test=$1 AND p.id=ANY($2::uuid[])) UNION ALL SELECT generation_checkpoint FROM distribution.studio_package WHERE deleted_at IS NULL AND NOT(is_test=$1 AND id=ANY($2::uuid[])) UNION ALL SELECT a.output FROM distribution.render_artifact a JOIN distribution.render_job j ON j.id=a.job_id AND j.is_test=a.is_test JOIN distribution.content_master m ON m.id=j.master_id AND m.is_test=j.is_test WHERE m.deleted_at IS NULL AND NOT(m.is_test=$1 AND m.id=ANY($3::uuid[]))",
      [ctx.isTest, packageIds, removeMasters],
    );
    for (const file of cleanupFiles(other.rows)) protectedKeys.add(file.storageKey);
    const files = candidates.filter((f) => !protectedKeys.has(f.storageKey));
    const revision = {
      selection,
      masterIds,
      packageIds,
      importIds,
      versions,
      packages: packages.map((p) => [p.id, p.revision]),
      files,
      blockers,
    };
    const preview: CleanupPreview = {
      selection,
      title,
      token: createHash("sha256").update(JSON.stringify(revision)).digest("hex"),
      masterCount: removeMasters.length,
      packageCount: packageIds.length,
      fileCount: files.length,
      bytes: files.reduce((n, f) => n + f.byteSize, 0),
      sharedFileCount: candidates.length - files.length,
      blockers,
    };
    return {
      preview,
      files,
      masterIds: removeMasters,
      packageIds,
      importIds: selection.mode === "all" ? importIds : [],
    };
  }
  return {
    preview: (ctx: DistributionContext, selection: CleanupSelection) =>
      tx(async (c) => (await plan(c, ctx, selection)).preview),
    request: (ctx: DistributionContext, selection: CleanupSelection, token: string) =>
      tx(async (c) => {
        const p = await plan(c, ctx, selection);
        if (p.preview.blockers.length) throw Error("CLEANUP_BLOCKED");
        if (token !== p.preview.token) throw Error("CLEANUP_CHANGED");
        await c.query(
          "UPDATE distribution.studio_generation_job SET status='STALE',lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE is_test=$1 AND package_id=ANY($2::uuid[]) AND status='QUEUED'",
          [ctx.isTest, p.packageIds],
        );
        await c.query(
          "UPDATE distribution.studio_package SET deleted_at=now(),updated_at=now() WHERE is_test=$1 AND id=ANY($2::uuid[])",
          [ctx.isTest, p.packageIds],
        );
        await c.query(
          "UPDATE distribution.content_master SET deleted_at=now(),state='WITHDRAWN',revision=revision+1,updated_at=now() WHERE is_test=$1 AND id=ANY($2::uuid[])",
          [ctx.isTest, p.masterIds],
        );
        await c.query(
          "UPDATE distribution.online_import SET deleted_at=now(),status='FAILED',error='SOURCE_REMOVED',curation=NULL,updated_at=now() WHERE is_test=$1 AND id=ANY($2::uuid[])",
          [ctx.isTest, p.importIds],
        );
        // Keep the playlist setup, but mark erased packages as deliberately discarded so workers
        // never regenerate them automatically. Explicit future curation may start a fresh batch.
        await c.query(
          `UPDATE distribution.online_import i SET curation=jsonb_set(curation,'{items}',COALESCE((SELECT jsonb_object_agg(key, CASE WHEN value->>'packageId'=ANY($2::text[]) THEN jsonb_build_object('error','CONTENT_REMOVED','status','DISCARDED') ELSE value END) FROM jsonb_each(curation->'items')),'{}'::jsonb)),updated_at=now() WHERE is_test=$1 AND deleted_at IS NULL AND curation IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_each(curation->'items') WHERE value->>'packageId'=ANY($2::text[]))`,
          [ctx.isTest, p.packageIds],
        );
        if (selection.kind === "playlist" && selection.mode === "generated") {
          await c.query(
            "UPDATE distribution.online_import SET curation=jsonb_set(curation,'{pausedForCleanup}','true'::jsonb),updated_at=now() WHERE id=$1 AND is_test=$2 AND curation IS NOT NULL",
            [selection.id, ctx.isTest],
          );
        }
        const row = (
          await c.query(
            "INSERT INTO distribution.storage_cleanup(is_test,requested_by,title,selection,files) VALUES($1,$2,$3,$4,$5) RETURNING id",
            [ctx.isTest, ctx.userId, p.preview.title, selection, JSON.stringify(p.files)],
          )
        ).rows[0];
        return { id: row.id as string, ...p.preview };
      }, true),
    list: (ctx: DistributionContext) =>
      tx(async (c) => {
        await permitted(c, ctx);
        return (
          await c.query(
            "SELECT id,title,status,error,jsonb_array_length(files) AS total,jsonb_array_length(removed) AS removed,created_at FROM distribution.storage_cleanup WHERE is_test=$1 ORDER BY created_at DESC LIMIT 20",
            [ctx.isTest],
          )
        ).rows;
      }),
    /** Session advisory lock prevents two workers deleting the same immutable asset. */
    processOne: async (isTest: boolean, remove: (file: CleanupFile) => Promise<void>) => {
      const c = await pool.connect();
      let locked = false;
      try {
        locked = (
          await c.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [
            `storage-cleanup:${isTest}`,
          ])
        ).rows[0].locked;
        if (!locked) return false;
        const row = (
          await c.query(
            "SELECT * FROM distribution.storage_cleanup WHERE is_test=$1 AND (status='QUEUED' OR (status='RETRY' AND updated_at<now()-interval '30 seconds')) ORDER BY created_at LIMIT 1",
            [isTest],
          )
        ).rows[0];
        if (!row) return false;
        const removed = row.removed as string[];
        const file = (row.files as CleanupFile[]).find((f) => !removed.includes(f.storageKey));
        if (file) {
          try {
            await remove(file);
          } catch {
            await c.query(
              "UPDATE distribution.storage_cleanup SET status='RETRY',error='Storage deletion failed. Automatic retry is scheduled.',updated_at=now() WHERE id=$1",
              [row.id],
            );
            return true;
          }
          removed.push(file.storageKey);
        }
        await c.query(
          "UPDATE distribution.storage_cleanup SET removed=$2,status=$3,error=NULL,updated_at=now() WHERE id=$1",
          [
            row.id,
            JSON.stringify(removed),
            removed.length === row.files.length ? "COMPLETE" : "QUEUED",
          ],
        );
        return true;
      } finally {
        if (locked)
          await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            `storage-cleanup:${isTest}`,
          ]);
        c.release();
      }
    },
  };
}

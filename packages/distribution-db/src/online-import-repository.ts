import { createHash, randomUUID } from "node:crypto";
import {
  CONTENT_CATEGORIES,
  ONLINE_IMPORT_ERRORS,
  ONLINE_IMPORT_PLAYLIST_LIMIT,
  type OnlineImport,
  type OnlineVideoSource,
  isOnlineBundle,
  onlineVideoBundle,
  onlineVideoSource,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  type CreateMasterInput,
  type DistributionContext,
  distributionWorld,
  insertContentMaster,
  requireDistributionCapability,
} from "./repository.js";
import type { StudioRoleAuthority } from "./studio-authority.js";

export type OnlineImportClaim = OnlineImport & {
  isTest: boolean;
  requestedBy: string;
  language: string;
  category: string;
  leaseToken: string;
};
function dto(row: QueryResultRow): OnlineImport {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    status: row.status,
    masterId: row.master_id,
    parentId: row.parent_id,
    childIds: row.child_ids,
    curation: row.curation,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
const confirmedImportRollbacks = new WeakSet<Error>();
export function onlineImportTransactionRolledBack(error: unknown) {
  return error instanceof Error && confirmedImportRollbacks.has(error);
}
export function createOnlineImportRepository(
  pool: Pool,
  authorize: StudioRoleAuthority,
  options: { prefetch?: number } = {},
) {
  const prefetch = options.prefetch ?? 3;
  if (!Number.isInteger(prefetch) || prefetch < 1 || prefetch > 10)
    throw Error("INVALID_IMPORT_PREFETCH");
  async function transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    let committing = false;
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      committing = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
        if (!committing && error instanceof Error) confirmedImportRollbacks.add(error);
      } catch {
        /* An uncertain write never authorizes media deletion. */
      }
      throw error;
    } finally {
      client.release();
    }
  }
  async function allowed(userId: string, isTest: boolean) {
    if (!(await authorize({ userId, isTest, capability: "content.create" })))
      throw Error("ONLINE_IMPORT_FORBIDDEN");
  }
  async function checked(client: PoolClient, claim: OnlineImportClaim) {
    const result = await client.query(
      "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL AND lease_token=$3 AND status='DOWNLOADING' AND lease_until>clock_timestamp() FOR UPDATE",
      [claim.id, claim.isTest, claim.leaseToken],
    );
    if (!result.rows[0]) throw Error("ONLINE_IMPORT_LEASE_LOST");
    await allowed(result.rows[0].requested_by, claim.isTest);
    return result.rows[0];
  }
  async function insert(
    client: PoolClient,
    input: {
      source: OnlineVideoSource;
      isTest: boolean;
      requestedBy: string;
      language: string;
      category: string;
      parentId?: string;
    },
  ) {
    const result = await client.query(
      `INSERT INTO distribution.online_import(is_test,source,source_key,requested_by,language,category,parent_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_key,is_test) WHERE deleted_at IS NULL DO UPDATE SET source_key=excluded.source_key RETURNING *`,
      [
        input.isTest,
        input.source,
        `${input.source.provider}:${input.source.kind}:${input.source.id}`,
        input.requestedBy,
        input.language,
        input.category,
        input.parentId ?? null,
      ],
    );
    return dto(result.rows[0]);
  }
  async function recoveryTarget(
    client: Pool | PoolClient,
    context: DistributionContext,
    id: string,
  ) {
    const isTest = distributionWorld(context);
    await requireDistributionCapability(client, context, ["content.create"]);
    await allowed(context.userId, isTest);
    const rows = await client.query(
      "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
      [id, isTest],
    );
    const root = rows.rows[0];
    if (!root) throw Error("NOT_FOUND");
    if (!isOnlineBundle(root.source) || !root.child_ids?.length)
      return { root: dto(root), target: dto(root) };
    const children = await client.query(
      "SELECT * FROM distribution.online_import WHERE is_test=$1 AND id=ANY($2::uuid[]) AND master_id IS NULL ORDER BY array_position($2::uuid[],id) LIMIT 1",
      [isTest, root.child_ids],
    );
    return { root: dto(root), target: children.rows[0] ? dto(children.rows[0]) : null };
  }
  async function saveMaster(
    client: PoolClient,
    row: QueryResultRow,
    isTest: boolean,
    userId: string,
    input: Pick<CreateMasterInput, "asset" | "title">,
  ) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `master-upload:${isTest}:${input.asset.sha256}`,
    ]);
    const prior = await client.query(
      "SELECT v.master_id,v.number,m.current_version_number FROM distribution.content_version v JOIN distribution.content_master m ON m.id=v.master_id AND m.is_test=v.is_test WHERE v.is_test=$1 AND m.deleted_at IS NULL AND v.sha256=$2 LIMIT 1",
      [isTest, input.asset.sha256],
    );
    if (prior.rows[0] && prior.rows[0].number !== prior.rows[0].current_version_number)
      throw Error("ONLINE_SOURCE_PREVIOUS_VERSION");
    const existing = prior.rows[0]?.master_id as string | undefined;
    const masterId =
      existing ??
      (await insertContentMaster(
        client,
        { userId, isTest },
        { ...input, language: row.language, category: row.category },
      ));
    await client.query(
      "UPDATE distribution.online_import SET status='COMPLETE',master_id=$3,title=$4,lease_token=NULL,lease_until=NULL,error=NULL,updated_at=now() WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
      [row.id, isTest, masterId, input.title],
    );
    return { masterId, duplicate: Boolean(existing) };
  }
  return {
    enqueueBundle: (
      context: DistributionContext,
      input: { urls: string; title: string; language: string; category: string },
    ) =>
      transaction(async (client) => {
        const isTest = distributionWorld(context);
        await requireDistributionCapability(client, context, ["content.create"]);
        await allowed(context.userId, isTest);
        const sources = onlineVideoBundle(input.urls);
        const first = sources[0];
        if (!first) throw Error("ONLINE_BUNDLE_SIZE_INVALID");
        const title = input.title.trim();
        if (!title || title.length > 200) throw Error("ONLINE_BUNDLE_TITLE_REQUIRED");
        if (
          !["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"].includes(input.language) ||
          !CONTENT_CATEGORIES.includes(input.category as never)
        )
          throw Error("INVALID_CONTENT");
        // Ordering is part of the collection. Retries with the same canonical links reuse it.
        const id = createHash("sha256")
          .update(JSON.stringify(sources.map((s) => s.url)))
          .digest("hex");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `online-bundle:${isTest}:${id}`,
        ]);
        const source: OnlineVideoSource = { ...first, kind: "bundle", id };
        const existing = await client.query(
          "SELECT * FROM distribution.online_import WHERE is_test=$1 AND deleted_at IS NULL AND source_key=$2",
          [isTest, `${source.provider}:bundle:${id}`],
        );
        if (existing.rows[0]) return dto(existing.rows[0]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `online-import:${isTest}:${context.userId}`,
        ]);
        const active = await client.query(
          "SELECT count(*)::int AS count FROM distribution.online_import WHERE is_test=$1 AND requested_by=$2 AND status IN ('QUEUED','DOWNLOADING')",
          [isTest, context.userId],
        );
        const prior = await client.query(
          "SELECT source_key FROM distribution.online_import WHERE is_test=$1 AND deleted_at IS NULL AND source_key=ANY($2::text[])",
          [isTest, sources.map((s) => `${s.provider}:video:${s.id}`)],
        );
        if (active.rows[0].count + sources.length - (prior.rowCount ?? 0) > 100)
          throw Error("ONLINE_IMPORT_BUSY");
        const root = await insert(client, {
          source,
          isTest,
          requestedBy: context.userId,
          language: input.language,
          category: input.category,
        });
        const children: string[] = [];
        // Stable lock order avoids deadlocks for overlapping concurrent collections.
        const members = new Map<string, string>();
        for (const child of [...sources].sort((a, b) => a.url.localeCompare(b.url))) {
          const member = await insert(client, {
            source: child,
            isTest,
            requestedBy: context.userId,
            language: input.language,
            category: input.category,
            parentId: root.id,
          });
          members.set(child.url, member.id);
        }
        for (const child of sources) children.push(members.get(child.url) as string);
        const saved = await client.query(
          "UPDATE distribution.online_import SET status='COMPLETE',title=$3,child_ids=$4,updated_at=now() WHERE id=$1 AND is_test=$2 RETURNING *",
          [root.id, isTest, title, JSON.stringify(children)],
        );
        return dto(saved.rows[0]);
      }),
    recoveryTarget: (context: DistributionContext, id: string) => recoveryTarget(pool, context, id),
    claimVerification: (context: DistributionContext, id: string) =>
      transaction(async (client): Promise<OnlineImportClaim> => {
        const isTest = distributionWorld(context);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `online-import-claim:${isTest}`,
        ]);
        const { target } = await recoveryTarget(client, context, id);
        if (!target || target.masterId) throw Error("VERIFICATION_NOT_NEEDED");
        const active = await client.query(
          "SELECT 1 FROM distribution.online_import WHERE is_test=$1 AND source->>'provider'=$2 AND status='DOWNLOADING' AND lease_until>clock_timestamp()",
          [isTest, target.source.provider],
        );
        if (active.rowCount) throw Error("VERIFICATION_BUSY");
        const leaseToken = randomUUID();
        const result = await client.query(
          "UPDATE distribution.online_import SET status='DOWNLOADING',requested_by=$3,lease_token=$4,lease_until=clock_timestamp()+interval '2 minutes',updated_at=now() WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL AND master_id IS NULL RETURNING *",
          [target.id, isTest, context.userId, leaseToken],
        );
        const row = result.rows[0];
        if (!row) throw Error("VERIFICATION_NOT_NEEDED");
        return {
          ...dto(row),
          isTest,
          requestedBy: context.userId,
          language: row.language,
          category: row.category,
          leaseToken,
        };
      }),
    attachOriginal: (
      context: DistributionContext,
      rootId: string,
      id: string,
      input: Pick<CreateMasterInput, "asset" | "title">,
    ) =>
      transaction(async (client) => {
        const isTest = distributionWorld(context);
        await requireDistributionCapability(client, context, ["content.create"]);
        await allowed(context.userId, isTest);
        const root = (
          await client.query(
            "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL FOR UPDATE",
            [rootId, isTest],
          )
        ).rows[0];
        if (!root || (rootId !== id && !root.child_ids?.includes(id)))
          throw Error("ORIGINAL_NOT_IN_PLAYLIST");
        const row = (
          await client.query(
            "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL FOR UPDATE",
            [id, isTest],
          )
        ).rows[0];
        if (!row || row.source.kind !== "video") throw Error("ORIGINAL_NOT_IN_PLAYLIST");
        if (row.master_id) {
          const prior = await client.query(
            "SELECT v.sha256 FROM distribution.content_master m JOIN distribution.content_version v ON v.master_id=m.id AND v.is_test=m.is_test AND v.number=m.current_version_number WHERE m.id=$1 AND m.is_test=$2",
            [row.master_id, isTest],
          );
          if (prior.rows[0]?.sha256 !== input.asset.sha256)
            throw Error("ORIGINAL_ALREADY_ATTACHED");
          return { masterId: row.master_id as string, duplicate: true };
        }
        const result = await saveMaster(client, row, isTest, context.userId, {
          ...input,
          title: row.title || input.title,
        });
        // A successful upload supersedes the download lease, never a generated/approved package.
        if (root.curation?.items[id]?.error && !root.curation.items[id]?.packageId) {
          delete root.curation.items[id];
          await client.query(
            "UPDATE distribution.online_import SET curation=$3,updated_at=now() WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
            [rootId, isTest, root.curation],
          );
        }
        return result;
      }),
    ready: async (isTest: boolean) =>
      Boolean(
        (
          await pool.query(
            "SELECT 1 FROM distribution.module_state WHERE id=$1 AND updated_at>clock_timestamp()-interval '90 seconds'",
            [`online-import-worker:${isTest}`],
          )
        ).rowCount,
      ),
    heartbeat: async (isTest: boolean) => {
      await pool.query(
        "INSERT INTO distribution.module_state(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET updated_at=clock_timestamp()",
        [`online-import-worker:${isTest}`],
      );
    },
    enqueue: (
      context: DistributionContext,
      input: { url: string; includePlaylist?: boolean; language: string; category: string },
    ) =>
      transaction(async (client) => {
        const isTest = distributionWorld(context);
        await requireDistributionCapability(client, context, ["content.create"]);
        const source = onlineVideoSource(input.url, input.includePlaylist);
        if (
          !["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"].includes(input.language) ||
          !CONTENT_CATEGORIES.includes(input.category as never)
        )
          throw Error("INVALID_CONTENT");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `online-import:${isTest}:${context.userId}`,
        ]);
        const existing = await client.query(
          "SELECT * FROM distribution.online_import WHERE is_test=$1 AND deleted_at IS NULL AND source_key=$2",
          [isTest, `${source.provider}:${source.kind}:${source.id}`],
        );
        if (existing.rows[0]) return dto(existing.rows[0]);
        const active = await client.query(
          "SELECT count(*)::int AS count FROM distribution.online_import WHERE is_test=$1 AND requested_by=$2 AND status IN ('QUEUED','DOWNLOADING')",
          [isTest, context.userId],
        );
        if (active.rows[0].count >= 100) throw Error("ONLINE_IMPORT_BUSY");
        return insert(client, {
          source,
          isTest,
          requestedBy: context.userId,
          language: input.language,
          category: input.category,
        });
      }),
    list: async (
      context: DistributionContext,
      options: { summaries?: boolean; rootId?: string | undefined; offset?: number } = {},
    ) => {
      await requireDistributionCapability(pool, context, ["content.create", "content.review"]);
      const items = (
        await pool.query(
          `WITH roots AS (SELECT * FROM distribution.online_import WHERE is_test=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL AND parent_id IS NULL OR id=$2) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4)
         SELECT * FROM roots UNION SELECT i.* FROM distribution.online_import i WHERE NOT $5::boolean AND i.is_test=$1 AND i.deleted_at IS NULL AND i.id IN (SELECT jsonb_array_elements_text(child_ids)::uuid FROM roots)`,
          [
            distributionWorld(context),
            options.rootId ?? null,
            options.summaries ? 20 : options.rootId ? 1 : 50,
            options.rootId ? 0 : Math.max(0, options.offset ?? 0),
            options.summaries ?? false,
          ],
        )
      ).rows.map(dto);
      const ids = items.flatMap((item) =>
        Object.values(item.curation?.items ?? {}).flatMap((value) =>
          value.packageId ? [value.packageId] : [],
        ),
      );
      if (ids.length) {
        const packages = await pool.query(
          `SELECT p.id, r.snapshot->>'status' AS status, r.snapshot->>'failure' AS failure, jsonb_array_length(COALESCE(r.snapshot->'outputs','[]'::jsonb)) AS output_count, EXISTS(SELECT 1 FROM distribution.studio_generation_job j WHERE j.package_id=p.id AND j.is_test=p.is_test AND j.status='RUNNING') AS running FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision WHERE p.is_test=$1 AND p.id=ANY($2::uuid[])`,
          [context.isTest, ids],
        );
        const statuses = new Map(
          packages.rows.map((row) => [row.id, row.running ? "GENERATING" : row.status]),
        );
        for (const item of items)
          for (const value of Object.values(item.curation?.items ?? {}))
            if (value.packageId) {
              value.status = statuses.get(value.packageId);
              const snapshot = packages.rows.find((row) => row.id === value.packageId);
              value.outputCount = snapshot?.output_count ?? 0;
              const failure = snapshot?.failure;
              if (
                value.status === "FAILED" &&
                typeof failure === "string" &&
                /^[A-Z_]{1,100}$/.test(failure)
              )
                value.error = failure;
            }
      }
      const services = await pool.query(
        "SELECT * FROM distribution.online_import_service WHERE is_test=$1",
        [context.isTest],
      );
      for (const item of items) {
        const service = services.rows.find((row) => row.provider === item.source.provider);
        if (
          service &&
          (item.status !== "COMPLETE" ||
            item.childIds?.some((id) =>
              items.some((child) => child.id === id && child.status !== "COMPLETE"),
            ))
        )
          item.serviceIssue = {
            provider: service.provider,
            code: service.error,
            attempts: service.attempts,
            retryAt: service.retry_at ? new Date(service.retry_at).toISOString() : null,
          };
      }
      return items;
    },
    bundlesForMaster: async (context: DistributionContext, masterId: string) => {
      await requireDistributionCapability(pool, context, ["content.create", "content.review"]);
      const rows = await pool.query(
        `SELECT DISTINCT p.id, p.title, jsonb_array_length(p.child_ids) AS recordings
         FROM distribution.online_import i
         JOIN distribution.content_master m ON m.id=i.master_id AND m.is_test=i.is_test
         JOIN distribution.online_import p ON p.is_test=i.is_test AND p.child_ids ? i.id::text
         WHERE i.is_test=$1 AND i.master_id=$2 AND i.deleted_at IS NULL
           AND m.deleted_at IS NULL AND p.deleted_at IS NULL
         ORDER BY p.title,p.id`,
        [distributionWorld(context), masterId],
      );
      return rows.rows.map((row) => ({
        id: row.id as string,
        title: (row.title as string | null) ?? "Playlist or series",
        recordings: row.recordings as number,
      }));
    },
    groupedMasters: async (context: DistributionContext) => {
      await requireDistributionCapability(pool, context, ["content.create", "content.review"]);
      return (
        await pool.query(
          "SELECT DISTINCT i.master_id FROM distribution.online_import i WHERE i.is_test=$1 AND i.deleted_at IS NULL AND i.master_id IS NOT NULL AND EXISTS(SELECT 1 FROM distribution.online_import p WHERE p.is_test=i.is_test AND p.deleted_at IS NULL AND p.child_ids ? i.id::text)",
          [distributionWorld(context)],
        )
      ).rows.map((r) => r.master_id as string);
    },
    retryPlaylist: (context: DistributionContext, id: string) =>
      transaction(async (client) => {
        await requireDistributionCapability(client, context, ["content.create"]);
        const isTest = distributionWorld(context);
        await allowed(context.userId, isTest);
        const result = await client.query(
          "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL FOR UPDATE",
          [id, isTest],
        );
        const row = result.rows[0];
        if (!row || !isOnlineBundle(row.source)) throw Error("NOT_FOUND");
        // One explicit recovery action for the bundle, never touching completed downloads or packages.
        await client.query(
          "DELETE FROM distribution.online_import_service WHERE is_test=$1 AND provider=$2",
          [isTest, row.source.provider],
        );
        await client.query(
          "UPDATE distribution.online_import SET status='QUEUED',error=NULL,attempts=0,lease_token=NULL,lease_until=NULL,requested_by=$3,updated_at=now() WHERE is_test=$1 AND (id=$2 OR id::text IN (SELECT jsonb_array_elements_text($4::jsonb))) AND (status='FAILED' OR (status='QUEUED' AND error IN ('ONLINE_PROVIDER_VERIFICATION_REQUIRED','ONLINE_PROVIDER_RATE_LIMITED')))",
          [isTest, id, context.userId, JSON.stringify(row.child_ids ?? [])],
        );
        if (row.curation) {
          Reflect.deleteProperty(row.curation, "pausedForCleanup");
          for (const [childId, member] of Object.entries(row.curation.items) as [
            string,
            { error?: string; packageId?: string },
          ][])
            if (member.error && !member.packageId) delete row.curation.items[childId];
          await client.query(
            "UPDATE distribution.online_import SET curation=$3,updated_at=now() WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
            [id, isTest, row.curation],
          );
        }
        return dto(row);
      }),
    retry: (context: DistributionContext, id: string) =>
      transaction(async (client) => {
        await requireDistributionCapability(client, context, ["content.create"]);
        const isTest = distributionWorld(context);
        await allowed(context.userId, isTest);
        const row = await client.query(
          "UPDATE distribution.online_import i SET status='QUEUED',error=NULL,attempts=0,lease_until=NULL,lease_token=NULL,requested_by=$3,updated_at=now() WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL AND (status='FAILED' OR (status='QUEUED' AND EXISTS(SELECT 1 FROM distribution.online_import_service s WHERE s.is_test=i.is_test AND s.provider=i.source->>'provider'))) RETURNING *",
          [id, isTest, context.userId],
        );
        if (!row.rows[0]) throw Error("NOT_FOUND");
        await client.query(
          "DELETE FROM distribution.online_import_service WHERE is_test=$1 AND provider=$2",
          [isTest, row.rows[0].source.provider],
        );
        return dto(row.rows[0]);
      }),
    claim: (isTest: boolean) =>
      transaction(async (client: PoolClient): Promise<OnlineImportClaim | null> => {
        // A provider gets one active request even while ECS replaces a worker.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `online-import-claim:${isTest}`,
        ]);
        for (let i = 0; i < 20; i++) {
          const result = await client.query(
            `SELECT i.* FROM distribution.online_import i WHERE i.is_test=$1 AND i.deleted_at IS NULL AND ((i.status='QUEUED' AND (i.lease_until IS NULL OR i.lease_until<=clock_timestamp())) OR (i.status='DOWNLOADING' AND i.lease_until<=clock_timestamp()))
              AND (i.parent_id IS NULL OR NOT EXISTS(SELECT 1 FROM distribution.online_import parent WHERE parent.id=i.parent_id AND parent.is_test=i.is_test AND (parent.deleted_at IS NOT NULL OR parent.curation->>'pausedForCleanup'='true')))
              AND (i.parent_id IS NULL OR (SELECT count(*) FROM distribution.online_import sibling JOIN distribution.online_import parent ON parent.id=i.parent_id AND parent.is_test=i.is_test WHERE sibling.is_test=i.is_test AND sibling.parent_id=i.parent_id AND sibling.deleted_at IS NULL AND sibling.master_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision WHERE p.master_id=sibling.master_id AND p.is_test=i.is_test AND p.deleted_at IS NULL AND r.snapshot->>'status' IN ('DRAFT','CHANGES_REQUESTED','IN_REVIEW','APPROVED','DISCARDED','FAILED'))) < CASE WHEN (SELECT curation IS NOT NULL FROM distribution.online_import WHERE id=i.parent_id) THEN $2::int ELSE 1 END)
              AND NOT EXISTS (SELECT 1 FROM distribution.online_import_service s WHERE s.is_test=i.is_test AND s.provider=i.source->>'provider' AND (s.retry_at IS NULL OR s.retry_at>clock_timestamp()))
              AND NOT EXISTS (SELECT 1 FROM distribution.online_import active WHERE active.is_test=i.is_test AND active.source->>'provider'=i.source->>'provider' AND active.status='DOWNLOADING' AND active.lease_until>clock_timestamp())
              ORDER BY i.created_at,COALESCE((SELECT array_position(ARRAY(SELECT jsonb_array_elements_text(parent.child_ids)),i.id::text) FROM distribution.online_import parent WHERE parent.id=i.parent_id AND parent.is_test=i.is_test),0),i.id LIMIT 1 FOR UPDATE OF i SKIP LOCKED`,
            [isTest, prefetch],
          );
          const row = result.rows[0];
          if (!row) return null;
          let error: string | null =
            row.attempts >= 3 &&
            !["ONLINE_PROVIDER_VERIFICATION_REQUIRED", "ONLINE_PROVIDER_RATE_LIMITED"].includes(
              row.error,
            )
              ? "ONLINE_IMPORT_RETRY_EXHAUSTED"
              : null;
          try {
            if (!error) await allowed(row.requested_by, isTest);
          } catch (e) {
            error =
              e instanceof Error && e.message in ONLINE_IMPORT_ERRORS
                ? e.message
                : "OPERATOR_AUTHORITY_UNAVAILABLE";
          }
          if (error) {
            await client.query(
              "UPDATE distribution.online_import SET status='FAILED',error=$2,updated_at=now() WHERE id=$1",
              [row.id, error],
            );
            continue;
          }
          const leaseToken = randomUUID();
          await client.query(
            "UPDATE distribution.online_import SET status='DOWNLOADING',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+interval '2 minutes',error=NULL,updated_at=now() WHERE id=$1",
            [row.id, leaseToken],
          );
          return {
            ...dto({ ...row, status: "DOWNLOADING" }),
            isTest,
            requestedBy: row.requested_by,
            language: row.language,
            category: row.category,
            leaseToken,
          };
        }
        return null;
      }),
    renew: (claim: OnlineImportClaim) =>
      transaction(async (client) => {
        await checked(client, claim);
        await client.query(
          "UPDATE distribution.online_import SET lease_until=clock_timestamp()+interval '2 minutes',updated_at=now() WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
          [claim.id, claim.isTest],
        );
      }),
    expand: (
      claim: OnlineImportClaim,
      entries: (OnlineVideoSource & { title?: string })[],
      title: string,
    ) =>
      transaction(async (client) => {
        const row = await checked(client, claim);
        if (row.source.kind !== "playlist" || entries.length > ONLINE_IMPORT_PLAYLIST_LIMIT)
          throw Error("ONLINE_PLAYLIST_TOO_LARGE");
        const children: string[] = [];
        for (const entry of entries) {
          const source = onlineVideoSource(entry.url);
          if (source.provider !== "youtube" || source.kind !== "video")
            throw Error("UNSUPPORTED_VIDEO_LINK");
          const child = await insert(client, {
            source,
            isTest: claim.isTest,
            requestedBy: row.requested_by,
            language: row.language,
            category: row.category,
            parentId: row.id,
          });
          if (entry.title)
            await client.query(
              "UPDATE distribution.online_import SET title=$3 WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL AND title IS NULL",
              [child.id, claim.isTest, entry.title.slice(0, 200)],
            );
          if (!children.includes(child.id)) children.push(child.id);
        }
        if (!children.length) throw Error("ONLINE_SOURCE_UNAVAILABLE");
        await client.query(
          "UPDATE distribution.online_import SET status='COMPLETE',title=$3,child_ids=$4,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
          [row.id, claim.isTest, title.slice(0, 200), JSON.stringify(children)],
        );
        await client.query(
          "DELETE FROM distribution.online_import_service WHERE is_test=$1 AND provider=$2",
          [claim.isTest, claim.source.provider],
        );
      }),
    complete: (claim: OnlineImportClaim, input: Pick<CreateMasterInput, "asset" | "title">) =>
      transaction(async (client) => {
        const row = await checked(client, claim);
        const result = await saveMaster(client, row, claim.isTest, row.requested_by, input);
        await client.query(
          "DELETE FROM distribution.online_import_service WHERE is_test=$1 AND provider=$2",
          [claim.isTest, claim.source.provider],
        );
        return result;
      }),
    fail: (claim: OnlineImportClaim, code: string) =>
      transaction(async (client) => {
        const error = code in ONLINE_IMPORT_ERRORS ? code : "ONLINE_SOURCE_UNAVAILABLE";
        const providerIssue = [
          "ONLINE_PROVIDER_VERIFICATION_REQUIRED",
          "ONLINE_PROVIDER_RATE_LIMITED",
        ].includes(error);
        const result = await client.query(
          "UPDATE distribution.online_import SET status=CASE WHEN $6 OR ($5 AND attempts<3) THEN 'QUEUED' ELSE 'FAILED' END,error=CASE WHEN $5 AND attempts<3 THEN NULL ELSE $4 END,lease_token=NULL,lease_until=CASE WHEN $5 AND attempts<3 THEN clock_timestamp()+interval '30 seconds' ELSE NULL END,updated_at=now() WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL AND lease_token=$3 AND status='DOWNLOADING' RETURNING id",
          [
            claim.id,
            claim.isTest,
            claim.leaseToken,
            error,
            ["ONLINE_SOURCE_UNAVAILABLE", "ONLINE_IMPORT_TIMEOUT"].includes(error),
            providerIssue,
          ],
        );
        // Stale workers must not pause a provider after losing their lease.
        if (providerIssue && result.rowCount) {
          await client.query(
            `INSERT INTO distribution.online_import_service(provider,is_test,error,attempts,retry_at)
          VALUES($1,$2,$3,1,CASE WHEN $3='ONLINE_PROVIDER_RATE_LIMITED' THEN clock_timestamp()+interval '10 minutes' ELSE NULL END)
          ON CONFLICT(provider,is_test) DO UPDATE SET error=excluded.error,attempts=distribution.online_import_service.attempts+1,
            retry_at=CASE WHEN excluded.error='ONLINE_PROVIDER_RATE_LIMITED' AND distribution.online_import_service.attempts<3 THEN clock_timestamp()+interval '30 minutes' ELSE NULL END,updated_at=clock_timestamp()`,
            [claim.source.provider, claim.isTest, error],
          );
        }
      }),
  };
}

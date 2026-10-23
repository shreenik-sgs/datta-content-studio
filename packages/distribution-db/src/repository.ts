import { randomUUID } from "node:crypto";
import {
  CONTENT_CATEGORIES,
  type ContentMaster,
  type ContentRights,
  type ContentVersion,
  DISTRIBUTION_CAPABILITIES,
  type DistributionCapability,
  type DistributionChannel,
  MASTER_MIME_TYPES,
  MAX_ONLINE_MASTER_BYTES,
  contentApprovalDecision,
  contentExportDecision,
  contentStateAfterEdit,
  distributionRoleCapabilities,
  nextContentState,
  requireContentRevision,
  validateContentRights,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { invalidateActivations } from "./activation-invalidation.js";
import { requireIndependentSourceReview } from "./review-integrity.js";
import type { StudioRoleAuthority } from "./studio-authority.js";
import { renameMasterWorkspace, workspaceNameValue } from "./workspace-names.js";

/** Roles come from the current server-verified identity. Missing roles grant nothing. */
export type DistributionContext = { userId: string; isTest: boolean; roles?: readonly string[] };
/** Uses the existing narrowed policy: coordinator creates only; campaign grants remain Admin-only. */
export async function distributionCapabilities(
  client: Pool | PoolClient,
  context: DistributionContext,
): Promise<DistributionCapability[]> {
  const world = distributionWorld(context);
  const rows = await client.query(
    "SELECT capability FROM distribution.capability_grant WHERE user_id=$1 AND is_test=$2",
    [context.userId, world],
  );
  return distributionRoleCapabilities(
    context.roles ?? [],
    rows.rows.map((row) => row.capability),
  );
}
export async function requireDistributionCapability(
  client: Pool | PoolClient,
  context: DistributionContext,
  capabilities: readonly DistributionCapability[],
): Promise<void> {
  const allowed = await distributionCapabilities(client, context);
  if (!capabilities.some((capability) => allowed.includes(capability)))
    throw new Error("FORBIDDEN");
}
export async function recordContentRights(
  client: PoolClient,
  context: DistributionContext,
  master: ContentMaster,
  rights: ContentRights,
) {
  validateContentRights(rights);
  const id = master.id;
  await client.query(
    "INSERT INTO distribution.content_rights(version_id,is_test,revision,rights,attested_by) VALUES ($1,$2,$3,$4,$5)",
    [
      master.currentVersion.id,
      distributionWorld(context),
      master.revision + 1,
      rights,
      context.userId,
    ],
  );
  await client.query(
    "UPDATE distribution.content_master SET revision=revision+1,state='RIGHTS_CLEARED',updated_at=now() WHERE id=$1 AND is_test=$2",
    [id, distributionWorld(context)],
  );
  await client.query(
    "INSERT INTO distribution.audit_event(master_id,is_test,actor_id,action,revision) VALUES ($1,$2,$3,'RIGHTS_ATTESTED',$4)",
    [id, distributionWorld(context), context.userId, master.revision + 1],
  );
  await invalidateActivations(client, {
    isTest: context.isTest,
    actorId: context.userId,
    masterId: id,
    reason: "RIGHTS_ATTESTED",
  });
}

export type PrivateAsset = {
  storageKey: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  originalName: string;
};
export type CreateMasterInput = {
  title: string;
  language: string;
  category: string;
  asset: PrivateAsset;
};
export function distributionWorld(context: DistributionContext): boolean {
  if (typeof context.isTest !== "boolean") throw new Error("INVALID_WORLD");
  if (!context.userId?.trim()) throw new Error("UNAUTHENTICATED");
  return context.isTest;
}
export function validatePrivateAsset(asset: PrivateAsset): void {
  if (
    !/^distribution\/masters\/[a-f0-9-]{36}$/.test(asset.storageKey) ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.byteSize) ||
    asset.byteSize < 1 ||
    asset.byteSize > MAX_ONLINE_MASTER_BYTES ||
    !MASTER_MIME_TYPES.includes(asset.mimeType as (typeof MASTER_MIME_TYPES)[number]) ||
    !asset.originalName ||
    asset.originalName.length > 255 ||
    [...asset.originalName].some(
      (letter) =>
        letter === "/" ||
        letter === "\\" ||
        letter.charCodeAt(0) < 32 ||
        letter.charCodeAt(0) === 127,
    )
  )
    throw new Error("INVALID_ASSET");
}
function validateMetadata(input: Omit<CreateMasterInput, "asset">): void {
  if (
    !input.title.trim() ||
    input.title.length > 200 ||
    !input.language ||
    input.language.length > 20 ||
    !CONTENT_CATEGORIES.includes(input.category as (typeof CONTENT_CATEGORIES)[number]) ||
    !["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"].includes(input.language)
  )
    throw new Error("INVALID_CONTENT");
}
const contentCapabilities: DistributionCapability[] = [
  "content.create",
  "content.review",
  "content.publish",
];
const selectMaster = `SELECT m.*,
 (SELECT i.source->>'url' FROM distribution.online_import i WHERE i.master_id=m.id AND i.is_test=m.is_test AND m.current_version_number=1 ORDER BY i.created_at LIMIT 1) AS source_url, v.id AS version_id, v.number AS version_number,
 v.sha256, v.byte_size, v.mime_type, v.original_name, v.created_by AS version_created_by,
 v.created_at AS version_created_at,
 (SELECT r.rights FROM distribution.content_rights r WHERE r.version_id=v.id AND r.is_test=m.is_test ORDER BY r.revision DESC LIMIT 1) AS rights,
 (SELECT jsonb_build_object('versionId',a.version_id,'approvedRevision',a.approved_revision,'reviewerId',a.reviewer_id,'approvedAt',a.created_at)
  FROM distribution.approval_decision a WHERE a.version_id=v.id AND a.is_test=m.is_test AND a.approved_revision=m.revision LIMIT 1) AS approval
 FROM distribution.content_master m JOIN distribution.content_version v
 ON v.master_id=m.id AND v.is_test=m.is_test AND v.number=m.current_version_number`;
function iso(value: Date | string): string {
  return new Date(value).toISOString();
}
function dto(row: QueryResultRow): ContentMaster {
  return {
    id: row.id,
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    title: row.title,
    workspaceName: row.workspace_name ?? null,
    language: row.language,
    category: row.category,
    isTest: row.is_test,
    revision: row.revision,
    state: row.state,
    currentVersion: {
      id: row.version_id,
      masterId: row.id,
      number: row.version_number,
      sha256: row.sha256,
      byteSize: Number(row.byte_size),
      mimeType: row.mime_type,
      originalName: row.original_name,
      createdAt: iso(row.version_created_at),
      createdBy: row.version_created_by,
    },
    rights: row.rights,
    approval: row.approval ? { ...row.approval, approvedAt: iso(row.approval.approvedAt) } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const confirmedRollbacks = new WeakSet<Error>();
/** A failed COMMIT acknowledgement is never evidence that uploaded bytes are unreferenced. */
export function distributionTransactionRolledBack(error: unknown): boolean {
  return error instanceof Error && confirmedRollbacks.has(error);
}

// Repository is the only Distribution SQL boundary. World predicates are applied centrally.
export function createDistributionRepository(
  pool: Pool,
  authority: { authorize?: StudioRoleAuthority } = {},
) {
  async function grants(
    client: Pool | PoolClient,
    context: DistributionContext,
  ): Promise<DistributionCapability[]> {
    return distributionCapabilities(client, context);
  }
  async function requireGrant(
    client: Pool | PoolClient,
    context: DistributionContext,
    capability?: DistributionCapability,
  ) {
    const allowed = await grants(client, context);
    if (
      capability
        ? !allowed.includes(capability)
        : !contentCapabilities.some((item) => allowed.includes(item))
    )
      throw new Error("FORBIDDEN");
  }
  async function transaction<T>(
    context: DistributionContext,
    capability: DistributionCapability | undefined,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    distributionWorld(context);
    const client = await pool.connect();
    let commitAttempted = false;
    try {
      await client.query("BEGIN");
      await requireGrant(client, context, capability);
      const result = await operation(client);
      commitAttempted = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original problem, without claiming the database rolled back.
        throw error;
      }
      if (!commitAttempted && error instanceof Error) {
        // Brand a fresh error so a reused provider error cannot inherit proof from
        // a previous transaction. Its public code remains unchanged.
        const rejected = new Error(error.message, { cause: error });
        rejected.name = error.name;
        confirmedRollbacks.add(rejected);
        throw rejected;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  async function read(
    client: PoolClient,
    context: DistributionContext,
    id: string,
  ): Promise<ContentMaster> {
    const result = await client.query(
      `${selectMaster} WHERE m.id=$1 AND m.is_test=$2 AND m.deleted_at IS NULL`,
      [id, distributionWorld(context)],
    );
    if (!result.rows[0]) throw new Error("NOT_FOUND");
    return dto(result.rows[0]);
  }
  async function locked(
    client: PoolClient,
    context: DistributionContext,
    id: string,
    expectedRevision: number,
  ) {
    const rows = await client.query(
      "SELECT id FROM distribution.content_master WHERE id=$1 AND is_test=$2 FOR UPDATE",
      [id, distributionWorld(context)],
    );
    if (!rows.rowCount) throw new Error("NOT_FOUND");
    const master = await read(client, context, id);
    requireContentRevision(master.revision, expectedRevision);
    if (master.state === "WITHDRAWN") throw new Error("CONTENT_WITHDRAWN");
    return master;
  }
  async function audit(
    client: PoolClient,
    context: DistributionContext,
    id: string,
    revision: number,
    action: string,
  ) {
    await client.query(
      "INSERT INTO distribution.audit_event(master_id,is_test,actor_id,action,revision) VALUES ($1,$2,$3,$4,$5)",
      [id, distributionWorld(context), context.userId, action, revision],
    );
    if (!["CONTENT_CREATED", "MANUAL_EXPORT"].includes(action))
      await invalidateActivations(client, {
        isTest: context.isTest,
        actorId: context.userId,
        masterId: id,
        reason: action,
      });
  }
  async function asset(
    client: PoolClient,
    context: DistributionContext,
    master: ContentMaster,
  ): Promise<PrivateAsset> {
    const rows = await client.query(
      "SELECT storage_key FROM distribution.content_version WHERE id=$1 AND is_test=$2",
      [master.currentVersion.id, distributionWorld(context)],
    );
    if (!rows.rows[0]) throw new Error("NOT_FOUND");
    return {
      storageKey: rows.rows[0].storage_key,
      sha256: master.currentVersion.sha256,
      byteSize: master.currentVersion.byteSize,
      mimeType: master.currentVersion.mimeType,
      originalName: master.currentVersion.originalName,
    };
  }
  return {
    capabilities: (context: DistributionContext) => grants(pool, context),
    workspaceNames: (context: DistributionContext, ids: string[]) =>
      transaction(context, undefined, async (client) => {
        const result = await client.query(
          "SELECT id,workspace_name FROM distribution.content_master WHERE is_test=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL",
          [distributionWorld(context), ids],
        );
        return Object.fromEntries(
          result.rows
            .filter((r) => r.workspace_name)
            .map((r) => [r.id, r.workspace_name as string]),
        );
      }),
    rename: (
      context: DistributionContext,
      id: string,
      input: { name: string; expectedName: string | null },
    ) =>
      transaction(context, "content.create", async (client) => {
        await renameMasterWorkspace(
          client,
          context,
          id,
          workspaceNameValue(input.name),
          input.expectedName,
        );
        return read(client, context, id);
      }),
    list: (
      context: DistributionContext,
      pagination: {
        limit?: number;
        offset?: number;
        query?: string;
        state?: string;
        archive?: "active" | "withdrawn" | "all";
      } = {},
    ) =>
      transaction(context, undefined, async (client) => {
        const limit = Math.min(100, Math.max(1, Math.trunc(pagination.limit ?? 50)));
        const offset = Math.max(0, Math.trunc(pagination.offset ?? 0));
        const result = await client.query(
          `${selectMaster} WHERE m.is_test=$1 AND m.deleted_at IS NULL AND strpos(lower(concat_ws(' ',m.workspace_name,m.title)),lower($4))>0 AND ($5::text IS NULL OR m.state=$5)
           AND ($6::text='all' OR ($6='active' AND m.state<>'WITHDRAWN') OR ($6='withdrawn' AND m.state='WITHDRAWN'))
           ORDER BY m.updated_at DESC,m.id LIMIT $2 OFFSET $3`,
          [
            distributionWorld(context),
            limit,
            offset,
            (pagination.query ?? "").slice(0, 200),
            pagination.state ?? null,
            pagination.archive ?? "all",
          ],
        );
        return result.rows.map(dto);
      }),
    versions: (context: DistributionContext, id: string) =>
      transaction(context, undefined, async (client): Promise<ContentVersion[]> => {
        await read(client, context, id);
        const result = await client.query(
          "SELECT * FROM distribution.content_version WHERE master_id=$1 AND is_test=$2 ORDER BY number DESC LIMIT 100",
          [id, distributionWorld(context)],
        );
        return result.rows.map((row) => ({
          id: row.id,
          masterId: row.master_id,
          number: row.number,
          sha256: row.sha256,
          byteSize: Number(row.byte_size),
          mimeType: row.mime_type,
          originalName: row.original_name,
          createdAt: iso(row.created_at),
          createdBy: row.created_by,
        }));
      }),
    get: (context: DistributionContext, id: string) =>
      transaction(context, undefined, (client) => read(client, context, id)),
    create: (context: DistributionContext, input: CreateMasterInput) => {
      validateMetadata(input);
      validatePrivateAsset(input.asset);
      return transaction(context, "content.create", async (client) => {
        const id = await insertContentMaster(client, context, input);
        return read(client, context, id);
      });
    },
    addVersion: (
      context: DistributionContext,
      id: string,
      input: { expectedRevision: number; asset: PrivateAsset },
    ) => {
      validatePrivateAsset(input.asset);
      return transaction(context, "content.create", async (client) => {
        const master = await locked(client, context, id, input.expectedRevision);
        await insertMasterVersion(
          client,
          context,
          id,
          master.currentVersion.number + 1,
          input.asset,
        );
        await client.query(
          "UPDATE distribution.content_master SET current_version_number=current_version_number+1,revision=revision+1,state='DRAFT',updated_at=now() WHERE id=$1 AND is_test=$2",
          [id, distributionWorld(context)],
        );
        await audit(client, context, id, master.revision + 1, "VERSION_ADDED");
        return read(client, context, id);
      });
    },
    updateMetadata: (
      context: DistributionContext,
      id: string,
      input: { expectedRevision: number; title: string; language: string; category: string },
    ) => {
      validateMetadata(input);
      return transaction(context, "content.create", async (client) => {
        const master = await locked(client, context, id, input.expectedRevision);
        await client.query(
          "UPDATE distribution.content_master SET title=$3,language=$4,category=$5,revision=revision+1,state=$6,updated_at=now() WHERE id=$1 AND is_test=$2",
          [
            id,
            distributionWorld(context),
            input.title.trim(),
            input.language,
            input.category,
            contentStateAfterEdit(master.state, "metadata"),
          ],
        );
        await audit(client, context, id, master.revision + 1, "METADATA_UPDATED");
        return read(client, context, id);
      });
    },
    attestRights: (
      context: DistributionContext,
      id: string,
      input: { expectedRevision: number; rights: ContentRights },
    ) => {
      validateContentRights(input.rights);
      return transaction(context, "content.create", async (client) => {
        const master = await locked(client, context, id, input.expectedRevision);
        await recordContentRights(client, context, master, input.rights);
        return read(client, context, id);
      });
    },
    approve: (context: DistributionContext, id: string, input: { expectedRevision: number }) =>
      transaction(context, "content.review", async (client) => {
        const master = await locked(client, context, id, input.expectedRevision);
        await requireIndependentSourceReview(client, {
          isTest: context.isTest,
          masterId: id,
          versionId: master.currentVersion.id,
          reviewerId: context.userId,
          reviewerRoles: context.roles,
        });
        const approval = contentApprovalDecision({
          content: master,
          now: new Date().toISOString(),
        });
        if (!approval.allowed) throw new Error(`APPROVAL_REFUSED:${approval.reason}`);
        const state = nextContentState(master.state, "APPROVE");
        await client.query(
          "INSERT INTO distribution.approval_decision(version_id,is_test,approved_revision,reviewer_id) VALUES ($1,$2,$3,$4)",
          [
            master.currentVersion.id,
            distributionWorld(context),
            master.revision + 1,
            context.userId,
          ],
        );
        await client.query(
          "UPDATE distribution.content_master SET revision=revision+1,state=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
          [id, distributionWorld(context), state],
        );
        await audit(client, context, id, master.revision + 1, "CONTENT_APPROVED");
        return read(client, context, id);
      }),
    withdraw: (context: DistributionContext, id: string, input: { expectedRevision: number }) =>
      transaction(context, "content.review", async (client) => {
        const master = await locked(client, context, id, input.expectedRevision);
        const state = nextContentState(master.state, "WITHDRAW");
        await client.query(
          "UPDATE distribution.content_master SET revision=revision+1,state=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
          [id, distributionWorld(context), state],
        );
        await audit(client, context, id, master.revision + 1, "CONTENT_WITHDRAWN");
        return read(client, context, id);
      }),
    getAsset: (context: DistributionContext, id: string) =>
      transaction(context, undefined, async (client) => {
        const master = await read(client, context, id);
        if (master.state === "WITHDRAWN") throw new Error("CONTENT_WITHDRAWN");
        return { content: master, asset: await asset(client, context, master) };
      }),
    getExport: (
      context: DistributionContext,
      id: string,
      options: {
        expectedRevision: number;
        channel: DistributionChannel;
        territory: string;
        now: string;
        recordAudit?: boolean;
      },
    ) =>
      transaction(context, "content.publish", async (client) => {
        await client.query(
          "SELECT id FROM distribution.content_master WHERE id=$1 AND is_test=$2 FOR SHARE",
          [id, distributionWorld(context)],
        );
        const master = await read(client, context, id);
        requireContentRevision(master.revision, options.expectedRevision);
        const decision = contentExportDecision({ content: master, ...options });
        if (!decision.allowed) throw new Error(`EXPORT_REFUSED:${decision.reason}`);
        await requireIndependentSourceReview(client, {
          isTest: context.isTest,
          masterId: id,
          versionId: master.currentVersion.id,
          reviewerId: master.approval?.reviewerId ?? "",
          reviewerRoles:
            authority.authorize &&
            master.approval &&
            (await authority.authorize({
              userId: master.approval.reviewerId,
              isTest: context.isTest,
              capability: "content.create",
            })) &&
            (await authority.authorize({
              userId: master.approval.reviewerId,
              isTest: context.isTest,
              capability: "content.review",
            }))
              ? ["CONTENT_COORDINATOR", "CONTENT_APPROVER"]
              : [],
        });
        if (options.recordAudit !== false)
          await audit(client, context, id, master.revision, "MANUAL_EXPORT");
        return { content: master, asset: await asset(client, context, master) };
      }),
  };
}
export type DistributionRepository = ReturnType<typeof createDistributionRepository>;

/** Pre-deploy provisioning only: runtime credentials cannot mutate capability_grant. */
export async function provisionDistributionCapabilities(
  pool: Pool,
  userId: string,
  isTest: boolean,
  capabilities: readonly DistributionCapability[],
  grantedBy: string,
): Promise<void> {
  distributionWorld({ userId, isTest });
  if (
    !grantedBy.trim() ||
    capabilities.some((capability) => !DISTRIBUTION_CAPABILITIES.includes(capability))
  )
    throw new Error("INVALID_CAPABILITIES");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM distribution.capability_grant WHERE user_id=$1 AND is_test=$2",
      [userId, isTest],
    );
    for (const capability of new Set(capabilities))
      await client.query(
        "INSERT INTO distribution.capability_grant(user_id,is_test,capability,granted_by) VALUES ($1,$2,$3,$4)",
        [userId, isTest, capability, grantedBy],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function insertMasterVersion(
  client: PoolClient,
  context: DistributionContext,
  id: string,
  number: number,
  asset: PrivateAsset,
) {
  // Serialize identical content within one world, including concurrent creates.
  // Keep historical and withdrawn masters discoverable instead of silently copying them.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `master-upload:${distributionWorld(context)}:${asset.sha256}`,
  ]);
  const duplicate = await client.query(
    "SELECT 1 FROM distribution.content_version v JOIN distribution.content_master m ON m.id=v.master_id AND m.is_test=v.is_test WHERE v.is_test=$1 AND v.sha256=$2 AND m.deleted_at IS NULL LIMIT 1",
    [distributionWorld(context), asset.sha256],
  );
  if (duplicate.rowCount) throw new Error("DUPLICATE_MASTER");
  await client.query(
    `INSERT INTO distribution.content_version(master_id,is_test,number,storage_key,sha256,byte_size,mime_type,original_name,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      distributionWorld(context),
      number,
      asset.storageKey,
      asset.sha256,
      asset.byteSize,
      asset.mimeType,
      asset.originalName,
      context.userId,
    ],
  );
}

/** Shared atomic insertion for file uploads and leased online imports. */
export async function insertContentMaster(
  client: PoolClient,
  context: DistributionContext,
  input: CreateMasterInput,
) {
  validateMetadata(input);
  validatePrivateAsset(input.asset);
  const id = randomUUID();
  await client.query(
    "INSERT INTO distribution.content_master(id,is_test,title,language,category,created_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      id,
      distributionWorld(context),
      input.title.trim(),
      input.language,
      input.category,
      context.userId,
    ],
  );
  await insertMasterVersion(client, context, id, 1, input.asset);
  await client.query(
    "INSERT INTO distribution.audit_event(master_id,is_test,actor_id,action,revision) VALUES ($1,$2,$3,'CONTENT_CREATED',1)",
    [id, context.isTest, context.userId],
  );
  return id;
}

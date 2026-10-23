import type { PoolClient } from "pg";
import type { DistributionContext } from "./repository.js";

export function workspaceNameValue(value: string) {
  const name = value.trim();
  if (
    !name ||
    name.length > 200 ||
    Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw Error("WORKSPACE_NAME_INVALID");
  return name;
}
/** Organizing labels are separate from source metadata and approval revisions. */
export async function renameMasterWorkspace(
  client: PoolClient,
  context: DistributionContext,
  id: string,
  name: string,
  expectedName: string | null,
) {
  const { rows } = await client.query(
    "SELECT workspace_name,revision FROM distribution.content_master WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL FOR UPDATE",
    [id, context.isTest],
  );
  const row = rows[0];
  if (!row) throw Error("NOT_FOUND");
  if ((row.workspace_name ?? null) !== expectedName) throw Error("WORKSPACE_NAME_CONFLICT");
  if (row.workspace_name === name) return;
  await client.query(
    "UPDATE distribution.content_master SET workspace_name=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
    [id, context.isTest, name],
  );
  await client.query(
    "INSERT INTO distribution.audit_event(master_id,is_test,actor_id,action,revision) VALUES($1,$2,$3,'WORKSPACE_RENAMED',$4)",
    [id, context.isTest, context.userId, row.revision],
  );
}

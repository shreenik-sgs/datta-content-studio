import { createAssetStore } from "@satsang/distribution-assets";
import { createDistributionRepository, createStudioRoleAuthority } from "@satsang/distribution-db";
import type { DistributionCapability } from "@satsang/distribution-domain";
import { Pool } from "pg";
import { verifyDistributionOperator } from "./auth";
import { json, safeProblem } from "./http";

let pool: Pool | undefined;
export function distributionPool() {
  const connectionString = process.env.DISTRIBUTION_DATABASE_URL;
  if (!connectionString) throw new Error("DB_NOT_CONFIGURED");
  pool ??= new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
    application_name: "distribution-web",
  });
  return pool;
}
function repository() {
  return createDistributionRepository(distributionPool(), {
    authorize: createStudioRoleAuthority(process.env),
  });
}
export function privateAssets(context: { isTest: boolean }) {
  // Check the storage world independently of login so no caller can place
  // test bytes in a production bucket/prefix.
  if (
    process.env.DISTRIBUTION_ASSET_BACKEND === "s3" &&
    (typeof context.isTest !== "boolean" ||
      process.env.DISTRIBUTION_S3_PREFIX !== (context.isTest ? "test/" : "production/"))
  )
    throw new Error("ASSET_WORLD_MISMATCH");
  return createAssetStore(process.env);
}
export async function access(request: Request, required?: DistributionCapability) {
  const result = await verifyDistributionOperator(request, {
    featureEnabled: process.env.DISTRIBUTION_HUB_ENABLED === "true",
    stage: process.env.DISTRIBUTION_HUB_STAGE,
    appOrigin: process.env.DISTRIBUTION_APP_ORIGIN,
  });
  if (!result.ok)
    return { ok: false as const, response: json({ error: result.error }, result.status) };
  try {
    const repo = repository();
    const context = {
      userId: result.identity.id,
      isTest: result.identity.isTest,
      roles: result.identity.roles,
    };
    const capabilities = await repo.capabilities(context);
    if (!capabilities.length || (required && !capabilities.includes(required)))
      return { ok: false as const, response: json({ error: "FORBIDDEN" }, 403) };
    return { ok: true as const, identity: result.identity, repo, context, capabilities };
  } catch (error) {
    return { ok: false as const, response: safeProblem(error) };
  }
}

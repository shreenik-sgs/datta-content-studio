import { createHmac } from "node:crypto";
import { Pool } from "pg";
import {
  type StudioProviderConfig,
  parseStudioProviderConfig,
  sealStudioProviderConfig,
} from "./studio-provider-config";
import { studioSettingsRevision } from "./studio-settings";
const empty = (): StudioProviderConfig => ({ version: 1, accounts: [], trustedMediaOrigins: [] });
function worldKey(isTest: boolean, key: string | undefined) {
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw Error("SETTINGS_STORAGE_NOT_CONFIGURED");
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`studio-settings-world:${isTest}`)
    .digest("hex");
}
function pool(env: NodeJS.ProcessEnv) {
  if (!env.DISTRIBUTION_DATABASE_URL) throw Error("SETTINGS_STORAGE_NOT_CONFIGURED");
  return new Pool({
    connectionString: env.DISTRIBUTION_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
}
export async function loadDatabaseStudioSettings(
  isTest: boolean,
  env: NodeJS.ProcessEnv,
  key: string | undefined,
) {
  const encryptionKey = worldKey(isTest, key);
  const db = pool(env);
  try {
    const result = await db.query(
      "SELECT sealed FROM distribution.studio_settings WHERE is_test=$1",
      [isTest],
    );
    return result.rows[0]
      ? parseStudioProviderConfig(JSON.parse(result.rows[0].sealed), encryptionKey)
      : empty();
  } finally {
    await db.end();
  }
}
export async function saveDatabaseStudioSettings(input: {
  isTest: boolean;
  env: NodeJS.ProcessEnv;
  key: string | undefined;
  expectedRevision: string;
  config: StudioProviderConfig;
}) {
  const key = worldKey(input.isTest, input.key);
  const sealed = sealStudioProviderConfig(input.config, key);
  const db = pool(input.env);
  try {
    await db.query("BEGIN");
    // Serialize both first-write and update races without granting table/schema ownership.
    await db.query("SELECT pg_advisory_xact_lock(738299,$1)", [input.isTest ? 1 : 0]);
    const result = await db.query(
      "SELECT sealed FROM distribution.studio_settings WHERE is_test=$1",
      [input.isTest],
    );
    const current = result.rows[0]
      ? parseStudioProviderConfig(JSON.parse(result.rows[0].sealed), key)
      : empty();
    if (studioSettingsRevision(current) !== input.expectedRevision) throw Error("SETTINGS_CHANGED");
    await db.query(
      "INSERT INTO distribution.studio_settings(is_test,sealed) VALUES($1,$2) ON CONFLICT(is_test) DO UPDATE SET sealed=excluded.sealed,updated_at=now()",
      [input.isTest, sealed],
    );
    await db.query("COMMIT");
    return studioSettingsRevision(input.config);
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

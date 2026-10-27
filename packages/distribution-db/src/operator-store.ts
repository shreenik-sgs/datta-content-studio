import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { distributionRoleCapabilities } from "@satsang/distribution-domain";
import { Pool } from "pg";
const derive = promisify(scrypt);
const pools = new Map<string, Pool>();
export function studioIdentityPool(env: Record<string, string | undefined> = process.env): Pool {
  const url = env.DISTRIBUTION_DATABASE_URL;
  if (!url) throw new Error("DB_NOT_CONFIGURED");
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 2,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
      statement_timeout: 5000,
    });
    pools.set(url, pool);
  }
  return pool;
}
export async function hashOperatorPassword(password: string) {
  if (password.length < 12 || password.length > 256) throw new Error("PASSWORD_LENGTH");
  const salt = randomBytes(16).toString("hex");
  const value = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${value.toString("hex")}`;
}
export async function verifyOperatorPassword(password: string, hash: string) {
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(hash);
  if (!match?.[1] || !match[2] || password.length > 256) return false;
  const value = (await derive(password, match[1], 64)) as Buffer;
  return timingSafeEqual(value, Buffer.from(match[2], "hex"));
}
export function operatorTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export type StudioOperator = {
  version: 1;
  id: string;
  roles: string[];
  isTest: boolean;
  locale: string;
  displayName: string;
};
type Query = Pick<Pool, "query">;
export async function readStudioSession(
  token: string,
  pool: Query = studioIdentityPool(),
): Promise<StudioOperator | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await pool.query(
    `SELECT o.id, o.roles, o.is_test AS "isTest", o.locale, o.display_name AS "displayName"
 FROM distribution.operator_session s JOIN distribution.operator o ON o.id=s.operator_id
 WHERE s.token_hash=$1 AND s.expires_at>now() AND o.active=true`,
    [operatorTokenHash(token)],
  );
  return rows[0] ? { version: 1, ...rows[0] } : null;
}
export async function loginStudioOperator(
  email: string,
  password: string,
  isTest: boolean,
  pool: Query = studioIdentityPool(),
) {
  const normalized = email.trim().toLowerCase();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ||
    normalized.length > 254 ||
    password.length > 256
  )
    return null;
  const key = operatorTokenHash(normalized);
  const limit = await pool.query(
    `INSERT INTO distribution.login_attempt(key, attempts, expires_at) VALUES ($1,1,now()+interval '15 minutes')
 ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN distribution.login_attempt.expires_at<now() THEN 1 ELSE distribution.login_attempt.attempts+1 END,
 expires_at=CASE WHEN distribution.login_attempt.expires_at<now() THEN now()+interval '15 minutes' ELSE distribution.login_attempt.expires_at END RETURNING attempts`,
    [key],
  );
  if (limit.rows[0].attempts > 10) return null;
  const { rows } = await pool.query(
    "SELECT id,password_hash FROM distribution.operator WHERE email=$1 AND is_test=$2 AND active=true",
    [normalized, isTest],
  );
  const fallback = `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`;
  const valid = await verifyOperatorPassword(password, rows[0]?.password_hash ?? fallback);
  if (!rows[0] || !valid) return null;
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO distribution.operator_session(token_hash,operator_id,expires_at) VALUES ($1,$2,now()+interval '12 hours')",
    [operatorTokenHash(token), rows[0].id],
  );
  await pool.query("DELETE FROM distribution.login_attempt WHERE key=$1", [key]);
  return token;
}
export async function currentStudioAuthority(
  input: {
    userId: string;
    isTest: boolean;
    capability: "content.create" | "content.review" | "content.publish";
  },
  pool: Query,
): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT roles FROM distribution.operator WHERE id=$1 AND is_test=$2 AND active=true",
    [input.userId, input.isTest],
  );
  return !!rows[0] && distributionRoleCapabilities(rows[0].roles).includes(input.capability);
}
export type StudioOperatorSummary = {
  id: string;
  displayName: string;
  roles: string[];
  active: boolean;
};
/** Who an operator id belongs to, for naming the account a refusal concerns. */
export async function describeStudioOperator(
  pool: Query,
  id: string,
  isTest: boolean,
): Promise<StudioOperatorSummary | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const { rows } = await pool.query(
    'SELECT id::text AS id, display_name AS "displayName", roles, active FROM distribution.operator WHERE id=$1 AND is_test=$2',
    [id, isTest],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    displayName: String(row.displayName),
    roles: Array.isArray(row.roles) ? row.roles.map(String) : [],
    active: Boolean(row.active),
  };
}

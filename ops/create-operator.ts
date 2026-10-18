import { randomUUID } from "node:crypto";
import {
  hashOperatorPassword,
  studioIdentityPool,
} from "../packages/distribution-db/src/operator-store";
async function main() {
  const email = process.env.STUDIO_USER_EMAIL?.trim().toLowerCase();
  const name = process.env.STUDIO_USER_NAME?.trim();
  const password = process.env.STUDIO_USER_PASSWORD;
  const roles = (process.env.STUDIO_USER_ROLES ?? "").split(",").filter(Boolean);
  const allowed = ["CONTENT_COORDINATOR", "CONTENT_APPROVER", "SUPER_ADMIN"];
  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !name ||
    name.length > 200 ||
    !password ||
    !roles.length ||
    roles.some((r) => !allowed.includes(r)) ||
    !["TEST", "LIMITED", "ON"].includes(process.env.DISTRIBUTION_HUB_STAGE ?? "")
  )
    throw Error(
      "Set STUDIO_USER_EMAIL, STUDIO_USER_NAME, STUDIO_USER_PASSWORD, STUDIO_USER_ROLES and the Hub stage.",
    );
  const pool = studioIdentityPool({
    DISTRIBUTION_DATABASE_URL: process.env.DISTRIBUTION_MIGRATION_DATABASE_URL,
  });
  const client = await pool.connect();
  try {
    const hash = await hashOperatorPassword(password);
    const id = randomUUID();
    const isTest = process.env.DISTRIBUTION_HUB_STAGE === "TEST";
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO distribution.operator(id,email,display_name,password_hash,roles,is_test) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, email, name, hash, JSON.stringify(roles), isTest],
    );
    if (roles.includes("SUPER_ADMIN"))
      for (const capability of [
        "campaigns.manage",
        "channels.manage",
        "analytics.view",
        "operations.manage",
      ])
        await client.query(
          "INSERT INTO distribution.capability_grant(user_id,is_test,capability,granted_by) VALUES ($1,$2,$3,$1) ON CONFLICT DO NOTHING",
          [id, isTest, capability],
        );
    await client.query("COMMIT");
    console.info("Content Studio account created. No Sannidhi account was read or changed.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
void main().catch(() => {
  console.error(
    "Account creation failed. Check the required settings, migration credentials, password length, and whether the email already exists.",
  );
  process.exitCode = 1;
});

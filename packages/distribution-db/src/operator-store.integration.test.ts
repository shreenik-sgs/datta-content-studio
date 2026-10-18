import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  currentStudioAuthority,
  hashOperatorPassword,
  loginStudioOperator,
  operatorTokenHash,
  readStudioSession,
} from "./operator-store";
const url = process.env.STUDIO_IDENTITY_TEST_DATABASE_URL;
describe.skipIf(!url)("Content Studio identity in a disposable database without Sannidhi", () => {
  let pool: Pool;
  let runtime: Pool;
  const runtimeRole = `studio_runtime_${randomUUID().replaceAll("-", "")}`;
  const curator = randomUUID();
  const approver = randomUUID();
  const email = `curator-${curator}@example.test`;
  const password = "isolated-content-studio-test-only";
  beforeAll(async () => {
    const target = new URL(url ?? "");
    if (
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      !target.pathname.startsWith("/content_studio_separation_test_")
    )
      throw Error("ISOLATED_IDENTITY_DATABASE_REQUIRED");
    pool = new Pool({ connectionString: target.toString(), max: 2 });
    await migrate(drizzle(pool), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      migrationsSchema: "distribution_migrations",
      migrationsTable: "__distribution_migrations",
    });
    await pool.query(
      `CREATE ROLE ${runtimeRole} LOGIN PASSWORD 'synthetic-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    const grants = await readFile(new URL("../ops/runtime-grants.sql", import.meta.url), "utf8");
    await pool.query(grants.replace(":'distribution_runtime_role'", `'${runtimeRole}'`));
    const runtimeUrl = new URL(target);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = "synthetic-test-only";
    runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 1 });
    const hash = await hashOperatorPassword(password);
    for (const [id, address, roles] of [
      [curator, email, ["CONTENT_COORDINATOR"]],
      [approver, `approver-${approver}@example.test`, ["CONTENT_APPROVER"]],
    ] as const)
      await pool.query(
        "INSERT INTO distribution.operator(id,email,display_name,password_hash,roles,is_test) VALUES ($1,$2,'Synthetic fixture',$3,$4,true)",
        [id, address, hash, JSON.stringify(roles)],
      );
  });
  afterAll(async () => {
    await runtime?.end();
    await pool?.end();
  });
  it("migrates without any Sannidhi user/session tables", async () => {
    expect(
      (
        await pool.query(
          "SELECT to_regclass('public.users') AS users, to_regclass('public.sessions') AS sessions",
        )
      ).rows[0],
    ).toEqual({ users: null, sessions: null });
  });
  it("allows runtime sign-in but forbids granting itself roles", async () => {
    const token = await loginStudioOperator(email, password, true, runtime);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      runtime.query(
        "UPDATE distribution.operator SET roles='[\"SUPER_ADMIN\"]'::jsonb WHERE id=$1",
        [curator],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtime.query(
        "UPDATE distribution.capability_grant SET capability='operations.manage' WHERE user_id=$1",
        [curator],
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it("signs in, stores only the token hash, revokes and signs in as a different user", async () => {
    const token = await loginStudioOperator(email, password, true, pool);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    if (!token) throw Error("LOGIN_FAILED");
    expect(await readStudioSession(token, pool)).toMatchObject({
      id: curator,
      isTest: true,
      roles: ["CONTENT_COORDINATOR"],
    });
    const saved = await pool.query(
      "SELECT token_hash FROM distribution.operator_session WHERE operator_id=$1 AND token_hash=$2",
      [curator, operatorTokenHash(token)],
    );
    expect(saved.rows[0].token_hash).toBe(operatorTokenHash(token));
    expect(saved.rows[0].token_hash).not.toBe(token);
    await pool.query("DELETE FROM distribution.operator_session WHERE token_hash=$1", [
      operatorTokenHash(token),
    ]);
    expect(await readStudioSession(token, pool)).toBeNull();
    const next = await loginStudioOperator(
      `approver-${approver}@example.test`,
      password,
      true,
      pool,
    );
    if (!next) throw Error("SECOND_LOGIN_FAILED");
    expect(await readStudioSession(next, pool)).toMatchObject({
      id: approver,
      roles: ["CONTENT_APPROVER"],
    });
  });
  it("refuses wrong passwords and cross-world login", async () => {
    expect(await loginStudioOperator(email, "incorrect-password", true, pool)).toBeNull();
    expect(await loginStudioOperator(email, password, false, pool)).toBeNull();
  });
  it("expires sessions and immediately respects deactivation and changed roles", async () => {
    const token = await loginStudioOperator(email, password, true, pool);
    if (!token) throw Error("LOGIN_FAILED");
    expect(
      await currentStudioAuthority(
        { userId: curator, isTest: true, capability: "content.create" },
        pool,
      ),
    ).toBe(true);
    expect(
      await currentStudioAuthority(
        { userId: curator, isTest: true, capability: "content.review" },
        pool,
      ),
    ).toBe(false);
    await pool.query("UPDATE distribution.operator SET roles='[]'::jsonb WHERE id=$1", [curator]);
    expect(
      await currentStudioAuthority(
        { userId: curator, isTest: true, capability: "content.create" },
        pool,
      ),
    ).toBe(false);
    await pool.query("UPDATE distribution.operator SET active=false WHERE id=$1", [curator]);
    expect(await readStudioSession(token, pool)).toBeNull();
    await pool.query("UPDATE distribution.operator SET active=true WHERE id=$1", [curator]);
    await pool.query(
      "UPDATE distribution.operator_session SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [operatorTokenHash(token)],
    );
    expect(await readStudioSession(token, pool)).toBeNull();
  });
  it("throttles repeated login attempts persistently", async () => {
    for (let i = 0; i < 10; i++)
      expect(
        await loginStudioOperator(
          `approver-${approver}@example.test`,
          "wrong-password",
          true,
          pool,
        ),
      ).toBeNull();
    expect(
      await loginStudioOperator(`approver-${approver}@example.test`, password, true, pool),
    ).toBeNull();
  });
});

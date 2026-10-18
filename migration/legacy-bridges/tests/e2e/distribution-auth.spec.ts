import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import bcrypt from "bcryptjs";
import { distributionRoleFixture } from "./distribution-role-fixture";

const enabled = process.env.DISTRIBUTION_E2E_ENABLED === "true";
const origin = process.env.DISTRIBUTION_E2E_ORIGIN ?? "http://localhost:3020";
function localSql(database: "satsang" | "distribution_hub_local", statement: string): string {
  const selected =
    process.env[
      database === "satsang" ? "DISTRIBUTION_E2E_CORE_DATABASE" : "DISTRIBUTION_E2E_HUB_DATABASE"
    ];
  if (!selected || !/^(nurturing|distribution)_preview_[a-z0-9]+$/.test(selected))
    throw new Error("EXPLICIT_LOCAL_PREVIEW_DATABASE_REQUIRED");
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "satsang-postgres",
      "psql",
      "-U",
      "satsang",
      "-d",
      selected,
      "-v",
      "ON_ERROR_STOP=1",
      "-tAq",
    ],
    { input: statement, encoding: "utf8" },
  ).trim();
}
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

test.describe("DS-DIST-R1 actual core/Hub authorization", () => {
  test.skip(!enabled, "Explicit local Distribution E2E setup is required.");
  test("DS-DIST-R1-AUTH current role, account and session govern access; legacy grants cannot confer authorship", async ({
    request,
  }) => {
    const target = new URL(origin);
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(target.hostname);
    expect(target.protocol).toBe("http:");
    const endpoint =
      process.env.DOCKER_HOST ||
      execFileSync(
        "docker",
        [
          "context",
          "inspect",
          execFileSync("docker", ["context", "show"], { encoding: "utf8" }).trim(),
          "--format",
          "{{.Endpoints.docker.Host}}",
        ],
        { encoding: "utf8" },
      ).trim();
    expect(endpoint.startsWith("unix://")).toBe(true);
    const actors = await distributionRoleFixture(request, origin);
    const creatorLibrary = await request.get(`${origin}/distribution/api/content`, {
      headers: { authorization: `Bearer ${actors.creatorSession}` },
    });
    expect(creatorLibrary.status()).toBe(200);
    const creatorCapabilities = (await creatorLibrary.json()).capabilities;
    expect(creatorCapabilities).toContain("content.create");
    expect(creatorCapabilities).not.toContain("content.review");
    expect(creatorCapabilities).not.toContain("content.publish");
    const userId = randomUUID();
    const email = `distribution-auth-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString("base64url");
    const hash = await bcrypt.hash(password, 12);
    const owned = `id=${literal(userId)} AND email=${literal(email)} AND is_test=true`;
    let created = false;
    const grant = () =>
      localSql(
        "distribution_hub_local",
        `INSERT INTO distribution.capability_grant(user_id,is_test,capability,granted_by) VALUES(${literal(userId)},true,'content.create','local-e2e'),(${literal(userId)},true,'content.review','local-e2e'),(${literal(userId)},true,'content.publish','local-e2e') ON CONFLICT DO NOTHING;`,
      );
    let token = "";
    const signIn = async () => {
      const response = await request.post(`${origin}/api/v1/auth/session`, {
        data: { email, password },
      });
      expect(response.status()).toBe(200);
      token = (await response.json()).token;
      expect(token).toMatch(/^[a-f0-9-]{36}$/);
    };
    const library = () =>
      request.get(`${origin}/distribution/api/content`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const assertAdminReviewOnly = async () => {
      const response = await library();
      expect(response.status()).toBe(200);
      const capabilities = (await response.json()).capabilities;
      expect(capabilities).toContain("content.review");
      expect(capabilities).toContain("content.publish");
      expect(capabilities).not.toContain("content.create");
      expect(
        (
          await request.post(`${origin}/distribution/api/content`, {
            headers: { authorization: `Bearer ${token}`, origin },
            data: {},
          })
        ).status(),
      ).toBe(403);
    };
    try {
      localSql(
        "satsang",
        `BEGIN; INSERT INTO public.users(id,email,password_hash,display_name,is_test,locale,active,email_consent,notifications_enabled) VALUES(${literal(userId)},${literal(email)},${literal(hash)},'Distribution auth fixture',true,'en',true,false,false); INSERT INTO public.role_assignments(user_id,role) VALUES(${literal(userId)},'SUPER_ADMIN'); COMMIT;`,
      );
      created = true;
      grant();
      await signIn();
      await assertAdminReviewOnly();
      const me = await request.get(`${origin}/api/v1/operator-identity`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.status()).toBe(200);
      expect(me.headers()["cache-control"]).toBe("no-store");
      const identity = await me.json();
      expect(Object.keys(identity).sort()).toEqual([
        "displayName",
        "id",
        "isTest",
        "locale",
        "roles",
        "version",
      ]);
      expect(identity).toMatchObject({
        version: 1,
        id: userId,
        isTest: true,
        roles: ["SUPER_ADMIN"],
      });

      localSql(
        "distribution_hub_local",
        `DELETE FROM distribution.capability_grant WHERE user_id=${literal(userId)} AND is_test=true;`,
      );
      // Content duties come from current core roles. Removing obsolete Hub
      // content grants cannot remove Admin review/publish, and adding them
      // cannot confer creator permission.
      await assertAdminReviewOnly();
      grant();
      await assertAdminReviewOnly();

      localSql(
        "satsang",
        `UPDATE public.role_assignments SET revoked_at=now() WHERE user_id=${literal(userId)} AND role='SUPER_ADMIN' AND revoked_at IS NULL;`,
      );
      expect([401, 403]).toContain((await library()).status());
      localSql(
        "satsang",
        `UPDATE public.role_assignments SET revoked_at=NULL WHERE user_id=${literal(userId)} AND role='SUPER_ADMIN';`,
      );
      await signIn();
      expect((await library()).status()).toBe(200);

      localSql("satsang", `UPDATE public.users SET active=false WHERE ${owned};`);
      expect((await library()).status()).toBe(401);
      localSql("satsang", `UPDATE public.users SET active=true WHERE ${owned};`);
      await signIn();
      expect((await library()).status()).toBe(200);

      localSql(
        "satsang",
        `DELETE FROM public.sessions WHERE id=${literal(token)} AND user_id=${literal(userId)};`,
      );
      expect((await library()).status()).toBe(401);
    } finally {
      // Never touch seeded users. This run's @example.test fixture is retained
      // inactive for diagnosis; its sessions and grants are released.
      if (created) {
        localSql(
          "distribution_hub_local",
          `DELETE FROM distribution.capability_grant WHERE user_id=${literal(userId)} AND is_test=true;`,
        );
        localSql(
          "satsang",
          `BEGIN; DELETE FROM public.sessions WHERE user_id=${literal(userId)}; UPDATE public.role_assignments SET revoked_at=now() WHERE user_id=${literal(userId)} AND revoked_at IS NULL; UPDATE public.users SET active=false WHERE ${owned}; COMMIT;`,
        );
      }
    }
  });
});

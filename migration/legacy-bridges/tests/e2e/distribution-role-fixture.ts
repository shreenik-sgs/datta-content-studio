import { lstat, readFile } from "node:fs/promises";
import type { APIRequestContext } from "@playwright/test";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Explicit private local TEST fixture only; no credentials appear in reports or source. */
export async function distributionRoleFixture(request: APIRequestContext, origin: string) {
  const target = new URL(origin);
  const path = process.env.CIRCLES_E2E_FIXTURE_FILE;
  if (
    process.env.DISTRIBUTION_E2E_ENABLED !== "true" ||
    !path ||
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.origin !== origin
  )
    throw new Error("LOCAL_DISTRIBUTION_ROLE_FIXTURE_REQUIRED");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || (info.mode & 0o077) !== 0)
    throw new Error("LOCAL_DISTRIBUTION_ROLE_FIXTURE_UNSAFE");
  const fixture = JSON.parse(await readFile(path, "utf8"));
  const result = {
    creatorSession: fixture.contentCoordinatorSession as string,
    creatorId: fixture.contentCoordinatorId as string,
    reviewerSession: fixture.adminSession as string,
    reviewerId: fixture.adminId as string,
  };
  if (
    !Object.values(result).every((value) => typeof value === "string" && uuid.test(value)) ||
    result.creatorId === result.reviewerId
  )
    throw new Error("DISTINCT_DISTRIBUTION_ROLE_FIXTURES_REQUIRED");
  for (const [id, session, duty] of [
    [result.creatorId, result.creatorSession, "create"],
    [result.reviewerId, result.reviewerSession, "review"],
  ] as const) {
    const response = await request.get(`${origin}/api/v1/operator-identity`, {
      headers: { authorization: `Bearer ${session}` },
    });
    if (!response.ok()) throw new Error("LOCAL_DISTRIBUTION_ROLE_SESSION_INVALID");
    const identity = await response.json();
    if (
      identity.version !== 1 ||
      identity.id !== id ||
      identity.isTest !== true ||
      !Array.isArray(identity.roles) ||
      !(duty === "create"
        ? identity.roles.includes("CONTENT_COORDINATOR")
        : identity.roles.includes("CONTENT_APPROVER"))
    )
      throw new Error("LOCAL_DISTRIBUTION_ROLE_SESSION_INVALID");
  }
  return result;
}

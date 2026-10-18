import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import type { APIRequestContext } from "@playwright/test";

const cachePath = "/private/tmp/distribution-e2e-session.json";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Dedicated local fixture only. Reuse the existing session; do not weaken the
 * core login throttle merely because browser projects run several times. */
export async function distributionFixtureSession(
  request: APIRequestContext,
  origin: string,
): Promise<string> {
  const target = new URL(origin);
  const userId = process.env.DISTRIBUTION_LOCAL_USER_ID ?? "";
  const email = process.env.DISTRIBUTION_E2E_EMAIL ?? "";
  if (
    process.env.DISTRIBUTION_E2E_ENABLED !== "true" ||
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.pathname !== "/" ||
    !uuid.test(userId) ||
    !email.endsWith("@example.test")
  )
    throw new Error("LOCAL_DISTRIBUTION_FIXTURE_REQUIRED");
  const current = async (token: unknown): Promise<boolean> => {
    if (typeof token !== "string" || !uuid.test(token)) return false;
    const response = await request.get(`${origin}/api/v1/operator-identity`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok()) return false;
    const identity = await response.json();
    return identity.id === userId && identity.isTest === true && identity.version === 1;
  };
  const explicit = process.env.DISTRIBUTION_E2E_SESSION;
  if (explicit) {
    if (!(await current(explicit))) throw new Error("LOCAL_DISTRIBUTION_SESSION_INVALID");
    return explicit;
  }
  try {
    const info = await lstat(cachePath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 4096)
      throw new Error("LOCAL_DISTRIBUTION_SESSION_CACHE_UNSAFE");
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    if (cache.origin === origin && cache.userId === userId && (await current(cache.token)))
      return cache.token as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const login = await request.post(`${origin}/api/v1/auth/session`, {
    data: { email, password: process.env.DISTRIBUTION_E2E_PASSWORD ?? "" },
  });
  if (login.status() !== 200) throw new Error(`LOCAL_DISTRIBUTION_SIGN_IN_${login.status()}`);
  const token = (await login.json()).token;
  if (!(await current(token))) throw new Error("LOCAL_DISTRIBUTION_SESSION_INVALID");
  const temporary = `${cachePath}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify({ origin, userId, token }), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, cachePath);
  return token as string;
}

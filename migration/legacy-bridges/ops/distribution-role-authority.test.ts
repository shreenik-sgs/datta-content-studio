import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createDistributionRoleAuthority } from "../packages/distribution-db/src/operator-authority";

const fixture = vi.hoisted(() => ({ roles: [{ role: "CONTENT_COORDINATOR" }], enabled: true }));
vi.mock("../apps/web/src/lib/db", () => ({
  db: {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => fixture.roles }) }) }),
  },
}));
vi.mock("../apps/web/src/lib/distribution-policy", () => ({
  distributionHubEnabled: async () => fixture.enabled,
}));
import { POST } from "../apps/web/src/app/api/v1/distribution-worker-authority/route";
afterEach(() => vi.unstubAllEnvs());

it("configured loopback worker and core use the same signed contract and immediately observe role revocation", async () => {
  const key = randomBytes(32).toString("hex");
  vi.stubEnv("DISTRIBUTION_WORKER_AUTHORIZATION_ENABLED", "true");
  vi.stubEnv("DISTRIBUTION_WORKER_AUTHORIZATION_KEY", key);
  vi.stubEnv("DISTRIBUTION_HUB_STAGE", "TEST");
  vi.stubEnv("DATABASE_URL", "postgres://fixture:fixture@localhost:5442/unused_test");
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (typeof value === "string") headers.set(name, value);
      const response = await POST(
        new Request("http://localhost/api/v1/distribution-worker-authority", {
          method: "POST",
          headers,
          body: Buffer.concat(chunks),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(await response.text());
    } catch {
      outgoing.writeHead(503);
      outgoing.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("NO_LOCAL_ADDRESS");
    const authority = createDistributionRoleAuthority({
      ...process.env,
      DISTRIBUTION_CORE_ORIGIN: `http://127.0.0.1:${address.port}`,
    });
    const input = { userId: randomUUID(), isTest: true, capability: "content.create" as const };
    expect(await authority(input)).toBe(true);
    fixture.roles = [];
    expect(await authority(input)).toBe(false);
    fixture.roles = [{ role: "SUPER_ADMIN" }];
    expect(await authority(input)).toBe(false);
    expect(await authority({ ...input, capability: "content.review" })).toBe(false);
    fixture.roles = [{ role: "CONTENT_APPROVER" }];
    expect(await authority({ ...input, capability: "content.review" })).toBe(true);
    fixture.enabled = false;
    await expect(authority({ ...input, capability: "content.review" })).rejects.toThrow(
      "OPERATOR_AUTHORITY_UNAVAILABLE",
    );
    fixture.enabled = true;
    expect(await authority({ ...input, capability: "content.review" })).toBe(true);
    vi.stubEnv("DISTRIBUTION_WORKER_AUTHORIZATION_ENABLED", "false");
    await expect(authority(input)).rejects.toThrow("OPERATOR_AUTHORITY_UNAVAILABLE");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

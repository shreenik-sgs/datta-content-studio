import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDistributionRoleAuthority } from "./operator-authority";

const now = Date.parse("2026-10-05T12:00:00Z");
const env = {
  DISTRIBUTION_WORKER_AUTHORIZATION_ENABLED: "true",
  DISTRIBUTION_HUB_STAGE: "TEST",
  DISTRIBUTION_WORKER_AUTHORIZATION_KEY: "a".repeat(64),
  DISTRIBUTION_CORE_ORIGIN: "http://127.0.0.1:3020",
};
const input = {
  userId: "4a2c2466-72d4-4699-bdc7-a820b005e621",
  isTest: true,
  capability: "content.create" as const,
};
function signed(value: unknown, key = env.DISTRIBUTION_WORKER_AUTHORIZATION_KEY): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    headers: {
      "x-distribution-response-signature": createHmac("sha256", key)
        .update("distribution-worker-authority-response:v1\n")
        .update(body)
        .digest("hex"),
    },
  });
}
describe("fresh TEST worker role authority", () => {
  it("signs bounded identity/world/purpose and rechecks on every claim or completion", async () => {
    let allowed = true;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      expect(new Headers(init?.headers).get("x-distribution-signature")).toBe(
        createHmac("sha256", env.DISTRIBUTION_WORKER_AUTHORIZATION_KEY).update(body).digest("hex"),
      );
      expect(init).toMatchObject({ redirect: "error" });
      expect(new Headers(init?.headers).get("cache-control")).toBe("no-store");
      const request = JSON.parse(body);
      const { requestedAt: _requestedAt, ...echo } = request;
      return signed({ ...echo, allowed, checkedAt: new Date(now).toISOString() });
    });
    const authority = createDistributionRoleAuthority(env, fetcher, () => now);
    expect(await authority(input)).toBe(true);
    allowed = false;
    expect(await authority(input)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).requestId).not.toBe(
      JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).requestId,
    );
  });
  it("never contacts an unconfigured, remote, wrong-world or non-TEST authority", async () => {
    const fetcher = vi.fn();
    for (const config of [
      {},
      { ...env, DISTRIBUTION_CORE_ORIGIN: "https://example.com" },
      { ...env, DISTRIBUTION_HUB_STAGE: "ON" },
      { ...env, DISTRIBUTION_WORKER_AUTHORIZATION_KEY: "short" },
    ])
      await expect(createDistributionRoleAuthority(config, fetcher)(input)).rejects.toThrow(
        "OPERATOR_AUTHORITY_UNAVAILABLE",
      );
    await expect(
      createDistributionRoleAuthority(env, fetcher)({ ...input, isTest: false }),
    ).rejects.toThrow("OPERATOR_AUTHORITY_UNAVAILABLE");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses unavailable, oversized, stale, wrong-nonce and wrong-subject assertions", async () => {
    for (const mutate of [
      (value: Record<string, unknown>) => ({
        ...value,
        userId: "95823b3e-58b5-4e22-a3da-b96f8a636b8a",
      }),
      (value: Record<string, unknown>) => ({
        ...value,
        checkedAt: new Date(now - 6000).toISOString(),
      }),
      (value: Record<string, unknown>) => ({
        ...value,
        requestId: "95823b3e-58b5-4e22-a3da-b96f8a636b8a",
      }),
      (value: Record<string, unknown>) => ({ ...value, isTest: false }),
      (value: Record<string, unknown>) => ({ ...value, capability: "content.review" }),
    ]) {
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const { requestedAt: _requestedAt, ...request } = JSON.parse(String(init?.body));
        return signed(
          mutate({ ...request, allowed: true, checkedAt: new Date(now).toISOString() }),
        );
      });
      await expect(createDistributionRoleAuthority(env, fetcher, () => now)(input)).rejects.toThrow(
        "OPERATOR_AUTHORITY_UNAVAILABLE",
      );
    }
    for (const response of [
      new Response("unavailable", { status: 503 }),
      new Response("x".repeat(2049)),
    ])
      await expect(
        createDistributionRoleAuthority(
          env,
          async () => response,
          () => now,
        )(input),
      ).rejects.toThrow("OPERATOR_AUTHORITY_UNAVAILABLE");
  });
  it("rejects forged, tampered, unsigned and reflected-request responses even with matching fresh identity", async () => {
    for (const attack of [
      "unsigned",
      "wrong-key",
      "tampered-allow",
      "whitespace",
      "reflected-request",
    ] as const) {
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const { requestedAt: _requestedAt, ...request } = JSON.parse(String(init?.body));
        const allowed = { ...request, allowed: true, checkedAt: new Date(now).toISOString() };
        if (attack === "unsigned") return Response.json(allowed);
        if (attack === "wrong-key") return signed(allowed, "b".repeat(64));
        if (attack === "reflected-request")
          return new Response(JSON.stringify(allowed), {
            headers: {
              "x-distribution-response-signature":
                new Headers(init?.headers).get("x-distribution-signature") ?? "",
            },
          });
        const original = signed(
          attack === "tampered-allow" ? { ...allowed, allowed: false } : allowed,
        );
        const changedBody =
          attack === "tampered-allow" ? JSON.stringify(allowed) : `${await original.text()} `;
        return new Response(changedBody, { headers: original.headers });
      });
      await expect(createDistributionRoleAuthority(env, fetcher, () => now)(input)).rejects.toThrow(
        "OPERATOR_AUTHORITY_UNAVAILABLE",
      );
    }
  });
});

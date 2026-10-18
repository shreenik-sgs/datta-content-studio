import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStudioRoleAuthority } from "./studio-authority";
const now = Date.parse("2026-10-05T00:00:00Z");
const key = "a".repeat(64);
const subject = "11111111-1111-4111-8111-111111111111";
const testEnv = {
  STUDIO_WORKER_AUTHORIZATION_ENABLED: "true",
  STUDIO_WORKER_AUTHORIZATION_KEY: key,
  DISTRIBUTION_HUB_STAGE: "TEST",
  STUDIO_CORE_ORIGIN: "http://localhost:3020",
};
const input = { userId: subject, isTest: true, capability: "content.create" as const };
function signed(value: unknown, secret = key) {
  const body = JSON.stringify(value);
  return new Response(body, {
    headers: {
      "x-studio-response-signature": createHmac("sha256", secret)
        .update("studio-worker-authority-response:v2\n")
        .update(body)
        .digest("hex"),
    },
  });
}
function response(init?: RequestInit, changes: Record<string, unknown> = {}) {
  const { requestedAt: _date, ...request } = JSON.parse(String(init?.body));
  return { ...request, allowed: true, checkedAt: new Date(now).toISOString(), ...changes };
}
describe("Studio authority v2 without external requests", () => {
  it.each(["TEST", "LIMITED", "ON"])(
    "rechecks fresh %s duty/world with signed nonce and exact origin",
    async (stage) => {
      const isTest = stage === "TEST";
      const origin = isTest ? "http://localhost:3020" : "https://core.example.test";
      const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(url).toBe(`${origin}/api/v1/studio-worker-authority`);
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("x-studio-signature")).toBe(
          createHmac("sha256", key)
            .update("studio-worker-authority-request:v2\n")
            .update(String(init?.body))
            .digest("hex"),
        );
        return signed(response(init));
      });
      const authority = createStudioRoleAuthority(
        { ...testEnv, DISTRIBUTION_HUB_STAGE: stage, STUDIO_CORE_ORIGIN: origin },
        fetcher,
        () => now,
      );
      expect(await authority({ ...input, isTest, capability: "content.publish" })).toBe(true);
      expect(await authority({ ...input, isTest, capability: "content.review" })).toBe(true);
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).requestId).not.toBe(
        JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).requestId,
      );
    },
  );
  it("never contacts disabled, wrong-world, unbound, credential-bearing or insecure live origins", async () => {
    const fetcher = vi.fn();
    for (const env of [
      {},
      { ...testEnv, STUDIO_WORKER_AUTHORIZATION_ENABLED: "false" },
      { ...testEnv, STUDIO_CORE_ORIGIN: "https://remote.example.test" },
      { ...testEnv, STUDIO_CORE_ORIGIN: "http://localhost:3020/" },
      { ...testEnv, STUDIO_CORE_ORIGIN: "http://user:secret@localhost:3020" },
      { ...testEnv, DISTRIBUTION_HUB_STAGE: "ON", STUDIO_CORE_ORIGIN: "http://core.example.test" },
      { ...testEnv, DISTRIBUTION_HUB_STAGE: "ON", STUDIO_CORE_ORIGIN: "https://localhost" },
      { ...testEnv, DISTRIBUTION_HUB_STAGE: "ON", STUDIO_CORE_ORIGIN: "https://core.example.test" },
    ])
      await expect(createStudioRoleAuthority(env, fetcher)(input)).rejects.toThrow(
        "OPERATOR_AUTHORITY_UNAVAILABLE",
      );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("binds signed responses to time, nonce, world, subject and capability", async () => {
    for (const change of [
      { isTest: false },
      { userId: "22222222-2222-4222-8222-222222222222" },
      { capability: "content.publish" },
      { requestId: "22222222-2222-4222-8222-222222222222" },
      { checkedAt: new Date(now - 6000).toISOString() },
    ]) {
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        signed(response(init, change)),
      );
      await expect(createStudioRoleAuthority(testEnv, fetcher, () => now)(input)).rejects.toThrow(
        "OPERATOR_AUTHORITY_UNAVAILABLE",
      );
    }
  });
  it("refuses unsigned, tampered, reflected or oversized responses", async () => {
    for (const attack of ["unsigned", "wrong-key", "reflected", "tampered", "large"]) {
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const value = response(init);
        if (attack === "unsigned") return Response.json(value);
        if (attack === "wrong-key") return signed(value, "b".repeat(64));
        if (attack === "large") return new Response("x".repeat(2049));
        if (attack === "reflected")
          return new Response(JSON.stringify(value), {
            headers: {
              "x-studio-response-signature":
                new Headers(init?.headers).get("x-studio-signature") ?? "",
            },
          });
        const original = signed({ ...value, allowed: false });
        return new Response(JSON.stringify(value), { headers: original.headers });
      });
      await expect(createStudioRoleAuthority(testEnv, fetcher, () => now)(input)).rejects.toThrow(
        "OPERATOR_AUTHORITY_UNAVAILABLE",
      );
    }
  });
  it("allows legacy key fallback only for explicitly enabled TEST, never live stages", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      signed(response(init)),
    );
    const env = {
      ...testEnv,
      STUDIO_WORKER_AUTHORIZATION_KEY: undefined,
      DISTRIBUTION_WORKER_AUTHORIZATION_KEY: key,
    };
    expect(await createStudioRoleAuthority(env, fetcher, () => now)(input)).toBe(true);
    await expect(
      createStudioRoleAuthority(
        { ...env, DISTRIBUTION_HUB_STAGE: "ON", STUDIO_CORE_ORIGIN: "https://core.example.test" },
        fetcher,
        () => now,
      )({ ...input, isTest: false }),
    ).rejects.toThrow("OPERATOR_AUTHORITY_UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

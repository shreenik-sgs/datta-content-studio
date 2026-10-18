import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { readLiveCurationChannels } from "./live-channels";
const key = "a".repeat(64);
const env = {
  STUDIO_WORKER_AUTHORIZATION_ENABLED: "true",
  STUDIO_WORKER_AUTHORIZATION_KEY: key,
  DISTRIBUTION_HUB_STAGE: "TEST",
  STUDIO_CORE_ORIGIN: "http://localhost:3020",
};
const actor = { userId: "11111111-1111-4111-8111-111111111111", isTest: true };
const channels = [
  {
    channelId: `UC${"a".repeat(22)}`,
    name: "Configured channel",
    handle: "@fixture",
    enabled: true,
  },
];
function response(init?: RequestInit, patch: Record<string, unknown> = {}, signingKey = key) {
  const input = JSON.parse(String(init?.body));
  const body = JSON.stringify({
    version: 1,
    requestId: input.requestId,
    ...actor,
    channels,
    allowed: true,
    checkedAt: new Date().toISOString(),
    ...patch,
  });
  return new Response(body, {
    headers: {
      "x-studio-response-signature": createHmac("sha256", signingKey)
        .update("studio-worker-authority-response:v2\n")
        .update(body)
        .digest("hex"),
    },
  });
}
it("reads only signed channel configuration from the selected world", async () => {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(url).toBe("http://localhost:3020/api/v1/studio-live-channels");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("x-studio-signature")).toBe(
      createHmac("sha256", key)
        .update("studio-worker-authority-request:v2\n")
        .update(String(init?.body))
        .digest("hex"),
    );
    return response(init);
  });
  expect(await readLiveCurationChannels(env, actor, fetcher)).toEqual(channels);
  await expect(readLiveCurationChannels(env, { ...actor, isTest: false }, fetcher)).rejects.toThrow(
    "OPERATOR_AUTHORITY_UNAVAILABLE",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects stale, wrong-world, altered and unsigned channel lists", async () => {
  for (const patch of [
    { isTest: false },
    { allowed: false },
    { requestId: "22222222-2222-4222-8222-222222222222" },
    { userId: "22222222-2222-4222-8222-222222222222" },
    { checkedAt: new Date(Date.now() - 10000).toISOString() },
    { channels: [{ ...channels[0], channelId: "https://attacker.test/" }] },
  ])
    await expect(
      readLiveCurationChannels(env, actor, async (_url, init) => response(init, patch)),
    ).rejects.toThrow("OPERATOR_AUTHORITY_UNAVAILABLE");
  await expect(
    readLiveCurationChannels(env, actor, async (_url, init) => response(init, {}, "b".repeat(64))),
  ).rejects.toThrow();
  await expect(
    readLiveCurationChannels(env, actor, async () => Response.json({ channels })),
  ).rejects.toThrow();
});

it("serializes only the signed actor fields from a full session context", async () => {
  const context = { ...actor, roles: ["CONTENT_COORDINATOR"] };
  const fetcher: typeof fetch = async (_url, init) => {
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("roles");
    return response(init);
  };
  expect(await readLiveCurationChannels(env, context, fetcher)).toEqual(channels);
});

import { expect, it } from "vitest";
import { studioHttpFailure } from "./studio-provider-error";
it.each([
  [401, "STUDIO_PROVIDER_AUTHENTICATION_FAILED"],
  [403, "STUDIO_PROVIDER_AUTHENTICATION_FAILED"],
  [402, "STUDIO_PROVIDER_BILLING_REQUIRED"],
  [400, "STUDIO_PROVIDER_REQUEST_INVALID"],
  [429, "STUDIO_PROVIDER_RATE_LIMITED"],
  [503, "STUDIO_PROVIDER_UNAVAILABLE"],
])("classifies HTTP %i without leaking provider content", async (status, code) => {
  const error = await studioHttpFailure(
    new Response("private-key-do-not-expose", {
      status: Number(status),
      headers: { "retry-after": "120" },
    }),
  ).catch((value) => value);
  expect(error.message).toBe(code);
  expect(error.retryAfterMs).toBe(120000);
  expect(JSON.stringify(error)).not.toContain("private-key");
});
it("distinguishes an exhausted daily quota from a temporary request-rate limit", async () => {
  await expect(
    studioHttpFailure(
      Response.json(
        {
          error: {
            details: [
              { violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
            ],
          },
        },
        { status: 429 },
      ),
    ),
  ).rejects.toThrow("STUDIO_PROVIDER_QUOTA_EXHAUSTED");
  await expect(
    studioHttpFailure(
      Response.json(
        { error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerMinute" }] }] } },
        { status: 429 },
      ),
    ),
  ).rejects.toThrow("STUDIO_PROVIDER_RATE_LIMITED");
});
it("distinguishes exhausted OpenAI credits", async () => {
  await expect(
    studioHttpFailure(Response.json({ error: { code: "insufficient_quota" } }, { status: 429 })),
  ).rejects.toThrow("STUDIO_PROVIDER_QUOTA_EXHAUSTED");
});

it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"])(
  "recognizes an unsent %s request without exposing transport details",
  async (code) => {
    const { studioTransportFailure } = await import("./studio-provider-error");
    const error = studioTransportFailure(
      new TypeError("private URL", { cause: { code, secret: "do-not-expose" } }),
    );
    expect(error.requestNotSent).toBe(true);
    expect(JSON.stringify(error)).not.toMatch(/private URL|do-not-expose/);
  },
);
it.each(["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"])(
  "does not treat ambiguous %s as safe creation retry",
  async (code) => {
    const { studioTransportFailure } = await import("./studio-provider-error");
    expect(
      studioTransportFailure(new TypeError("private", { cause: { code } })).requestNotSent,
    ).toBe(false);
  },
);

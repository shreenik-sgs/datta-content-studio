import { beforeEach, describe, expect, it, vi } from "vitest";
import { distributionHubPolicyEnabled, verifyDistributionOperator } from "./auth";
const identity = {
  version: 1,
  id: "11111111-1111-4111-8111-111111111111",
  roles: ["SUPER_ADMIN"],
  isTest: true,
  locale: "en",
  displayName: "Operator",
};
const coreOrigin = "http://localhost:3020";
const appOrigin = "http://localhost:3070";
const options = { featureEnabled: true, stage: "TEST", coreOrigin, appOrigin };
const fetchImpl = vi.fn<typeof fetch>();
function req(method = "GET", headers: Record<string, string> = {}) {
  return new Request(`${appOrigin}/api/content`, {
    method,
    headers: {
      cookie: "other=private; ds_session=11111111-1111-4111-8111-111111111111",
      ...headers,
    },
  });
}
const verify = (request = req(), overrides = {}) =>
  verifyDistributionOperator(request, { ...options, fetchImpl, ...overrides });
describe("DS-DIST-R1-AUTH isolated operator authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchImpl.mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith("/distribution-policy") ? { version: 1, enabled: true } : identity,
      ),
    );
  });
  it("only forwards opaque session credentials to the fixed identity endpoint", async () => {
    expect(
      await verify(req("GET", { "x-roles": "TECH_SUPER_ADMIN", "x-user-id": "spoof" })),
    ).toEqual({ ok: true, identity });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${coreOrigin}/api/v1/operator-identity`);
    expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe("ds_session=11111111-1111-4111-8111-111111111111");
    expect(headers.get("x-roles")).toBeNull();
    expect(headers.get("x-user-id")).toBeNull();
  });
  it("rereads the Admin switch for each access and restores the same identity on re-enable", async () => {
    let enabled = false;
    fetchImpl.mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith("/distribution-policy") ? { version: 1, enabled } : identity,
      ),
    );
    expect(await verify()).toEqual({ ok: false, status: 404, error: "feature_unavailable" });
    enabled = true;
    expect(await verify()).toEqual({ ok: true, identity });
    enabled = false;
    expect(await verify(req("POST", { origin: appOrigin }))).toMatchObject({
      ok: false,
      status: 404,
    });
    for (const [url, init] of fetchImpl.mock.calls.filter(([url]) =>
      String(url).endsWith("/distribution-policy"),
    )) {
      expect(url).toBe(`${coreOrigin}/api/v1/distribution-policy`);
      expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
      expect(new Headers(init?.headers).get("cookie")).toBeNull();
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
    }
  });
  it("fails closed for missing, malformed, redirected, oversized or unavailable policy", async () => {
    for (const response of [
      Response.json({ version: 1, enabled: false }),
      Response.json({ version: 2, enabled: true }),
      Response.json({ version: 1, enabled: "true" }),
      Response.json({ version: 1, enabled: true, unexpected: "data" }),
      new Response("x".repeat(1025)),
      new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
      new Response(null, { status: 503 }),
    ]) {
      fetchImpl.mockResolvedValueOnce(response);
      expect(await distributionHubPolicyEnabled({ coreOrigin, fetchImpl })).toBe(false);
    }
    fetchImpl.mockRejectedValueOnce(new Error("private failure"));
    expect(await distributionHubPolicyEnabled({ coreOrigin, fetchImpl })).toBe(false);
  });
  it("bounds hung policy requests without forwarding credentials", async () => {
    fetchImpl.mockImplementationOnce(async () => new Promise(() => {}));
    expect(await distributionHubPolicyEnabled({ coreOrigin, fetchImpl, timeoutMs: 20 })).toBe(
      false,
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("rejects missing credentials and spoofed operator headers", async () => {
    expect(
      await verify(
        new Request(`${appOrigin}/api/content`, { headers: { "x-roles": "SUPER_ADMIN" } }),
      ),
    ).toMatchObject({ ok: false, status: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses ambiguous cookies or invalid bearer credentials before lookup", async () => {
    for (const headers of [
      {
        cookie:
          "ds_session=11111111-1111-4111-8111-111111111111; ds_session=22222222-2222-4222-8222-222222222222",
      },
      { authorization: "Bearer forged" },
      { cookie: "ds_session=invalid" },
    ]) {
      expect(await verify(req("GET", headers))).toMatchObject({ ok: false, status: 401 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rechecks revoked sessions and downgraded roles each time", async () => {
    expect((await verify()).ok).toBe(true);
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await verify()).toMatchObject({ ok: false, status: 401 });
    fetchImpl.mockResolvedValueOnce(Response.json({ ...identity, roles: ["DEVOTEE"] }));
    expect(await verify(req("GET", { "x-roles": "SUPER_ADMIN" }))).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it("accepts technical administrators and requires the test world at TEST stage", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ ...identity, roles: ["TECH_SUPER_ADMIN"] }));
    expect((await verify()).ok).toBe(true);
    fetchImpl.mockResolvedValueOnce(Response.json({ ...identity, isTest: false }));
    expect(await verify()).toMatchObject({ ok: false, status: 403 });
  });
  it("admits content coordinators using current local identity, not caller headers", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ ...identity, roles: ["CONTENT_COORDINATOR"] }));
    expect((await verify()).ok).toBe(true);
    fetchImpl.mockResolvedValueOnce(Response.json({ ...identity, roles: ["PRACTITIONER"] }));
    expect(await verify(req("GET", { "x-roles": "CONTENT_COORDINATOR" }))).toMatchObject({
      ok: false,
      status: 403,
    });
  });
  it("cannot override OFF by forged headers or an operator environment", async () => {
    vi.stubEnv("DISTRIBUTION_HUB_LOCAL_OPERATOR", "true");
    try {
      for (const overrides of [{ stage: "OFF" }, { stage: undefined }, { featureEnabled: false }]) {
        expect(await verify(req("GET", { "x-distribution-stage": "ON" }), overrides)).toMatchObject(
          { ok: false, status: 404 },
        );
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("rejects unsafe core endpoints before forwarding credentials", async () => {
    for (const origin of [
      undefined,
      "http://core.example.com",
      "http://localhost.evil.test",
      "https://user:secret@core.example.com",
      "https://core.example.com/path",
      "https://core.example.com?next=elsewhere",
      "file:///tmp/secret",
    ]) {
      expect(await verify(req(), { coreOrigin: origin })).toMatchObject({ ok: false, status: 503 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("accepts a fixed HTTPS core origin", async () => {
    expect((await verify(req(), { coreOrigin: "https://sannidhi.example.test" })).ok).toBe(true);
  });
  it("enforces mutation Origin for cookie sessions without trusting forwarded hosts", async () => {
    for (const headers of [
      {},
      { origin: "null" },
      { origin: "https://evil.test" },
      { origin: "http://localhost:3020" },
      { origin: "https://evil.test", "x-forwarded-host": "evil.test" },
    ]) {
      expect(await verify(req("POST", headers))).toMatchObject({ ok: false, status: 403 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await verify(req("POST", { origin: appOrigin }))).ok).toBe(true);
  });
  it("accepts bearer mutations without browser Origin, but refuses a foreign Origin", async () => {
    const native = (origin?: string) =>
      new Request(`${appOrigin}/api/content`, {
        method: "POST",
        headers: {
          authorization: "Bearer 11111111-1111-4111-8111-111111111111",
          ...(origin ? { origin } : {}),
        },
      });
    expect((await verify(native())).ok).toBe(true);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer 11111111-1111-4111-8111-111111111111",
    );
    expect(await verify(native("https://evil.test"))).toMatchObject({ ok: false, status: 403 });
  });
  it("fails closed on invalid identity shapes, redirects, and provider failures", async () => {
    for (const body of [
      { ...identity, version: 2 },
      { ...identity, id: "spoof" },
      { ...identity, roles: "SUPER_ADMIN" },
      { ...identity, email: "unexpected@example.test" },
    ]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      expect(await verify()).toMatchObject({ ok: false, status: 503 });
    }
    fetchImpl.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://evil.test" } }),
    );
    expect(await verify()).toMatchObject({ ok: false, status: 503 });
    fetchImpl.mockRejectedValueOnce(Error("private token failure"));
    expect(await verify()).toEqual({ ok: false, status: 503, error: "identity_unavailable" });
  });
  it("also bounds a response that never finishes its body", async () => {
    const response = Response.json(identity);
    vi.spyOn(response, "text").mockImplementationOnce(async () => new Promise(() => {}));
    fetchImpl.mockResolvedValueOnce(response);
    expect(await verify(req(), { timeoutMs: 20 })).toEqual({
      ok: false,
      status: 503,
      error: "identity_unavailable",
    });
  });
  it("bounds a hung identity fetch with a timeout and abort signal", async () => {
    fetchImpl.mockImplementationOnce(async () => new Promise(() => {}));
    const started = Date.now();
    expect(await verify(req(), { timeoutMs: 20 })).toEqual({
      ok: false,
      status: 503,
      error: "identity_unavailable",
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

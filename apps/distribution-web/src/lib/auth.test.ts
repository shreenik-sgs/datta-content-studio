import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("@satsang/distribution-db", () => ({ readStudioSession: m.session }));
import { studioSessionToken, verifyDistributionOperator } from "./auth";
const options = { featureEnabled: true, stage: "TEST", appOrigin: "http://localhost:3070" };
const token = "a".repeat(64);
const request = (
  cookie = `dcs_session=${token}`,
  method = "GET",
  origin = "http://localhost:3070",
) => new Request("http://localhost:3070/distribution", { method, headers: { cookie, origin } });
beforeEach(() => {
  vi.clearAllMocks();
  m.session.mockResolvedValue({
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    roles: ["CONTENT_COORDINATOR"],
    isTest: true,
    locale: "en",
    displayName: "Curator",
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("independent Content Studio identity", () => {
  it("refuses Sannidhi cookies and client-supplied roles", async () => {
    expect(
      await verifyDistributionOperator(request(`ds_session=${token};roles=SUPER_ADMIN`), options),
    ).toMatchObject({ ok: false, status: 401 });
    expect(m.session).not.toHaveBeenCalled();
  });
  it("rejects ambiguous and malformed session cookies", () => {
    expect(studioSessionToken(request(`dcs_session=${token};dcs_session=${token}`))).toBeNull();
    expect(studioSessionToken(request("dcs_session=bad"))).toBeNull();
  });
  it("validates same-origin writes before any identity lookup", async () => {
    expect(
      await verifyDistributionOperator(
        request(undefined, "POST", "https://attacker.test"),
        options,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(m.session).not.toHaveBeenCalled();
  });
  it("rechecks active sessions and refuses cross-world identities", async () => {
    expect((await verifyDistributionOperator(request(), options)).ok).toBe(true);
    m.session.mockResolvedValueOnce(null);
    expect(await verifyDistributionOperator(request(), options)).toMatchObject({ status: 401 });
    m.session.mockResolvedValueOnce({ roles: ["CONTENT_COORDINATOR"], isTest: false });
    expect(await verifyDistributionOperator(request(), options)).toMatchObject({ status: 403 });
    expect(await verifyDistributionOperator(request(), { ...options, stage: "ON" })).toMatchObject({
      status: 403,
    });
  });
  it("does not contact another app or leak identity-store failures", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    m.session.mockRejectedValueOnce(Error("private database credentials"));
    expect(await verifyDistributionOperator(request(), options)).toEqual({
      ok: false,
      status: 503,
      error: "identity_unavailable",
    });
    expect(network).not.toHaveBeenCalled();
  });
});

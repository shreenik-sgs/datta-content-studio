import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  identity: vi.fn(),
  repository: vi.fn(),
  capabilities: vi.fn(),
  pool: vi.fn(),
  store: vi.fn(),
}));
vi.mock("@satsang/distribution-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@satsang/distribution-db")>()),
  createDistributionRepository: m.repository,
  readStudioSession: m.identity,
}));
vi.mock("pg", () => ({
  Pool: class {
    constructor() {
      m.pool();
    }
  },
}));
vi.mock("@satsang/distribution-assets", () => ({ createAssetStore: m.store }));
import { access, privateAssets } from "./runtime";
const identity = {
  version: 1,
  id: "11111111-1111-4111-8111-111111111111",
  roles: ["SUPER_ADMIN"],
  isTest: true,
  locale: "en",
  displayName: "Operator",
};
const app = "http://localhost:3070";
const fetchSpy = vi.fn<typeof fetch>();
const request = (method = "GET", headers: Record<string, string> = {}) =>
  new Request(`${app}/api/content`, {
    method,
    headers: { cookie: `dcs_session=${"a".repeat(64)}`, ...headers },
  });
describe("DS-DIST-R1-AUTH independent identity and Hub composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DISTRIBUTION_HUB_ENABLED", "true");
    vi.stubEnv("DISTRIBUTION_HUB_STAGE", "TEST");
    vi.stubEnv("STUDIO_DESTINATION_ORIGIN", "http://localhost:3020");
    vi.stubEnv("DISTRIBUTION_APP_ORIGIN", app);
    vi.stubEnv("DISTRIBUTION_DATABASE_URL", "postgres://unused-local-test");
    vi.stubGlobal("fetch", fetchSpy);
    fetchSpy.mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith("/distribution-policy") ? { version: 1, enabled: true } : identity,
      ),
    );
    m.identity.mockResolvedValue(identity);
    m.repository.mockReturnValue({ capabilities: m.capabilities });
    m.capabilities.mockResolvedValue(["content.create"]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("composes the configured storage backend without silently falling back", () => {
    vi.stubEnv("DISTRIBUTION_ASSET_BACKEND", "s3");
    vi.stubEnv("DISTRIBUTION_S3_PREFIX", "test/");
    m.store.mockImplementationOnce(() => {
      throw new Error("INVALID_S3_CONFIG");
    });
    expect(() => privateAssets({ isTest: true })).toThrow("INVALID_S3_CONFIG");
    expect(m.store).toHaveBeenCalledExactlyOnceWith(process.env);
  });
  it("refuses cross-world S3 access before constructing a storage client", () => {
    vi.stubEnv("DISTRIBUTION_ASSET_BACKEND", "s3");
    vi.stubEnv("DISTRIBUTION_HUB_STAGE", "ON");
    vi.stubEnv("DISTRIBUTION_S3_PREFIX", "production/");
    expect(() => privateAssets({ isTest: true })).toThrow("ASSET_WORLD_MISMATCH");
    vi.stubEnv("DISTRIBUTION_S3_PREFIX", "test/");
    expect(() => privateAssets({ isTest: false })).toThrow("ASSET_WORLD_MISMATCH");
    expect(m.store).not.toHaveBeenCalled();
  });
  it("DS-DIST-R1-AUTH reaches no DB or file boundary when disabled or unauthenticated", async () => {
    vi.stubEnv("DISTRIBUTION_HUB_ENABLED", "false");
    const disabled = await access(request());
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.response.status).toBe(404);
    vi.stubEnv("DISTRIBUTION_HUB_ENABLED", "true");
    const denied = await access(new Request(`${app}/api/content`));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.repository).not.toHaveBeenCalled();
    expect(m.pool).not.toHaveBeenCalled();
    expect(m.store).not.toHaveBeenCalled();
  });
  it("denies direct API access before Hub DB or storage when its own service switch is OFF", async () => {
    vi.stubEnv("DISTRIBUTION_HUB_ENABLED", "false");
    const denied = await access(request(), "content.create");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(404);
    expect(m.repository).not.toHaveBeenCalled();
    expect(m.store).not.toHaveBeenCalled();
  });
  it("DS-DIST-R1-AUTH refuses wrong-origin mutations before DB/file or core lookup", async () => {
    const denied = await access(
      request("POST", { origin: "http://localhost:3020", "x-forwarded-host": "localhost:3020" }),
      "content.create",
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.repository).not.toHaveBeenCalled();
    expect(m.store).not.toHaveBeenCalled();
  });
  it("DS-DIST-R1-AUTH ignores spoofed headers and refuses current nonadmin identity before DB", async () => {
    m.identity.mockResolvedValueOnce({ ...identity, roles: ["PRACTITIONER"] });
    const denied = await access(request("GET", { "x-roles": "TECH_SUPER_ADMIN" }));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
    expect(m.repository).not.toHaveBeenCalled();
    expect(m.store).not.toHaveBeenCalled();
  });
  it("DS-DIST-R1-AUTH requires an explicit matching grant and rereads it each request", async () => {
    expect((await access(request(), "content.create")).ok).toBe(true);
    expect(m.capabilities).toHaveBeenLastCalledWith({
      userId: identity.id,
      isTest: true,
      roles: identity.roles,
    });
    const wrongGrant = await access(request(), "content.review");
    expect(wrongGrant.ok).toBe(false);
    if (!wrongGrant.ok) expect(wrongGrant.response.status).toBe(403);
    m.capabilities.mockResolvedValueOnce([]);
    const revoked = await access(request());
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(m.identity).toHaveBeenCalledTimes(3);
    expect(m.capabilities).toHaveBeenCalledTimes(3);
  });
  it("DS-DIST-R1-AUTH masks repository outages and never reads the asset store", async () => {
    m.capabilities.mockRejectedValueOnce(Error("postgres://secret:password@internal"));
    const result = await access(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.json()).toEqual({ error: "unavailable" });
    }
    expect(m.store).not.toHaveBeenCalled();
  });
});

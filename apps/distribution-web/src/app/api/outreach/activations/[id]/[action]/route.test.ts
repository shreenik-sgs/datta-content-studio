import { buildDerivedAssetNames } from "@satsang/distribution-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  get: vi.fn(),
  approve: vi.fn(),
  stop: vi.fn(),
  getExport: vi.fn(),
  check: vi.fn(),
  read: vi.fn(),
  nativePolicy: vi.fn(),
  packageEnabled: vi.fn(),
  canonicalCheck: vi.fn(),
  validateDestination: vi.fn(),
  revisePackage: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("../../../../../../lib/runtime", () => ({
  access: mocks.access,
  privateAssets: () => ({ readDerivedDescriptor: mocks.read }),
}));
vi.mock("../../../../../../lib/outreach-runtime", () => ({ activationRepository: () => mocks }));
vi.mock("../../../../../../lib/destination-status", () => ({
  checkDistributionDestinations: mocks.check,
  checkDistributionCanonicalDestinations: mocks.canonicalCheck,
  socialPackageEnabled: mocks.packageEnabled,
}));
vi.mock("../../../../../../lib/native-render-policy", () => ({
  requireNativeRenderPolicy: mocks.nativePolicy,
}));
vi.mock("../../../../../../lib/activation-events", () => ({
  enqueueDestinationValidation: mocks.enqueue,
}));
import { GET, POST } from "./route";
const id = "40919b6e-8c9c-45eb-b569-3e380a484ad5";
const ctx = { userId: "operator", isTest: true };
const cta = {
  destination: { path: "/practice/flute-meditation", requiresIdentity: true },
  fallback: { path: "/practice/koti-parayana", requiresIdentity: true },
};
const a = {
  id,
  masterId: id,
  sourceVersionId: id,
  channel: "manual_export",
  revision: 2,
  pinnedCta: cta,
  token: "x".repeat(43),
  linkBinding: { cta },
};
const renderContext = {
  masterId: id,
  sourceVersionId: id,
  recipe: { aspect: "9:16", language: "en", channel: "manual_export" },
};
const descriptor = {
  storageKey: "private",
  sha256: "a".repeat(64),
  byteSize: 1,
  mimeType: "video/mp4",
};
const artifact = {
  id,
  revision: 2,
  recipeSha256: "b".repeat(64),
  output: {
    video: descriptor,
    captions: null,
    manifest: { ...descriptor, mimeType: "application/json" },
  },
};
const params = (action = "approve") => ({ params: Promise.resolve({ id, action }) });
const req = (body: unknown) =>
  new Request("http://localhost:3070/distribution/api/outreach/activations/test/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
describe("DS-DIST-R4 manual activation HTTP boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.access.mockResolvedValue({ ok: true, context: ctx });
    mocks.packageEnabled.mockResolvedValue(false);
    mocks.nativePolicy.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue(a);
    mocks.check.mockResolvedValue({
      version: 1,
      isTest: true,
      checkedAt: new Date().toISOString(),
      results: [],
    });
    mocks.approve.mockResolvedValue(a);
    mocks.getExport.mockResolvedValue({ activation: a, artifact, renderContext });
    mocks.read.mockImplementation(async (d) =>
      d.mimeType === "application/json"
        ? Buffer.from('{"recipe":{},"renderer":{}}')
        : Buffer.from("x"),
    );
  });
  it("DS-DIST-R4-ACTIVATION refuses anonymous or forged approval metadata", async () => {
    mocks.access.mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    expect((await POST(req({ expectedRevision: 1 }), params())).status).toBe(401);
    expect(mocks.check).not.toHaveBeenCalled();
    expect(
      (await POST(req({ expectedRevision: 1, destinations: { forged: true } }), params())).status,
    ).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it("DS-DIST-R4-DESTINATION approves only after server-scoped exact destination checks", async () => {
    expect((await POST(req({ expectedRevision: 1 }), params())).status).toBe(200);
    expect(mocks.access).toHaveBeenCalledWith(expect.any(Request), "content.review");
    expect(mocks.check).toHaveBeenCalledWith(expect.any(Request), [
      cta.destination.path,
      cta.fallback.path,
    ]);
    expect(mocks.approve).toHaveBeenCalledWith(ctx, id, {
      expectedRevision: 1,
      destinations: expect.objectContaining({ isTest: true }),
    });
  });
  it("requires a full package when the new flags are on and never bypasses native source review", async () => {
    mocks.packageEnabled.mockResolvedValue(true);
    expect((await POST(req({ expectedRevision: 1 }), params())).status).toBe(409);
    expect(mocks.approve).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue({ ...a, derivativeId: id, reviewPackage: {} });
    mocks.nativePolicy.mockRejectedValue(Error("NATIVE_APPROVAL_REQUIRED"));
    expect((await POST(req({ expectedRevision: 1 }), params())).status).not.toBe(200);
    expect(mocks.canonicalCheck).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it("tests only server-fetched v2 evidence and emits attribution only after persistence succeeds", async () => {
    const reviewed = { ...a, derivativeId: id, reviewPackage: {} };
    const evidence = { version: 2, isTest: true, results: [] };
    mocks.get.mockResolvedValue(reviewed);
    mocks.canonicalCheck.mockResolvedValue(evidence);
    mocks.validateDestination.mockResolvedValue(reviewed);
    expect(
      (
        await POST(
          req({ expectedRevision: 1, destinations: evidence }),
          params("validate-destination"),
        )
      ).status,
    ).toBe(400);
    expect(mocks.validateDestination).not.toHaveBeenCalled();
    expect((await POST(req({ expectedRevision: 1 }), params("validate-destination"))).status).toBe(
      200,
    );
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.validateDestination).toHaveBeenCalledWith(ctx, id, {
      expectedRevision: 1,
      destinations: evidence,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(reviewed);
    mocks.enqueue.mockClear();
    mocks.validateDestination.mockRejectedValue(Error("REVISION_CONFLICT"));
    expect((await POST(req({ expectedRevision: 1 }), params("validate-destination"))).status).toBe(
      409,
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("DS-DIST-R4-STOP stops without destination service and refuses stale approval", async () => {
    mocks.check.mockRejectedValue(Error("DESTINATION_UNAVAILABLE"));
    expect((await POST(req({ expectedRevision: 2 }), params())).status).toBe(409);
    expect(mocks.approve).not.toHaveBeenCalled();
    mocks.stop.mockResolvedValue({ ...a, status: "STOPPED" });
    expect((await POST(req({ expectedRevision: 2 }), params("stop"))).status).toBe(200);
  });
  it("DS-DIST-R4-EXPORT checks permission and dependencies again after asset IO", async () => {
    mocks.getExport
      .mockResolvedValueOnce({ activation: a, artifact, renderContext })
      .mockRejectedValueOnce(Error("ACTIVATION_DEPENDENCY_CHANGED"));
    const response = await GET(new Request("http://localhost:3070/export"), params("export"));
    expect(response.status).toBe(409);
    expect(mocks.getExport).toHaveBeenNthCalledWith(
      1,
      ctx,
      id,
      expect.objectContaining({ recordAudit: false }),
    );
    expect(mocks.getExport).toHaveBeenNthCalledWith(
      2,
      ctx,
      id,
      expect.objectContaining({ recordAudit: true }),
    );
  });
  it("DS-DIST-R4-EXPORT emits private no-store package with pinned invitation", async () => {
    const response = await GET(new Request("http://localhost:3070/export"), params("export"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-tar");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.access).toHaveBeenCalledTimes(2);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toContain(`/outreach/${a.token}`);
  });
  it("names every downloaded entry for the reviewed destination rather than the manual transport", async () => {
    const activation = { ...a, reviewPackage: { channel: "youtube_shorts" } };
    mocks.get.mockResolvedValue(activation);
    mocks.getExport.mockResolvedValue({ activation, artifact, renderContext });
    const response = await GET(new Request("http://localhost:3070/export"), params("export"));
    expect(response.status).toBe(200);
    const names = buildDerivedAssetNames({
      masterId: id,
      sourceVersionId: id,
      derivationId: id,
      destination: "youtube_shorts",
      language: "en",
      aspect: "9:16",
    });
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${names.archive}"`,
    );
    const archive = Buffer.from(await response.arrayBuffer()).toString();
    expect(archive).toContain(names.video);
    expect(archive).toContain(names.manifest);
    expect(archive).toContain('"channel": "youtube_shorts"');
    expect(archive).toContain('"transport": "manual_export"');
    expect(archive).not.toContain('"storageKey"');
    expect(archive).not.toContain(`SGS_m${id}_manual-export`);
  });
});

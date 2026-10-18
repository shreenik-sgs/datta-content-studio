import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  approveCampaign: vi.fn(),
  updateCampaign: vi.fn(),
  stopCampaign: vi.fn(),
  approveCta: vi.fn(),
}));
vi.mock("../../../../../../lib/runtime", () => ({ access: mocks.access }));
vi.mock("../../../../../../lib/outreach-runtime", () => ({ outreachRepository: () => mocks }));
import { POST } from "./route";
const id = "40919b6e-8c9c-45eb-b569-3e380a484ad5";
const context = { userId: "reviewer", isTest: true };
const request = (body: unknown) =>
  new Request("http://localhost:3070/distribution/api/outreach/campaign/test/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (kind = "campaign", action = "approve") => ({
  params: Promise.resolve({ id, kind, action }),
});
describe("DS-DIST-R4 authored command HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.access.mockResolvedValue({ ok: true, context });
  });
  it("DS-DIST-R4-CAMPAIGN rejects unauthenticated work before persistence", async () => {
    mocks.access.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "sign_in_required" }, { status: 401 }),
    });
    expect((await POST(request({ expectedRevision: 1 }), params())).status).toBe(401);
    expect(mocks.approveCampaign).not.toHaveBeenCalled();
  });
  it("DS-DIST-R4-CAMPAIGN explicit approval requires review capability and server-owned reviewer", async () => {
    mocks.approveCampaign.mockResolvedValue({ id, revision: 2, status: "APPROVED" });
    expect((await POST(request({ expectedRevision: 1 }), params())).status).toBe(200);
    expect(mocks.access).toHaveBeenCalledWith(expect.any(Request), "content.review");
    expect(mocks.approveCampaign).toHaveBeenCalledWith(context, id, { expectedRevision: 1 });
    expect(
      (await POST(request({ expectedRevision: 2, reviewerId: "forged" }), params())).status,
    ).toBe(400);
    expect(mocks.approveCampaign).toHaveBeenCalledTimes(1);
  });
  it("DS-DIST-R4-CAMPAIGN stale approval returns conflict and stop reason stays bounded", async () => {
    mocks.approveCampaign.mockRejectedValue(new Error("REVISION_CONFLICT"));
    expect((await POST(request({ expectedRevision: 1 }), params())).status).toBe(409);
    mocks.stopCampaign.mockRejectedValue(new Error("CAMPAIGN_STOPPED"));
    const stopped = await POST(request({ expectedRevision: 1 }), params("campaign", "stop"));
    expect(stopped.status).toBe(409);
    expect(await stopped.json()).toEqual({ error: "CAMPAIGN_STOPPED" });
  });
  it("DS-DIST-R4-DESTINATION no generic fallback or arbitrary external destination can be saved", async () => {
    const value = {
      expectedRevision: 1,
      intent: "MEDITATE",
      copy: "Meditate",
      language: "en",
      destination: { path: "/practice/flute-meditation", requiresIdentity: true },
      fallback: { path: "/home", requiresIdentity: true },
    };
    expect((await POST(request(value), params("cta", "edit"))).status).toBe(400);
    expect(
      (
        await POST(
          request({
            ...value,
            destination: { path: "https://evil.example", requiresIdentity: false },
            fallback: { path: "/practice/koti-parayana", requiresIdentity: true },
          }),
          params("cta", "edit"),
        )
      ).status,
    ).toBe(400);
  });
});

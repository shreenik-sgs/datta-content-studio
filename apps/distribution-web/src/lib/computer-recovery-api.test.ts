import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ access: vi.fn(), computerRecoveryRequest: vi.fn(), list: vi.fn() }));
vi.mock("./runtime", () => ({ access: m.access, distributionPool: vi.fn() }));
vi.mock("./import-verification", () => ({ computerRecoveryRequest: m.computerRecoveryRequest }));
vi.mock("@satsang/distribution-db", () => ({
  createOnlineImportRepository: () => m,
  createStudioRoleAuthority: vi.fn(),
}));
import { POST } from "../app/api/content/import/[id]/computer-recovery/route";
import { GET } from "../app/api/content/import/[id]/recovery-info/route";
import { studioLoginReturnPath } from "./auth";
const id = "2eb8dfae-1493-4900-ab9c-a6e6d8813696";
const route = { params: Promise.resolve({ id }) };
const context = { userId: "curator", isTest: true, roles: ["CONTENT_COORDINATOR"] };
const request = (data: unknown) =>
  new Request("http://localhost:3070", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ ok: true, context });
  for (const [key, value] of Object.entries({
    STUDIO_IDENTITY: "gbadpt",
    DISTRIBUTION_HUB_STAGE: "TEST",
    DISTRIBUTION_HUB_ENABLED: "true",
    STUDIO_COMPUTER_RECOVERY_ENABLED: "true",
    DISTRIBUTION_APP_ORIGIN: "http://localhost:3070",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());
it("uses authenticated identity, rejects extra targets and gates execution to localhost", async () => {
  m.computerRecoveryRequest.mockResolvedValue({ status: "RUNNING" });
  expect(
    (await POST(request({ action: "start", username: "Curator", password: "secret" }), route))
      .status,
  ).toBe(200);
  expect(m.computerRecoveryRequest).toHaveBeenCalledWith(context, id, {
    action: "start",
    username: "Curator",
    password: "secret",
  });
  expect(
    (
      await POST(
        request({
          action: "start",
          username: "Curator",
          password: "secret",
          origin: "https://evil.test",
        }),
        route,
      )
    ).status,
  ).toBe(400);
  vi.stubEnv("DISTRIBUTION_APP_ORIGIN", "https://gbadpt.sgsdattasannidhi.org");
  expect((await POST(request({ action: "status" }), route)).status).toBe(403);
});
it("refuses Approvers and returns only the saved playlist from GBADPT TEST", async () => {
  m.access.mockResolvedValueOnce({ ok: false, response: Response.json({}, { status: 403 }) });
  expect((await POST(request({ action: "status" }), route)).status).toBe(403);
  expect(m.computerRecoveryRequest).not.toHaveBeenCalled();
  vi.stubEnv("DISTRIBUTION_APP_ORIGIN", "https://gbadpt.sgsdattasannidhi.org");
  m.list.mockResolvedValue([
    { id, childIds: ["child"], curation: { saved: true } },
    { id: "child" },
  ]);
  const response = await GET(new Request("http://localhost"), route);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    identity: "gbadpt",
    isTest: true,
    children: [{ id: "child" }],
  });
  m.access.mockResolvedValueOnce({ ok: true, context: { ...context, isTest: false } });
  expect((await GET(new Request("http://localhost"), route)).status).toBe(403);
  expect(m.access).toHaveBeenCalledWith(expect.any(Request), "content.create");
});
it("does not introduce an open redirect after local sign-in", () => {
  expect(studioLoginReturnPath(`/distribution/recover?bundle=${id}`)).toBe(
    `/distribution/recover?bundle=${id}`,
  );
  for (const value of [
    "//evil.test",
    "https://evil.test",
    "/distribution/recover?next=https://evil.test",
    "/distribution/recover/../../../",
  ])
    expect(studioLoginReturnPath(value)).toBe("/distribution");
});

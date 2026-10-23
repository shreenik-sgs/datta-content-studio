import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  access: vi.fn(),
  get: vi.fn(),
  history: vi.fn(),
  config: vi.fn(),
  scan: vi.fn(),
}));
vi.mock("./runtime", () => ({ access: m.access }));
vi.mock("./studio-runtime", () => ({
  studioRepository: () => ({ get: m.get, checkPostingHistory: m.history }),
  studioJson: (r: Request) => r.json(),
  studioProblem: () => Response.json({ error: "FORBIDDEN" }, { status: 403 }),
}));
vi.mock("@satsang/distribution-db", () => ({
  loadStudioProviderConfig: m.config,
  studioSettingsPath: (_env: unknown, isTest: boolean) => (isTest ? "TEST" : "LIVE"),
  studioYoutubeHistory: m.scan,
}));
import { POST } from "../app/api/studio/[id]/posting-check/route";
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const request = () =>
  new Request(`http://localhost:3070/distribution/api/studio/${id}/posting-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "guru" }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.access.mockResolvedValue({ ok: true, context: { isTest: true, userId: "curator" } });
  m.get.mockResolvedValue({
    outputs: [
      {
        id: "output",
        channel: "youtube",
        title: "Learning patience every day",
        body: "",
        asset: null,
      },
    ],
  });
  m.history.mockResolvedValue({});
  m.config.mockResolvedValue({
    accounts: [
      {
        id: "guru",
        platform: "youtube",
        providerAccountId: "buffer-id",
        accessToken: "secret-token",
      },
    ],
  });
  m.scan.mockResolvedValue({
    destination: "youtube:canonical",
    posts: [],
    checkedAt: "2026-10-23T00:00:00Z",
  });
});
it("reads draft history in the correct world without leaking credentials or publishing", async () => {
  const r = await POST(request(), { params: Promise.resolve({ id }) });
  const body = await r.json();
  expect(r.status).toBe(200);
  expect(body.checks.output.scanned).toBe(0);
  expect(body.checks.output.error).toBeNull();
  expect(JSON.stringify(body)).not.toContain("secret");
  expect(m.config).toHaveBeenCalledWith("TEST");
});
it("rejects unauthorized callers before channel access", async () => {
  m.access.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
  expect((await POST(request(), { params: Promise.resolve({ id }) })).status).toBe(401);
  expect(m.scan).not.toHaveBeenCalled();
});
it("requires package access before channel checks", async () => {
  m.get.mockRejectedValue(Error("FORBIDDEN"));
  expect((await POST(request(), { params: Promise.resolve({ id }) })).status).toBe(403);
  expect(m.scan).not.toHaveBeenCalled();
});
it("does not report no duplicates when the external scan fails", async () => {
  m.scan.mockRejectedValue(Error("secret diagnostics"));
  const body = await (await POST(request(), { params: Promise.resolve({ id }) })).json();
  expect(body.checks.output.error).toBe("STUDIO_POSTING_CHECK_UNAVAILABLE");
  expect(JSON.stringify(body)).not.toContain("secret");
});

it("refuses an account outside the configured environment", async () => {
  m.config.mockResolvedValue({ accounts: [] });
  expect((await POST(request(), { params: Promise.resolve({ id }) })).status).toBe(403);
  expect(m.scan).not.toHaveBeenCalled();
});

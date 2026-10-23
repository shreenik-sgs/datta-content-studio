import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn(), config: vi.fn(), scan: vi.fn() }));
vi.mock("./runtime", () => ({ access: m.access }));
vi.mock("./studio-runtime", () => ({
  studioRepository: () => ({ list: m.list }),
  studioJson: (request: Request) => request.json(),
  studioProblem: () => Response.json({ error: "REQUEST_REFUSED" }, { status: 400 }),
}));
vi.mock("@satsang/distribution-db", () => ({
  loadStudioProviderConfig: m.config,
  studioSettingsPath: (_env: unknown, isTest: boolean) => (isTest ? "TEST" : "LIVE"),
  studioYoutubeHistory: m.scan,
}));
import { POST } from "../app/api/studio/playlist-posting-check/route";

const playlistId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const context = { isTest: true, userId: "curator" };
const request = (body: unknown = { playlistId, accountId: "guru" }) =>
  new Request("http://localhost:3070/distribution/api/studio/playlist-posting-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ ok: true, context });
  m.list.mockResolvedValue(
    Array.from({ length: 95 }, (_, index) => ({
      id: `package-${index}`,
      revision: 3,
      outputs: [
        {
          id: `output-${index}`,
          channel: "youtube",
          title: "Learn patience every day",
          body: "",
          asset: null,
        },
      ],
    })),
  );
  m.config.mockResolvedValue({
    accounts: [
      {
        id: "guru",
        platform: "youtube",
        providerAccountId: "buffer-id",
        accessToken: "private-token",
      },
    ],
  });
  m.scan.mockResolvedValue({
    destination: "youtube:canonical",
    posts: [],
    checkedAt: "2026-10-23T00:00:00Z",
  });
});

it("checks an entire bundle with one external inventory read and provides snapshot revisions", async () => {
  const response = await POST(request());
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(m.list).toHaveBeenCalledExactlyOnceWith(context, { playlistId });
  expect(m.scan).toHaveBeenCalledTimes(1);
  expect(m.config).toHaveBeenCalledExactlyOnceWith("TEST");
  expect(Object.keys(body.checks)).toHaveLength(95);
  expect(body.revisions["package-94"]).toBe(3);
  expect(body.checks["output-94"]).toMatchObject({ error: null, matches: [], scanned: 0 });
  expect(JSON.stringify(body)).not.toContain("private-token");
});

it("authenticates before reading packages or channel credentials", async () => {
  m.access.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
  expect((await POST(request())).status).toBe(401);
  expect(m.list).not.toHaveBeenCalled();
  expect(m.config).not.toHaveBeenCalled();
  expect(m.scan).not.toHaveBeenCalled();
});

it("requires package-list access before reading the channel", async () => {
  m.list.mockRejectedValue(Error("FORBIDDEN"));
  expect((await POST(request())).status).toBe(400);
  expect(m.config).not.toHaveBeenCalled();
  expect(m.scan).not.toHaveBeenCalled();
});

it("rejects arbitrary worlds, malformed IDs and missing series without a provider call", async () => {
  expect((await POST(request({ playlistId, accountId: "guru", isTest: false }))).status).toBe(400);
  expect((await POST(request({ playlistId: "invalid", accountId: "guru" }))).status).toBe(400);
  m.list.mockResolvedValue([]);
  expect((await POST(request())).status).toBe(400);
  expect(m.scan).not.toHaveBeenCalled();
});

it("refuses missing or pending channel connections in the selected environment", async () => {
  for (const accounts of [[], [{ id: "guru", platform: "youtube", connectionPending: true }]]) {
    m.config.mockResolvedValue({ accounts });
    expect((await POST(request())).status).toBe(400);
  }
  expect(m.scan).not.toHaveBeenCalled();
});

it("labels a metadata match as needing review rather than a confirmed upload", async () => {
  m.scan.mockResolvedValue({
    destination: "youtube:canonical",
    checkedAt: "2026-10-23T00:00:00Z",
    posts: [
      {
        id: "remote",
        title: "Learn patience every day",
        text: "",
        status: "sent",
        url: "https://www.youtube.com/watch?v=example",
        sentAt: "2026-10-22T00:00:00Z",
        assetSha256: null,
      },
    ],
  });
  const body = await (await POST(request())).json();
  expect(body.checks["output-0"].matches[0]).toMatchObject({
    state: "NEEDS_REVIEW",
    reason: "SIMILAR_METADATA",
  });
});

it.each(["STUDIO_POSTING_CHECK_INCOMPLETE", "private token diagnostics"])(
  "reports a failed check safely: %s",
  async (message) => {
    m.scan.mockRejectedValue(Error(message));
    const body = await (await POST(request())).json();
    expect(body.checks["output-0"].error).toBe(
      message === "STUDIO_POSTING_CHECK_INCOMPLETE" ? message : "STUDIO_POSTING_CHECK_UNAVAILABLE",
    );
    expect(JSON.stringify(body)).not.toContain("private token");
    expect(m.scan).toHaveBeenCalledTimes(1);
  },
);

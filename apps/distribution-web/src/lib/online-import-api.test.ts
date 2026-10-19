import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  access: vi.fn(),
  enqueue: vi.fn(),
  enqueueBundle: vi.fn(),
  retry: vi.fn(),
  list: vi.fn(),
  ready: vi.fn(),
  groupedMasters: vi.fn(),
  bundlesForMaster: vi.fn(),
}));
vi.mock("./runtime", () => ({ access: m.access, distributionPool: vi.fn() }));
vi.mock("@satsang/distribution-db", () => ({
  createOnlineImportRepository: () => m,
  createStudioRoleAuthority: vi.fn(),
}));
import { GET, POST } from "../app/api/content/import/route";
const context = { userId: "curator@example.test", isTest: true, roles: ["CONTENT_COORDINATOR"] };
const input = {
  action: "import",
  url: "https://www.youtube.com/watch?v=g0zlErdfXlg",
  language: "te",
  category: "pravachanams",
};
const request = (data: unknown) =>
  new Request("http://localhost/distribution/api/content/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ ok: true, context });
  m.ready.mockResolvedValue(true);
  m.enqueue.mockResolvedValue({ id: "import", status: "QUEUED" });
  m.list.mockResolvedValue([]);
  m.groupedMasters.mockResolvedValue([]);
});
it("requires Curator access and queues rather than downloading in the request", async () => {
  expect((await POST(request(input))).status).toBe(202);
  expect(m.access).toHaveBeenCalledWith(expect.any(Request), "content.create");
  expect(m.enqueue).toHaveBeenCalledWith(context, { ...input, includePlaylist: false });
});
it("does not accept an actor or world supplied by the browser", async () => {
  expect((await POST(request({ ...input, isTest: false, userId: "admin" }))).status).toBe(400);
  expect(m.enqueue).not.toHaveBeenCalled();
});
it("does not leave users queued behind an unavailable downloader", async () => {
  m.ready.mockResolvedValue(false);
  const response = await POST(request(input));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "ONLINE_IMPORT_DISABLED" });
  expect(m.enqueue).not.toHaveBeenCalled();
});
it("returns signed-in imports and current readiness", async () => {
  expect(await (await GET(new Request("http://localhost"))).json()).toEqual({
    items: [],
    groupedMasterIds: [],
    nextOffset: null,
    available: true,
  });
  expect(m.list).toHaveBeenCalledWith(context, { offset: 0, summaries: true });
});
it("returns the original authorization refusal before touching the queue", async () => {
  m.access.mockResolvedValue({
    ok: false,
    response: Response.json({ error: "FORBIDDEN" }, { status: 403 }),
  });
  expect((await POST(request(input))).status).toBe(403);
  expect(m.enqueue).not.toHaveBeenCalled();
});
it("sanitizes downloader errors instead of exposing signed URLs or provider text", async () => {
  m.enqueue.mockRejectedValue(Error("secret upstream address"));
  const response = await POST(request(input));
  expect(await response.text()).not.toContain("secret upstream");
});

it("fetches children only for the selected playlist and validates pagination", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  await GET(new Request(`http://localhost?rootId=${id}`));
  expect(m.list).toHaveBeenCalledWith(context, { rootId: id, offset: 0, summaries: false });
  m.list.mockClear();
  expect((await GET(new Request("http://localhost?offset=-1"))).status).toBe(400);
  expect(m.list).not.toHaveBeenCalled();
});

it("accepts a 60-link bundle through the same authenticated import endpoint", async () => {
  const data = {
    action: "import-bundle",
    title: "Sixty days",
    urls: Array.from(
      { length: 60 },
      (_, n) => `https://youtu.be/E${String(n).padStart(10, "0")}`,
    ).join("\n"),
    language: "te",
    category: "pravachanams",
  };
  m.enqueueBundle.mockResolvedValue({
    id: "bundle",
    status: "COMPLETE",
    source: { kind: "bundle" },
  });
  expect((await POST(request(data))).status).toBe(202);
  expect(m.enqueueBundle).toHaveBeenCalledWith(context, data);
  expect(m.enqueue).not.toHaveBeenCalled();
  m.enqueueBundle.mockClear();
  expect((await POST(request({ ...data, isTest: false }))).status).toBe(400);
  expect(m.enqueueBundle).not.toHaveBeenCalled();
});

it("looks up a recording's series without listing other sources or exposing another world", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const bundles = [{ id, title: "Series", recordings: 51 }];
  m.bundlesForMaster.mockResolvedValue(bundles);
  const response = await GET(new Request(`http://localhost?masterId=${id}`));
  expect(await response.json()).toEqual({ bundles });
  expect(m.bundlesForMaster).toHaveBeenCalledWith(context, id);
  expect(m.list).not.toHaveBeenCalled();
  expect(m.groupedMasters).not.toHaveBeenCalled();
  m.bundlesForMaster.mockClear();
  for (const query of [
    "masterId=invalid",
    `masterId=${id}&rootId=${id}`,
    `masterId=${id}&offset=20`,
  ])
    expect((await GET(new Request(`http://localhost?${query}`))).status).toBe(400);
  expect(m.bundlesForMaster).not.toHaveBeenCalled();
  m.access.mockResolvedValue({ ok: false, response: Response.json({}, { status: 403 }) });
  expect((await GET(new Request(`http://localhost?masterId=${id}`))).status).toBe(403);
  expect(m.bundlesForMaster).not.toHaveBeenCalled();
});

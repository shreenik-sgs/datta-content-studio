import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ access: vi.fn(), get: vi.fn(), edit: vi.fn() }));
vi.mock("./runtime", () => ({ access: m.access, privateAssets: vi.fn() }));
import { GET, POST } from "../app/api/content/[id]/[action]/route";
const id = "9f7324ac-893d-43ae-93bb-97692186b15d";
const ctx = { userId: "editor", isTest: true };
beforeEach(() => {
  vi.clearAllMocks();
  m.access.mockResolvedValue({
    ok: true,
    context: ctx,
    repo: { get: m.get, updateMetadata: m.edit },
  });
});
it("DS-DIST-R1 reloads exact selected content after stale revisions", async () => {
  m.get.mockResolvedValue({ id, revision: 5 });
  const response = await GET(new Request("http://localhost/distribution/api/content"), {
    params: Promise.resolve({ id, action: "detail" }),
  });
  expect(response.status).toBe(200);
  expect(m.get).toHaveBeenCalledWith(ctx, id);
  expect(await response.json()).toEqual({ content: { id, revision: 5 } });
});
it("DS-DIST-R1 metadata edits use the shared revision command", async () => {
  const input = { expectedRevision: 3, title: "New title", language: "te", category: "bhajans" };
  m.edit.mockResolvedValue({ id, revision: 4, state: "RIGHTS_CLEARED" });
  const response = await POST(
    new Request("http://localhost/distribution/api/content", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    { params: Promise.resolve({ id, action: "metadata" }) },
  );
  expect(response.status).toBe(200);
  expect(m.edit).toHaveBeenCalledWith(ctx, id, input);
});
it("DS-DIST-R1 metadata cannot forge approval", async () => {
  const response = await POST(
    new Request("http://localhost/distribution/api/content", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 3,
        title: "New title",
        language: "en",
        category: "bhajans",
        state: "APPROVED",
      }),
    }),
    { params: Promise.resolve({ id, action: "metadata" }) },
  );
  expect(response.status).toBe(400);
  expect(m.edit).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  access: vi.fn(),
  limit: vi.fn(),
  add: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  rolledBack: vi.fn(),
}));
vi.mock("./upload-policy", () => ({ masterUploadLimit: m.limit }));
vi.mock("./runtime", () => ({
  access: m.access,
  privateAssets: () => ({ write: m.write, removeUnreferenced: m.remove }),
}));
vi.mock("@satsang/distribution-db", () => ({
  distributionTransactionRolledBack: m.rolledBack,
}));
import { POST } from "../app/api/content/[id]/version/route";
const id = "9f7324ac-893d-43ae-93bb-97692186b15d";
const ctx = { userId: "editor", isTest: true };
const params = { params: Promise.resolve({ id }) };
const asset = {
  storageKey: "private",
  sha256: "a".repeat(64),
  byteSize: 3,
  mimeType: "audio/mpeg",
  originalName: "new.mp3",
};
function request(revision = "3") {
  const data = new FormData();
  data.set("expectedRevision", revision);
  data.set("file", new File(["ID3"], "new.mp3", { type: "audio/mpeg" }));
  return new Request("http://localhost/distribution/api/content", { method: "POST", body: data });
}
beforeEach(() => {
  vi.clearAllMocks();
  m.limit.mockResolvedValue(250 * 1024 * 1024);
  m.access.mockResolvedValue({ ok: true, context: ctx, repo: { addVersion: m.add } });
  m.write.mockResolvedValue(asset);
  m.remove.mockResolvedValue(undefined);
  m.rolledBack.mockReturnValue(false);
});
it("DS-DIST-R1 source replacement keeps revision authority on the server", async () => {
  m.add.mockResolvedValue({ id, revision: 4, state: "DRAFT" });
  expect((await POST(request(), params)).status).toBe(201);
  expect(m.add).toHaveBeenCalledWith(ctx, id, { expectedRevision: 3, asset });
});
it("DS-DIST-R1 a concurrent edit rolls back only the new unreferenced asset", async () => {
  m.add.mockRejectedValue(new Error("REVISION_CONFLICT"));
  m.rolledBack.mockReturnValueOnce(true);
  expect((await POST(request(), params)).status).toBe(409);
  expect(m.remove).toHaveBeenCalledWith(asset);
});
it.each(["COMMIT acknowledgement lost", "REVISION_CONFLICT"])(
  "DS-DIST-S3 retains version media without proven rollback: %s",
  async (message) => {
    m.add.mockRejectedValueOnce(new Error(message));
    expect((await POST(request(), params)).status).toBe(
      message === "REVISION_CONFLICT" ? 409 : 503,
    );
    expect(m.remove).not.toHaveBeenCalled();
  },
);
it("DS-DIST-S3 a revoked creator cannot save a replacement after upload", async () => {
  const auth = await m.access();
  m.access.mockResolvedValueOnce(auth).mockResolvedValueOnce({
    ok: false,
    response: new Response(null, { status: 403 }),
  });
  expect((await POST(request(), params)).status).toBe(403);
  expect(m.write).toHaveBeenCalledOnce();
  expect(m.add).not.toHaveBeenCalled();
  expect(m.remove).toHaveBeenCalledWith(asset);
});
it.each([{ userId: "another-creator" }, { isTest: false }])(
  "DS-DIST-S3 refuses a creator or world change before saving replacement metadata",
  async (change) => {
    const auth = await m.access();
    m.access
      .mockResolvedValueOnce(auth)
      .mockResolvedValueOnce({ ...auth, context: { ...ctx, ...change } });
    expect((await POST(request(), params)).status).toBe(403);
    expect(m.add).not.toHaveBeenCalled();
    expect(m.remove).toHaveBeenCalledWith(asset);
  },
);
it("DS-DIST-R1 malformed revision never stores replacement bytes", async () => {
  expect((await POST(request("no"), params)).status).toBe(400);
  expect(m.write).not.toHaveBeenCalled();
});
it("DS-DIST-R1 missing creator permission never reads an upload", async () => {
  m.access.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await POST(request(), params)).status).toBe(403);
  expect(m.write).not.toHaveBeenCalled();
});

it("enforces the configured limit on replacement uploads before storing bytes", async () => {
  m.limit.mockResolvedValue(2);
  const response = await POST(request(), params);
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: "UPLOAD_TOO_LARGE", maxMasterBytes: 2 });
  expect(m.write).not.toHaveBeenCalled();
});

import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./upload-policy", () => ({ masterUploadLimit: () => m.limit() }));
const m = vi.hoisted(() => ({
  access: vi.fn(),
  limit: vi.fn(),
  assets: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  rights: vi.fn(),
  approve: vi.fn(),
  withdraw: vi.fn(),
  getExport: vi.fn(),
  getAsset: vi.fn(),
  versions: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  rolledBack: vi.fn(),
  studioCreate: vi.fn(),
}));
vi.mock("./studio-runtime", () => ({
  studioRepository: () => ({ create: m.studioCreate }),
  publicStudioPackage: (value: unknown) => value,
}));
vi.mock("./runtime", () => ({ access: m.access, privateAssets: m.assets }));
vi.mock("@satsang/distribution-db", () => ({
  distributionTransactionRolledBack: m.rolledBack,
}));
import { GET as getAction, POST as postAction } from "../app/api/content/[id]/[action]/route";
import { POST as replaceContent } from "../app/api/content/[id]/version/route";
import { POST as createContent, GET as listContent } from "../app/api/content/route";
const id = "11111111-1111-4111-8111-111111111111";
const vid = "22222222-2222-4222-8222-222222222222";
const actor = "33333333-3333-4333-8333-333333333333";
const when = "2026-09-29T12:00:00.000Z";
const context = { userId: actor, isTest: true };
const asset = {
  storageKey: `distribution/masters/${vid}`,
  mimeType: "audio/mpeg",
  byteSize: 3,
  sha256: "a".repeat(64),
  originalName: "source.mp3",
};
const content = {
  id,
  title: "Sacred flute",
  language: "en",
  category: "sacred_flute",
  isTest: true,
  state: "APPROVED",
  revision: 3,
  currentVersion: {
    id: vid,
    masterId: id,
    number: 1,
    sha256: asset.sha256,
    byteSize: asset.byteSize,
    mimeType: asset.mimeType,
    originalName: asset.originalName,
    createdAt: when,
    createdBy: actor,
  },
  rights: {
    owner: "SGS",
    territories: ["WORLDWIDE"],
    channels: ["manual_export"],
    authorizationBasis: "Permission",
    privacyClass: "PUBLIC",
    releaseAt: null,
    expiresAt: null,
  },
  approval: { versionId: vid, approvedRevision: 3, reviewerId: actor, approvedAt: when },
  createdAt: when,
  updatedAt: when,
};
const params = (action: string, contentId = id) => ({
  params: Promise.resolve({ id: contentId, action }),
});
const send = (body: unknown = { expectedRevision: 3 }) =>
  new Request("http://localhost:3070/api/content", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const exportCommand = { expectedRevision: 3, channel: "manual_export", territory: "WORLDWIDE" };
function upload() {
  const form = new FormData();
  form.set("title", "Sacred flute");
  form.set("language", "en");
  form.set("category", "sacred_flute");
  form.set("file", new File(["ID3"], "source.mp3", { type: "audio/mpeg" }));
  return new Request("http://localhost:3070/api/content", { method: "POST", body: form });
}
describe("DS-DIST-R1 endpoint security and release lifecycle", () => {
  beforeEach(() => {
    m.limit.mockResolvedValue(250 * 1024 * 1024);
    vi.clearAllMocks();
    m.access.mockResolvedValue({
      ok: true,
      context,
      identity: { id: actor, locale: "en", displayName: "Operator" },
      capabilities: ["content.create", "content.review", "content.publish"],
      repo: {
        list: m.list,
        create: m.create,
        attestRights: m.rights,
        approve: m.approve,
        withdraw: m.withdraw,
        getExport: m.getExport,
        getAsset: m.getAsset,
        versions: m.versions,
      },
    });
    m.assets.mockReturnValue({ write: m.write, read: m.read, removeUnreferenced: m.remove });
    m.list.mockResolvedValue([]);
    m.write.mockResolvedValue(asset);
    m.create.mockResolvedValue(content);
    m.studioCreate.mockResolvedValue({ id: vid, status: "QUEUED" });
    m.read.mockResolvedValue(Buffer.from("ID3"));
    m.remove.mockResolvedValue(undefined);
    m.rolledBack.mockReturnValue(false);
    m.getExport.mockResolvedValue({ content, asset });
    m.getAsset.mockResolvedValue({ content, asset });
  });
  it.each([
    [{ owner: "   " }, "owner", "rights holder"],
    [{ authorizationBasis: "" }, "authorizationBasis", "authorized"],
    [{ territories: ["India"] }, "territories", "two-letter"],
    [{ channels: [] }, "channels", "at least one"],
    [{ territories: ["IN", "IN"] }, "territories", "duplicate"],
    [
      { releaseAt: "2026-10-12T10:00:00Z", expiresAt: "2026-10-11T10:00:00Z" },
      "expiresAt",
      "later",
    ],
  ])(
    "returns actionable permission field errors without saving: %j",
    async (override, field, message) => {
      const response = await postAction(
        send({ expectedRevision: 3, rights: { ...content.rights, ...override } }),
        params("rights"),
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.fields[field]).toContain(message);
      expect(m.rights).not.toHaveBeenCalled();
    },
  );
  it("streams a large master preview through bounded ranges with the existing authority recheck", async () => {
    const largeAsset = { ...asset, byteSize: 600 * 1024 * 1024 };
    const readRange = vi.fn(async (_asset, start: number, end: number) =>
      Buffer.alloc(end - start + 1, 1),
    );
    m.assets.mockReturnValue({ read: m.read, readRange });
    m.getAsset.mockResolvedValue({ content, asset: largeAsset });
    const response = await getAction(
      new Request("http://localhost:3070/api/content", { headers: { range: "bytes=100-1048676" } }),
      params("media"),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 100-1048676/${largeAsset.byteSize}`);
    expect((await response.arrayBuffer()).byteLength).toBe(1048676 - 100 + 1);
    expect(m.read).not.toHaveBeenCalled();
    expect(m.getAsset).toHaveBeenCalledTimes(2);
    expect(readRange).toHaveBeenCalledWith(largeAsset, 100, 1048676);
  });
  it("shares upload capacity with replacement uploads and releases it after completion", async () => {
    let entered = () => {};
    let unblock = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    m.write.mockImplementationOnce(async () => {
      entered();
      await pending;
      return asset;
    });
    const first = createContent(upload());
    try {
      await started;
      const second = upload();
      const refused = await replaceContent(second, { params: Promise.resolve({ id }) });
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: "UPLOAD_BUSY" });
      expect(second.bodyUsed).toBe(false);
      expect(m.write).toHaveBeenCalledTimes(1);
    } finally {
      unblock();
      expect((await first).status).toBe(201);
    }
    expect((await createContent(upload())).status).toBe(201);
  });
  it("enforces the configured maximum even when a client bypasses its form", async () => {
    m.limit.mockResolvedValue(2);
    const response = await createContent(upload());
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "UPLOAD_TOO_LARGE", maxMasterBytes: 2 });
    expect(m.write).not.toHaveBeenCalled();
  });
  it("DS-DIST-R1-AUTH returns auth refusal before any DB or file operation on every endpoint", async () => {
    m.access.mockImplementation(async () => ({
      ok: false,
      response: Response.json({ error: "sign_in_required" }, { status: 401 }),
    }));
    for (const response of [
      await listContent(new Request("http://localhost:3070/api/content")),
      await createContent(upload()),
      await postAction(send(), params("approve")),
      await getAction(new Request("http://localhost:3070/api/content"), params("media")),
    ])
      expect(response.status).toBe(401);
    expect(m.assets).not.toHaveBeenCalled();
    for (const fn of [m.list, m.create, m.approve, m.getAsset, m.getExport])
      expect(fn).not.toHaveBeenCalled();
  });
  it.each(["active", "withdrawn", "all"])(
    "passes the %s archive view into the paginated repository query",
    async (archive) => {
      const response = await listContent(
        new Request(
          `http://localhost:3070/api/content?archive=${archive}&offset=50&query=master&view=approvals`,
        ),
      );
      expect(response.status).toBe(200);
      expect(m.list).toHaveBeenCalledWith(context, {
        archive,
        offset: 50,
        limit: 50,
        query: "master",
        state: "RIGHTS_CLEARED",
      });
    },
  );
  it("preserves legacy list visibility and rejects unknown archive filters before listing", async () => {
    expect((await listContent(new Request("http://localhost:3070/api/content"))).status).toBe(200);
    expect(m.list).toHaveBeenCalledWith(context, expect.objectContaining({ archive: "all" }));
    m.list.mockClear();
    expect(
      (await listContent(new Request("http://localhost:3070/api/content?archive=deleted"))).status,
    ).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });
  it("DS-DIST-R1-ASSET rejects malformed multipart and oversized requests before storage", async () => {
    const malformed = new Request("http://localhost:3070/api/content", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=broken" },
      body: "not multipart",
    });
    expect((await createContent(malformed)).status).toBe(400);
    const oversized = new Request("http://localhost:3070/api/content", {
      method: "POST",
      headers: { "content-length": String(251 * 1024 * 1024) },
      body: "tiny",
    });
    expect((await createContent(oversized)).status).toBe(413);
    expect(m.assets).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });
  it("saves the master without starting generation before source permissions are recorded", async () => {
    const response = await createContent(upload());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ content });
    expect(m.studioCreate).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
  });
  it("accepts master uploads when the generation queue is unavailable", async () => {
    m.studioCreate.mockRejectedValueOnce(Error("private database credentials"));
    const response = await createContent(upload());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ content });
    expect(m.studioCreate).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
  });
  it("DS-DIST-R1-CONTENT rejects malformed JSON, oversized commands, invalid IDs and injected fields", async () => {
    const invalid = new Request("http://localhost:3070/api/content", { method: "POST", body: "{" });
    expect((await postAction(invalid, params("approve"))).status).toBe(400);
    const oversized = new Request("http://localhost:3070/api/content", {
      method: "POST",
      body: "x".repeat(17000),
    });
    expect((await postAction(oversized, params("approve"))).status).toBe(400);
    expect((await postAction(send(), params("approve", "../secret"))).status).toBe(400);
    expect(
      (await postAction(send({ expectedRevision: 3, isTest: false }), params("approve"))).status,
    ).toBe(400);
    expect(m.approve).not.toHaveBeenCalled();
    expect(m.assets).not.toHaveBeenCalled();
  });
  it("DS-DIST-R1-ASSET removes only the just-written orphan if a create loses its grant", async () => {
    m.create.mockRejectedValueOnce(Error("FORBIDDEN"));
    m.rolledBack.mockReturnValueOnce(true);
    const response = await createContent(upload());
    expect(response.status).toBe(403);
    expect(m.remove).toHaveBeenCalledWith(asset);
    expect(m.access).toHaveBeenCalledWith(expect.any(Request), "content.create");
    expect(m.assets).toHaveBeenCalledTimes(1);
  });
  it.each(["COMMIT acknowledgement lost", "FORBIDDEN"])(
    "DS-DIST-S3 retains uploaded media without proven rollback: %s",
    async (message) => {
      m.create.mockRejectedValueOnce(Error(message));
      const response = await createContent(upload());
      expect(response.status).toBe(message === "FORBIDDEN" ? 403 : 503);
      expect(m.remove).not.toHaveBeenCalled();
      expect(m.assets).toHaveBeenCalledTimes(1);
    },
  );
  it("DS-DIST-S3 cleanup failure preserves the original metadata rejection", async () => {
    m.create.mockRejectedValueOnce(Error("FORBIDDEN"));
    m.rolledBack.mockReturnValueOnce(true);
    m.remove.mockRejectedValueOnce(Error("private storage unavailable"));
    const response = await createContent(upload());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "FORBIDDEN" });
  });
  it("DS-DIST-S3 rechecks creator authority after upload and removes bytes when permission was revoked", async () => {
    const auth = await m.access();
    m.access.mockResolvedValueOnce(auth).mockResolvedValueOnce({
      ok: false,
      response: Response.json({ error: "FORBIDDEN" }, { status: 403 }),
    });
    const response = await createContent(upload());
    expect(response.status).toBe(403);
    expect(m.write).toHaveBeenCalledOnce();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.remove).toHaveBeenCalledWith(asset);
  });
  it.each([{ userId: "another-creator" }, { isTest: false }])(
    "DS-DIST-S3 refuses a creator or world change before saving uploaded metadata",
    async (change) => {
      const auth = await m.access();
      m.access
        .mockResolvedValueOnce(auth)
        .mockResolvedValueOnce({ ...auth, context: { ...context, ...change } });
      expect((await createContent(upload())).status).toBe(403);
      expect(m.create).not.toHaveBeenCalled();
      expect(m.remove).toHaveBeenCalledWith(asset);
    },
  );
  it("DS-DIST-R1-CONTENT returns stale approval and revoked grant errors without changing content", async () => {
    m.approve.mockRejectedValueOnce(Error("REVISION_CONFLICT"));
    expect((await postAction(send(), params("approve"))).status).toBe(409);
    m.approve.mockRejectedValueOnce(Error("FORBIDDEN"));
    expect((await postAction(send(), params("approve"))).status).toBe(403);
    expect(m.approve).toHaveBeenCalledWith(context, id, { expectedRevision: 3 });
    expect(m.assets).not.toHaveBeenCalled();
  });
  it("DS-DIST-R1-EXPORT refuses stale or forbidden exports before opening private bytes", async () => {
    for (const error of ["REVISION_CONFLICT", "APPROVAL_STALE", "FORBIDDEN", "RIGHTS_EXPIRED"]) {
      m.getExport.mockRejectedValueOnce(Error(error));
      expect((await postAction(send(exportCommand), params("export"))).status).toBe(
        error === "FORBIDDEN" ? 403 : 409,
      );
    }
    expect(m.assets).not.toHaveBeenCalled();
  });
  it("DS-DIST-R1-EXPORT checks withdrawal again after private file IO before responding", async () => {
    m.getExport.mockResolvedValueOnce({ content, asset }).mockRejectedValueOnce(Error("WITHDRAWN"));
    const response = await postAction(send(exportCommand), params("export"));
    expect(response.status).toBe(409);
    expect(m.read).toHaveBeenCalledWith(asset);
    expect(m.getExport).toHaveBeenCalledTimes(2);
    expect(response.headers.get("content-type")).not.toContain("tar");
  });
  it("DS-DIST-R1-EXPORT returns an authenticated noncached package from the approved version", async () => {
    const response = await postAction(send(exportCommand), params("export"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-tar");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="SGS_m${id}_source-v1.tar"`,
    );
    expect(m.getExport).toHaveBeenCalledTimes(2);
    expect(m.getExport.mock.calls[0]?.[2]).toMatchObject({ recordAudit: false });
    expect(m.getExport.mock.calls[1]?.[2]).toMatchObject({ recordAudit: true });
  });
  it("DS-DIST-R1-ASSET serves private single byte ranges and refuses invalid ranges", async () => {
    const response = await getAction(
      new Request("http://localhost:3070", { headers: { range: "bytes=1-2" } }),
      params("media"),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-2/3");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("D3");
    expect(m.read).toHaveBeenCalledWith(asset);
    for (const range of ["bytes=5-", "bytes=0-1,2-3", "bytes=-0", "bytes=2-1"]) {
      const refused = await getAction(
        new Request("http://localhost:3070", { headers: { range } }),
        params("media"),
      );
      expect(refused.status).toBe(416);
      expect(refused.headers.get("content-range")).toBe("bytes */3");
    }
    const suffix = await getAction(
      new Request("http://localhost:3070", { headers: { range: "bytes=-2" } }),
      params("media"),
    );
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("D3");
  });
  it("DS-DIST-R1-ASSET refuses bytes when the current source changes during file IO", async () => {
    m.getAsset.mockResolvedValueOnce({ content, asset }).mockResolvedValueOnce({
      content: { ...content, revision: 4 },
      asset: { ...asset, storageKey: "distribution/masters/replacement" },
    });
    expect((await getAction(new Request("http://localhost:3070"), params("media"))).status).toBe(
      409,
    );
  });
  it("DS-DIST-R1-ASSET rechecks withdrawal on preview and masks private storage failures", async () => {
    m.getAsset
      .mockResolvedValueOnce({ content, asset })
      .mockRejectedValueOnce(Error("CONTENT_WITHDRAWN"));
    expect((await getAction(new Request("http://localhost:3070"), params("media"))).status).toBe(
      409,
    );
    m.getAsset.mockResolvedValue({ content, asset });
    m.read.mockRejectedValueOnce(Error("EACCES /private/secret/key"));
    const response = await getAction(new Request("http://localhost:3070"), params("media"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
  it.each(["media", "export"])(
    "DS-DIST-S3 rechecks a revoked identity after storage IO for %s",
    async (action) => {
      const auth = await m.access();
      m.access.mockResolvedValueOnce(auth).mockResolvedValueOnce({
        ok: false,
        response: Response.json({ error: "operator_required" }, { status: 403 }),
      });
      const response =
        action === "media"
          ? await getAction(new Request("http://localhost:3070"), params(action))
          : await postAction(send(exportCommand), params(action));
      expect(response.status).toBe(403);
      expect(m.read).toHaveBeenCalledOnce();
      expect(action === "media" ? m.getAsset : m.getExport).toHaveBeenCalledOnce();
      expect(response.headers.get("content-type")).not.toMatch(/audio|tar/);
    },
  );
  it.each([
    ["media", { userId: "another-operator" }],
    ["media", { isTest: false }],
    ["export", { userId: "another-operator" }],
    ["export", { isTest: false }],
  ])(
    "DS-DIST-S3 refuses a changed identity or world after %s storage IO",
    async (action, change) => {
      const auth = await m.access();
      m.access
        .mockResolvedValueOnce(auth)
        .mockResolvedValueOnce({ ...auth, context: { ...context, ...change } });
      const response =
        action === "media"
          ? await getAction(new Request("http://localhost:3070"), params(action))
          : await postAction(send(exportCommand), params(action));
      expect(response.status).toBe(403);
      expect(action === "media" ? m.getAsset : m.getExport).toHaveBeenCalledOnce();
    },
  );
});

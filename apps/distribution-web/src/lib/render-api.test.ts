import { buildDerivedAssetNames } from "@satsang/distribution-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  access: vi.fn(),
  nativePolicy: vi.fn(),
  repository: vi.fn(),
  assets: vi.fn(),
  read: vi.fn(),
  listJobs: vi.fn(),
  listArtifacts: vi.fn(),
  enqueue: vi.fn(),
  getArtifact: vi.fn(),
  getArtifactExport: vi.fn(),
  reviewArtifact: vi.fn(),
}));
vi.mock("./native-render-policy", () => ({ requireNativeRenderPolicy: m.nativePolicy }));
vi.mock("./runtime", () => ({ access: m.access, privateAssets: m.assets }));
vi.mock("./render-runtime", async (original) => ({
  ...(await original<typeof import("./render-runtime")>()),
  renderRepository: m.repository,
}));
import { GET as getAction, POST as postAction } from "../app/api/renders/[id]/[action]/route";
import { GET, POST } from "../app/api/renders/route";
const id = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const uid = "33333333-3333-4333-8333-333333333333";
const checksum = "a".repeat(64);
const descriptor = {
  storageKey: `distribution/renders/${id}/preview.mp4`,
  sha256: checksum,
  byteSize: 12,
  mimeType: "video/mp4",
};
const artifact = {
  id,
  jobId,
  isTest: true,
  revision: 1,
  recipeSha256: checksum,
  approval: null,
  createdAt: "2026-09-29T12:00:00Z",
  output: {
    recipeSha256: checksum,
    sourceSha256: checksum,
    encoderVersion: "ffmpeg version 8",
    video: descriptor,
    captions: {
      ...descriptor,
      storageKey: `distribution/renders/${id}/captions.vtt`,
      mimeType: "text/vtt",
    },
    manifest: {
      ...descriptor,
      storageKey: `distribution/renders/${id}/manifest.json`,
      mimeType: "application/json",
    },
  },
};
const job = {
  id: jobId,
  masterId: id,
  sourceVersionId: id,
  recipeSha256: checksum,
  recipe: { aspect: "9:16", language: "te", channel: "manual_export", placement: "instagram" },
  status: "QUEUED",
  attempts: 0,
  maxAttempts: 3,
  availableAt: "2026-09-29T12:00:00Z",
  lastError: null,
  createdAt: "2026-09-29T12:00:00Z",
  updatedAt: "2026-09-29T12:00:00Z",
  requestedBy: uid,
  leaseToken: "secret-token",
  leaseOwner: "private-host",
};
const request = (body: unknown) =>
  new Request("http://localhost:3020/distribution/api/renders", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3020" },
    body: JSON.stringify(body),
  });
const params = (action: string) => ({ params: Promise.resolve({ id, action }) });
const command = {
  masterId: id,
  expectedSourceRevision: 3,
  transcriptVersionId: uid,
  quoteId: null,
  translationId: null,
  template: { id: "contained-preview-v1", version: 1 },
  aspect: "16:9",
  language: "en",
  startMs: 0,
  endMs: 1000,
  captionMode: "none",
  channel: "manual_export",
  territory: "IN",
};
const review = {
  expectedRevision: 1,
  expectedRecipeSha256: checksum,
  expectedAssetSha256: checksum,
  decision: "APPROVED",
};
describe("DS-DIST-R3 render HTTP authorization and private delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.nativePolicy.mockResolvedValue(undefined);
    m.access.mockResolvedValue({
      ok: true,
      context: { userId: uid, isTest: true },
      identity: { id: uid },
      capabilities: ["content.create", "content.review", "content.publish"],
    });
    m.repository.mockReturnValue({
      listJobs: m.listJobs,
      listArtifacts: m.listArtifacts,
      enqueue: m.enqueue,
      getArtifact: m.getArtifact,
      getArtifactExport: m.getArtifactExport,
      reviewArtifact: m.reviewArtifact,
    });
    m.assets.mockReturnValue({ readDerivedDescriptor: m.read });
    m.listJobs.mockResolvedValue([job]);
    m.listArtifacts.mockResolvedValue([
      { artifact, eligibility: { allowed: false, reason: "ARTIFACT_NOT_APPROVED" } },
    ]);
    m.enqueue.mockResolvedValue(job);
    m.reviewArtifact.mockResolvedValue({
      ...artifact,
      revision: 2,
      approval: {
        decision: "APPROVED",
        revision: 2,
        reviewerId: uid,
        reviewedAt: "2026-09-29T12:00:00Z",
      },
    });
    m.getArtifactExport.mockImplementation(async () => (await m.getArtifact()).artifact);
    m.getArtifact.mockResolvedValue({
      job,
      artifact,
      eligibility: { allowed: false, reason: "ARTIFACT_NOT_APPROVED" },
    });
    m.read.mockImplementation(async (value) =>
      value.mimeType === "text/vtt"
        ? Buffer.from("WEBVTT\n\n")
        : value.mimeType === "application/json"
          ? Buffer.from('{"schemaVersion":1}')
          : Buffer.from("abcdefghijkl"),
    );
  });
  it("authorizes every route before parsing, DB or file access", async () => {
    m.access.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "sign_in_required" }, { status: 401 }),
    });
    expect((await GET(new Request("http://localhost/api/renders?masterId=bad"))).status).toBe(401);
    expect((await POST(request({}))).status).toBe(401);
    expect((await getAction(new Request("http://localhost"), params("media"))).status).toBe(401);
    expect((await postAction(request({}), params("review"))).status).toBe(401);
    expect(m.repository).not.toHaveBeenCalled();
    expect(m.assets).not.toHaveBeenCalled();
  });
  it("lists explicit public DTOs without credentials, requester identity or storage paths", async () => {
    const response = await GET(new Request(`http://localhost/api/renders?masterId=${id}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    for (const privateValue of [
      "leaseToken",
      "leaseOwner",
      "requestedBy",
      "secret-token",
      "private-host",
      "storageKey",
      "distribution/renders/",
    ])
      expect(body).not.toContain(privateValue);
    const listed = JSON.parse(body);
    expect(listed.artifacts[0].artifact.output.video.filename).toContain(`SGS_m${id}_instagram_`);
    expect(listed.artifacts[0].artifact.output.video.filename).not.toContain("/");
  });
  it("keeps the actual named storage run reference in public filenames and related downloads", async () => {
    const names = buildDerivedAssetNames({
      masterId: id,
      sourceVersionId: id,
      derivationId: uid,
      destination: "instagram",
      language: "te",
      aspect: "9:16",
    });
    const namedArtifact = {
      ...artifact,
      output: {
        ...artifact.output,
        video: { ...descriptor, storageKey: `${names.directory}/${names.video}` },
        captions: {
          ...artifact.output.captions,
          storageKey: `${names.directory}/${names.captions}`,
        },
        manifest: {
          ...artifact.output.manifest,
          storageKey: `${names.directory}/${names.manifest}`,
        },
      },
    };
    m.listArtifacts.mockResolvedValue([
      { artifact: namedArtifact, eligibility: { allowed: true } },
    ]);
    const listed = await (
      await GET(new Request(`http://localhost/api/renders?masterId=${id}`))
    ).json();
    expect(listed.artifacts[0].artifact.output.video.filename).toBe(names.video);
    m.getArtifact.mockResolvedValue({
      job,
      artifact: namedArtifact,
      eligibility: { allowed: true },
    });
    const result = await getAction(new Request("http://localhost"), params("export"));
    expect(result.status).toBe(200);
    expect(result.headers.get("content-disposition")).toBe(
      `attachment; filename="${names.archive}"`,
    );
    const archive = Buffer.from(await result.arrayBuffer()).toString();
    expect(archive).toContain(names.video);
    expect(archive).toContain(names.captions);
    expect(archive).not.toContain(names.directory);
  });
  it("validates enqueue commands and refuses injected recipes or worker actions", async () => {
    expect((await POST(request({ ...command, recipe: { execute: "bad" } }))).status).toBe(400);
    expect(m.enqueue).not.toHaveBeenCalled();
    expect((await POST(request(command))).status).toBe(201);
    expect(m.access).toHaveBeenLastCalledWith(expect.any(Request), "content.create");
    expect(m.enqueue).toHaveBeenCalledWith({ userId: uid, isTest: true }, command);
    expect((await postAction(request(review), params("claim"))).status).toBe(404);
  });
  it("refuses oversized commands and invalid ranges without leaking private error text", async () => {
    const oversized = await POST(request({ ...command, title: "x".repeat(20000) }));
    expect(oversized.status).toBe(400);
    expect(m.enqueue).not.toHaveBeenCalled();
    const invalid = await getAction(
      new Request("http://localhost", { headers: { range: "bytes=0-1,3-4" } }),
      params("media"),
    );
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */12");
    m.listJobs.mockResolvedValue([{ ...job, lastError: "private database password" }]);
    const listed = await GET(new Request(`http://localhost/api/renders?masterId=${id}`));
    const text = await listed.text();
    expect(text).toContain("RENDER_FAILED");
    expect(text).not.toContain("password");
  });
  it("checks exact review revision and checksums and requires review capability", async () => {
    expect(
      (await postAction(request({ ...review, expectedAssetSha256: "bad" }), params("review")))
        .status,
    ).toBe(400);
    expect(m.reviewArtifact).not.toHaveBeenCalled();
    expect((await postAction(request(review), params("review"))).status).toBe(200);
    expect(m.access).toHaveBeenLastCalledWith(expect.any(Request), "content.review");
    expect(m.reviewArtifact).toHaveBeenCalledWith({ userId: uid, isTest: true }, id, review);
  });
  it("allows unapproved review previews with ranges and caption MIME but blocks export", async () => {
    const video = await getAction(
      new Request("http://localhost", { headers: { range: "bytes=2-5" } }),
      params("media"),
    );
    expect(video.status).toBe(206);
    expect(await video.text()).toBe("cdef");
    expect(video.headers.get("content-range")).toBe("bytes 2-5/12");
    expect(video.headers.get("x-content-type-options")).toBe("nosniff");
    const caption = await getAction(new Request("http://localhost"), params("captions"));
    expect(caption.status).toBe(200);
    expect(caption.headers.get("content-type")).toContain("text/vtt");
    expect((await getAction(new Request("http://localhost"), params("export"))).status).toBe(409);
  });
  it("refuses stale dependencies before file reads, and changes or revoked grants after file IO", async () => {
    m.getArtifact.mockResolvedValueOnce({
      job,
      artifact,
      eligibility: { allowed: false, reason: "SOURCE_DEPENDENCY_CHANGED" },
    });
    expect((await getAction(new Request("http://localhost"), params("media"))).status).toBe(409);
    expect(m.read).not.toHaveBeenCalled();
    m.getArtifact
      .mockResolvedValueOnce({ job, artifact, eligibility: { allowed: true } })
      .mockResolvedValueOnce({
        job,
        artifact: { ...artifact, revision: 2 },
        eligibility: { allowed: true },
      });
    expect((await getAction(new Request("http://localhost"), params("media"))).status).toBe(409);
    m.access
      .mockResolvedValueOnce({
        ok: true,
        context: { userId: uid, isTest: true },
        capabilities: ["content.publish"],
      })
      .mockResolvedValueOnce({
        ok: false,
        response: Response.json({ error: "FORBIDDEN" }, { status: 403 }),
      });
    m.getArtifact.mockResolvedValue({ job, artifact, eligibility: { allowed: true } });
    expect((await getAction(new Request("http://localhost"), params("export"))).status).toBe(403);
  });
  it("exports only the bounded safe archive after approval; private error details never escape", async () => {
    m.getArtifact.mockResolvedValue({
      job,
      artifact: {
        ...artifact,
        revision: 2,
        approval: {
          decision: "APPROVED",
          revision: 2,
          reviewerId: uid,
          reviewedAt: "2026-09-29T12:00:00Z",
        },
      },
      eligibility: { allowed: true },
    });
    const result = await getAction(new Request("http://localhost"), params("export"));
    expect(result.status).toBe(200);
    expect(m.getArtifactExport).toHaveBeenCalledTimes(2);
    expect(m.getArtifactExport).toHaveBeenNthCalledWith(1, { userId: uid, isTest: true }, id, {
      expectedRevision: 2,
      expectedRecipeSha256: checksum,
      expectedAssetSha256: checksum,
      recordAudit: false,
    });
    expect(m.getArtifactExport).toHaveBeenNthCalledWith(2, { userId: uid, isTest: true }, id, {
      expectedRevision: 2,
      expectedRecipeSha256: checksum,
      expectedAssetSha256: checksum,
      recordAudit: true,
    });
    expect(result.headers.get("content-type")).toBe("application/x-tar");
    const names = buildDerivedAssetNames({
      masterId: id,
      sourceVersionId: id,
      derivationId: id,
      destination: "instagram",
      language: "te",
      aspect: "9:16",
    });
    expect(result.headers.get("content-disposition")).toBe(
      `attachment; filename="${names.archive}"`,
    );
    const bytes = Buffer.from(await result.arrayBuffer());
    expect(bytes.toString()).toContain(names.video);
    expect(bytes.toString()).toContain(names.captions);
    expect(bytes.toString()).toContain(names.manifest);
    expect(bytes.toString()).toContain(`"masterId": "${id}"`);
    expect(bytes.toString()).toContain('"intendedChannel": "instagram"');
    expect(bytes.toString()).not.toContain('"leaseToken"');
    expect(bytes.toString()).not.toContain("storageKey");
    m.enqueue.mockRejectedValue(new Error("postgres://password@host/private"));
    const failed = await POST(request(command));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("password");
  });
});

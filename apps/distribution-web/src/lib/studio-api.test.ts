import type { StudioPackage, StudioReadiness } from "@satsang/distribution-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  access: vi.fn(),
  query: vi.fn(),
  repo: vi.fn(),
  assets: vi.fn(),
  read: vi.fn(),
  master: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  listPublications: vi.fn(),
  listPublicationsForPackages: vi.fn(),
  enqueueGeneration: vi.fn(),
  revise: vi.fn(),
  submit: vi.fn(),
  review: vi.fn(),
  discard: vi.fn(),
  publish: vi.fn(),
  retract: vi.fn(),
  getOutputAsset: vi.fn(),
  readiness: vi.fn(),
}));
vi.mock("./runtime", () => ({
  access: m.access,
  privateAssets: m.assets,
  distributionPool: () => ({ query: m.query }),
}));
vi.mock("./studio-runtime", async (original) => ({
  ...(await original<typeof import("./studio-runtime")>()),
  studioRepository: m.repo,
  studioReadiness: m.readiness,
}));
import { POST as action } from "../app/api/studio/[id]/[action]/route";
import { GET as media } from "../app/api/studio/[id]/assets/[outputId]/[action]/route";
import { GET as detail } from "../app/api/studio/[id]/route";
import { GET, POST } from "../app/api/studio/route";
import { publicStudioPackage, publicStudioPublication } from "./studio-runtime";

const id = "11111111-1111-4111-8111-111111111111";
const masterId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const outputId = "44444444-4444-4444-8444-444444444444";
const actor = "55555555-5555-4555-8555-555555555555";
const now = "2026-10-05T12:00:00.000Z";
const context = { userId: actor, isTest: true, roles: ["CONTENT_COORDINATOR"] };
const descriptor = {
  storageKey: "private/studio/secret-address",
  filename: "SGS_master_instagram_en.mp4",
  mimeType: "video/mp4",
  sha256: "a".repeat(64),
  byteSize: 12,
};
const pkg: StudioPackage = {
  id,
  isTest: true,
  revision: 2,
  status: "IN_REVIEW",
  createdBy: actor,
  contributorIds: [actor],
  source: {
    masterId,
    versionId,
    sha256: "b".repeat(64),
    revision: 3,
    title: "Synthetic source",
    language: "en",
    category: "other",
    mimeType: "video/mp4",
  },
  request: { channels: ["instagram"], languages: ["en"], captions: true, instructions: "" },
  outputs: [
    {
      id: outputId,
      channel: "instagram",
      format: "reel",
      language: "en",
      title: "Synthetic source",
      body: "Source excerpt. SGS Datta Sannidhi",
      rationale: "Source-based draft",
      included: true,
      sourceSegmentIds: ["segment-1"],
      startMs: 0,
      endMs: 1000,
      aspect: "9:16",
      asset: descriptor,
      thumbnail: {
        ...descriptor,
        storageKey: "private/thumbnail/secret-address",
        filename: "thumbnail.png",
        mimeType: "image/png",
      },
      captions: [
        {
          language: "en",
          translated: false,
          asset: {
            ...descriptor,
            mimeType: "text/vtt",
            filename: "SGS_master_instagram_en_captions.vtt",
            storageKey: "private/captions/secret-address",
          },
        },
      ],
      warnings: [],
    },
  ],
  provenance: {
    provider: "local",
    model: "extractive",
    promptVersion: "v1",
    generatedAt: now,
    brandName: "Ashrama",
    brandLogoSha256: "a".repeat(64),
    transcript: {
      language: "en",
      durationMs: 1000,
      segments: [{ id: "segment-1", startMs: 0, endMs: 1000, text: "Source excerpt." }],
      provenance: "MACHINE_TRANSCRIPT",
      sourceTranscriptId: null,
    },
    skippedChannels: [],
  },
  approval: null,
  feedback: [],
  failure: null,
  createdAt: now,
  updatedAt: now,
};
const readiness: StudioReadiness = {
  isTest: true,
  generation: {
    available: true,
    transcription: "Approved transcript",
    intelligence: "Local source-based drafting",
    translation: false,
    reason: null,
  },
  channels: [],
};
const request = (body: unknown = {}) =>
  new Request("http://localhost:3020/distribution/api/studio", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3020" },
    body: JSON.stringify(body),
  });
const params = (name: string) => ({ params: Promise.resolve({ id, action: name }) });
const mediaParams = (name: string) => ({ params: Promise.resolve({ id, outputId, action: name }) });

describe("Intelligent content HTTP role, review and media boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.access.mockResolvedValue({
      ok: true,
      context,
      capabilities: ["content.create", "content.review", "content.publish"],
      repo: { get: m.master, workspaceNames: vi.fn().mockResolvedValue({}) },
    });
    m.query.mockResolvedValue({ rows: [{ language: "en" }] });
    m.repo.mockReturnValue(m);
    m.list.mockResolvedValue([pkg]);
    m.create.mockResolvedValue(pkg);
    m.get.mockResolvedValue(pkg);
    for (const method of [m.enqueueGeneration, m.revise, m.submit, m.review, m.discard])
      method.mockResolvedValue(pkg);
    m.listPublications.mockResolvedValue([]);
    m.listPublicationsForPackages.mockResolvedValue([]);
    m.publish.mockResolvedValue([]);
    m.readiness.mockResolvedValue(readiness);
    m.getOutputAsset.mockResolvedValue(descriptor);
    m.assets.mockReturnValue({ readDerivedDescriptor: m.read });
    m.read.mockResolvedValue(Buffer.from("abcdefghijkl"));
    m.master.mockResolvedValue({
      id: masterId,
      title: pkg.source.title,
      language: "en",
      category: "other",
      state: "DRAFT",
      revision: 3,
      currentVersion: { id: versionId, sha256: pkg.source.sha256 },
      rights: null,
      approval: null,
    });
  });
  it("exposes the missing source language before approval without affecting content blockers", async () => {
    m.get.mockResolvedValue({ ...pkg, source: { ...pkg.source, language: "te" } });
    const response = await detail(request(), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.reviewAssignment.blocker).toContain("Telugu");
    expect(data.reviewAssignment.blocker).toContain("Settings → Reviewer languages");
    expect(data.blockers).not.toContain("NATIVE_REVIEWER_REQUIRED");
    expect(m.review).not.toHaveBeenCalled();
  });
  it("requires publishing authority for retraction and rejects empty selections", async () => {
    const result = await action(
      request({ expectedRevision: 2, publicationIds: [] }),
      params("retract"),
    );
    expect(m.access).toHaveBeenCalledWith(expect.any(Request), "content.publish");
    expect(result.status).toBe(400);
    expect(m.retract).not.toHaveBeenCalled();
  });
  it("returns per-file retraction outcomes without leaking private account IDs", async () => {
    m.retract.mockResolvedValue([
      {
        result: "REMOVE_ON_CHANNEL",
        publication: {
          id: outputId,
          accountId: "private-account",
          remoteUrl: "https://youtube.com/watch?v=known",
          error: null,
        },
      },
    ]);
    const result = await action(
      request({ expectedRevision: 2, publicationIds: [outputId] }),
      params("retract"),
    );
    expect(result.status).toBe(200);
    expect(m.retract).toHaveBeenCalledWith(context, id, {
      expectedRevision: 2,
      publicationIds: [outputId],
    });
    const data = await result.json();
    expect(data.results[0].result).toBe("REMOVE_ON_CHANNEL");
    expect(data.results[0].publication).not.toHaveProperty("accountId");
  });
  it("authenticates before parsing, repository or storage work", async () => {
    m.access.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "sign_in_required" }, { status: 401 }),
    });
    expect((await GET(new Request("http://localhost/api/studio?masterId=bad"))).status).toBe(401);
    expect((await POST(request({}))).status).toBe(401);
    expect((await action(request({}), params("review"))).status).toBe(401);
    expect((await media(new Request("http://localhost"), mediaParams("media"))).status).toBe(401);
    expect(m.repo).not.toHaveBeenCalled();
    expect(m.assets).not.toHaveBeenCalled();
  });
  it("uses content.create for one all-channel generation request and rejects injected authority", async () => {
    const command = { masterId, expectedSourceRevision: 3, request: pkg.request };
    expect((await POST(request({ ...command, isTest: false }))).status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
    expect((await POST(request(command))).status).toBe(201);
    expect(m.access).toHaveBeenLastCalledWith(expect.any(Request), "content.create");
    expect(m.create).toHaveBeenCalledWith(context, command);
  });
  it("loads posting visibility once for only the returned packages and sanitizes receipts", async () => {
    const otherId = "66666666-6666-4666-8666-666666666666";
    m.list.mockResolvedValue([pkg, { ...pkg, id: otherId, status: "DISCARDED" }]);
    m.listPublicationsForPackages.mockResolvedValue([
      {
        packageId: id,
        accountId: "target",
        remoteUrl: "javascript:alert(1)",
        error: "private diagnostics",
      },
    ]);
    const response = await GET(new Request("http://localhost/api/studio?status=IN_REVIEW"));
    const body = await response.json();
    expect(m.listPublicationsForPackages).toHaveBeenCalledExactlyOnceWith(context, [id]);
    expect(body.packages).toHaveLength(1);
    expect(body.publications).toEqual([
      {
        packageId: id,
        selectedAccountId: "target",
        remoteUrl: null,
        error: "STUDIO_PUBLICATION_FAILED",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("private diagnostics");
  });
  it("returns safe filenames and actionable master blockers without storage addresses", async () => {
    const response = await detail(new Request("http://localhost/api/studio"), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.blockers).toContain("NOT_APPROVED");
    expect(body.package.outputs[0].asset.filename).toBe(descriptor.filename);
    expect(JSON.stringify(body)).not.toMatch(/storageKey|secret-address/);
    expect((await GET(new Request("http://localhost/api/studio?status=DISCARDED"))).status).toBe(
      200,
    );
  });
  it("requires rejection comments and sends human review acknowledgments without client review identities", async () => {
    expect(
      (
        await action(
          request({ expectedRevision: 2, decision: "REJECTED", comment: " " }),
          params("review"),
        )
      ).status,
    ).toBe(400);
    expect(m.review).not.toHaveBeenCalled();
    const command = {
      expectedRevision: 2,
      decision: "REJECTED",
      comment: "Preserve the qualifying sentence.",
      confirmTranscript: false,
      confirmTeachingIntegrity: false,
    };
    expect((await action(request(command), params("review"))).status).toBe(200);
    expect(m.review).toHaveBeenCalledWith(context, id, command);
    expect(m.access).toHaveBeenLastCalledWith(expect.any(Request), "content.review");
    expect(
      (await action(request({ ...command, reviewerId: actor }), params("review"))).status,
    ).toBe(400);
    m.review.mockRejectedValueOnce(Error("INDEPENDENT_REVIEW_REQUIRED"));
    expect((await action(request(command), params("review"))).status).toBe(403);
  });
  it("refuses forged or wrong-platform publishing accounts before queuing", async () => {
    const response = await action(
      request({ expectedRevision: 2, accounts: { youtube: "unknown-account" } }),
      params("publish"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("STUDIO_PUBLISH_ACCOUNT_INVALID");
    expect(m.publish).not.toHaveBeenCalled();
  });
  it("preserves typed revision comments and limits publication to content.publish", async () => {
    const command = { expectedRevision: 2, comment: "Kept the complete source context." };
    expect((await action(request(command), params("submit"))).status).toBe(200);
    expect(m.submit).toHaveBeenCalledWith(context, id, command);
    expect(m.access).toHaveBeenLastCalledWith(expect.any(Request), "content.create");
    expect((await action(request({ expectedRevision: 2 }), params("publish"))).status).toBe(200);
    expect(m.access).toHaveBeenLastCalledWith(expect.any(Request), "content.publish");
    expect(m.publish).toHaveBeenCalledWith(context, id, { expectedRevision: 2, accounts: {} });
    expect(
      (await action(request({ expectedRevision: 2, recipients: ["someone"] }), params("publish")))
        .status,
    ).toBe(400);
  });
  it("allows a creator or reviewer to discard but refuses unrelated capabilities", async () => {
    expect(
      (await action(request({ expectedRevision: 2, outputId }), params("discard"))).status,
    ).toBe(200);
    expect(m.discard).toHaveBeenCalledWith(context, id, {
      expectedRevision: 2,
      outputId,
      comment: "",
    });
    m.access.mockResolvedValue({ ok: true, context, capabilities: ["analytics.view"] });
    expect((await action(request({ expectedRevision: 2 }), params("discard"))).status).toBe(403);
  });
  it("streams bounded preview ranges and checks current authority and exact assets after storage IO", async () => {
    const response = await media(
      new Request("http://localhost", { headers: { range: "bytes=2-5" } }),
      mediaParams("media"),
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("cdef");
    expect(response.headers.get("content-disposition")).toBe(
      `inline; filename="${descriptor.filename}"`,
    );
    expect(m.getOutputAsset).toHaveBeenCalledTimes(2);
    m.getOutputAsset
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce({ ...descriptor, sha256: "c".repeat(64) });
    expect((await media(new Request("http://localhost"), mediaParams("media"))).status).toBe(409);
    m.getOutputAsset.mockResolvedValue(descriptor);
    m.access
      .mockResolvedValueOnce({ ok: true, context, capabilities: ["content.publish"] })
      .mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await media(new Request("http://localhost"), mediaParams("download"))).status).toBe(
      403,
    );
  });
  it("serves thumbnails only through the same current-asset authority checks", async () => {
    const thumbnail = pkg.outputs[0]?.thumbnail;
    if (!thumbnail) throw Error("Missing test thumbnail");
    m.getOutputAsset.mockResolvedValue(thumbnail);
    const response = await media(new Request("http://localhost"), mediaParams("thumbnail"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(m.getOutputAsset).toHaveBeenCalledTimes(2);
    expect(m.getOutputAsset).toHaveBeenLastCalledWith(context, id, outputId, { kind: "thumbnail" });
    m.getOutputAsset
      .mockResolvedValueOnce(thumbnail)
      .mockResolvedValueOnce({ ...thumbnail, sha256: "c".repeat(64) });
    expect((await media(new Request("http://localhost"), mediaParams("thumbnail"))).status).toBe(
      409,
    );
  });
  it("requires an approved current package for downloads and rejects unsafe filenames before IO", async () => {
    const response = await media(new Request("http://localhost"), mediaParams("download"));
    expect(response.status).toBe(200);
    expect(m.access).toHaveBeenLastCalledWith(expect.any(Request), "content.publish");
    expect(m.getOutputAsset).toHaveBeenLastCalledWith(context, id, outputId, {
      kind: "asset",
      forExport: true,
    });
    m.read.mockClear();
    m.getOutputAsset.mockResolvedValueOnce({ ...descriptor, filename: "../private\r\nheader.mp4" });
    expect((await media(new Request("http://localhost"), mediaParams("media"))).status).toBe(400);
    expect(m.read).not.toHaveBeenCalled();
  });
  it("bounds JSON bodies and never returns private provider failures or credentials", async () => {
    expect((await POST(request({ padding: "x".repeat(1024 * 1024 + 1) }))).status).toBe(400);
    m.get.mockRejectedValueOnce(Error("postgres://private-user:private-password@host"));
    const response = await detail(new Request("http://localhost"), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-password");
    expect(
      JSON.stringify(publicStudioPackage({ ...pkg, failure: "secret account token" })),
    ).not.toContain("secret account token");
    const rendered = publicStudioPackage({ ...pkg, generationPreviews: pkg.outputs });
    expect(JSON.stringify(rendered.generationPreviews)).not.toContain("storageKey");
    expect(JSON.stringify(rendered.generationPreviews)).not.toContain("identityKey");
    const publication = publicStudioPublication({
      id,
      packageId: id,
      packageRevision: 2,
      outputId,
      channel: "instagram",
      isTest: true,
      status: "BLOCKED",
      accountId: "private-account",
      attempt: 0,
      error: "secret account token",
      remoteId: null,
      remoteUrl: "https://user:password@example.test/private",
      createdAt: now,
      updatedAt: now,
    });
    expect(publication.remoteUrl).toBeNull();
    expect(publication).not.toHaveProperty("accountId");
    expect(publication.error).toBe("STUDIO_PUBLICATION_FAILED");
  });
});

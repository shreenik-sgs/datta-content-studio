import type { StudioPackage } from "@satsang/distribution-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ access: vi.fn(), repo: vi.fn(), history: vi.fn(), assets: vi.fn() }));
vi.mock("./runtime", () => ({ access: m.access, privateAssets: m.assets }));
vi.mock("./studio-runtime", async (original) => ({
  ...(await original<typeof import("./studio-runtime")>()),
  studioRepository: m.repo,
}));
import { GET } from "../app/api/studio/[id]/history/route";

const id = "11111111-1111-4111-8111-111111111111";
const masterId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const outputId = "44444444-4444-4444-8444-444444444444";
const actor = "55555555-5555-4555-8555-555555555555";
const now = "2026-10-10T12:00:00.000Z";
const context = { userId: actor, isTest: true, roles: ["CONTENT_COORDINATOR"] };
const asset = {
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
  status: "DRAFT",
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
      asset,
      captions: [
        {
          language: "en",
          translated: false,
          asset: {
            ...asset,
            mimeType: "text/vtt",
            filename: "SGS_master_instagram_en_captions.vtt",
            storageKey: "private/captions/secret-address",
          },
        },
      ],
      warnings: [],
    },
  ],
  provenance: null,
  approval: null,
  feedback: [],
  failure: null,
  createdAt: now,
  updatedAt: now,
};
const params = (value = id) => ({ params: Promise.resolve({ id: value }) });
const request = (query = "") =>
  new Request(`http://localhost:3020/distribution/api/studio/${id}/history${query}`);

describe("Studio read-only revision history HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.access.mockResolvedValue({ ok: true, context });
    m.repo.mockReturnValue({ history: m.history });
    m.history.mockResolvedValue({
      revisions: [
        { revision: 2, action: "GENERATED", actorId: actor, createdAt: now, package: pkg },
      ],
      nextOffset: null,
    });
  });
  it("returns timestamps and source/file lineage with no private addresses or media access", async () => {
    const response = await GET(request(), params());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      version: 1,
      revisions: [
        {
          revision: 2,
          action: "GENERATED",
          actorId: actor,
          createdAt: now,
          package: {
            source: { masterId, versionId, sha256: pkg.source.sha256 },
            outputs: [
              {
                id: outputId,
                channel: "instagram",
                format: "reel",
                language: "en",
                asset: {
                  filename: asset.filename,
                  mimeType: "video/mp4",
                  sha256: asset.sha256,
                  byteSize: 12,
                },
                captions: [{ asset: { filename: "SGS_master_instagram_en_captions.vtt" } }],
              },
            ],
          },
        },
      ],
      nextOffset: null,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /storageKey|secret-address|private\/studio|private\/captions/,
    );
    expect(m.history).toHaveBeenCalledWith(context, id, { limit: 20, offset: 0 });
    expect(m.assets).not.toHaveBeenCalled();
  });
  it("passes validated pagination through and returns the repository continuation", async () => {
    m.history.mockResolvedValueOnce({ revisions: [], nextOffset: 40 });
    const response = await GET(request("?offset=20&limit=20"), params());
    expect(m.history).toHaveBeenCalledWith(context, id, { limit: 20, offset: 20 });
    expect(await response.json()).toEqual({ version: 1, revisions: [], nextOffset: 40 });
  });
  it.each(["?offset=-1", "?offset=1.5", "?offset=1000001", "?limit=0", "?limit=51", "?limit=NaN"])(
    "rejects unbounded or invalid history requests: %s",
    async (query) => {
      expect((await GET(request(query), params())).status).toBe(400);
      expect(m.history).not.toHaveBeenCalled();
    },
  );
  it("rejects invalid package identity before accessing revision records", async () => {
    expect((await GET(request(), params("not-a-uuid"))).status).toBe(400);
    expect(m.history).not.toHaveBeenCalled();
  });
  it.each([401, 403])(
    "honors authentication refusal %s without querying history",
    async (status) => {
      m.access.mockResolvedValueOnce({
        ok: false,
        response: Response.json({ error: "denied" }, { status }),
      });
      expect((await GET(request(), params())).status).toBe(status);
      expect(m.repo).not.toHaveBeenCalled();
      expect(m.history).not.toHaveBeenCalled();
    },
  );
  it("keeps inaccessible package histories unavailable and masks internal failures", async () => {
    m.history.mockRejectedValueOnce(Error("NOT_FOUND"));
    expect((await GET(request(), params())).status).toBe(404);
    m.history.mockRejectedValueOnce(Error("private database address"));
    const response = await GET(request(), params());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
  it("sanitizes historical failure details using the same public package serializer", async () => {
    m.history.mockResolvedValueOnce({
      revisions: [
        {
          revision: 2,
          action: "GENERATION_FAILED",
          actorId: actor,
          createdAt: now,
          package: { ...pkg, failure: "EACCES /private/secrets" },
        },
      ],
      nextOffset: null,
    });
    const body = await (await GET(request(), params())).json();
    expect(body.revisions[0].package.failure).toBe("STUDIO_GENERATION_FAILED");
    expect(JSON.stringify(body)).not.toContain("/private/secrets");
  });
});

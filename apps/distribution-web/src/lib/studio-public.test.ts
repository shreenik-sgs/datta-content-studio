import { signStudioMediaUrl } from "@satsang/distribution-assets";
import type { StudioOutput, StudioPackage, StudioPublication } from "@satsang/distribution-domain";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  repo: vi.fn(),
  policy: vi.fn(),
  assets: vi.fn(),
  read: vi.fn(),
  publicationMedia: vi.fn(),
  publishedBlog: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("./auth", () => ({ distributionHubPolicyEnabled: m.policy }));
vi.mock("./runtime", () => ({ privateAssets: m.assets }));
vi.mock("./studio-runtime", () => ({ studioRepository: m.repo }));
vi.mock("next/navigation", () => ({ notFound: m.notFound }));
import { GET } from "../app/api/studio/publications/[id]/media/route";
import Blog from "../app/blog/[id]/page";
const publicationId = "11111111-1111-4111-8111-111111111111";
const packageId = "22222222-2222-4222-8222-222222222222";
const outputId = "33333333-3333-4333-8333-333333333333";
const secret = "s".repeat(48);
const asset = {
  storageKey: "distribution/studio/private-key",
  filename: "SGS_master_youtube_short_en.mp4",
  mimeType: "video/mp4",
  byteSize: 12,
  sha256: "a".repeat(64),
};
function fixture() {
  return {
    publication: {
      id: publicationId,
      packageId,
      packageRevision: 4,
      outputId,
      isTest: false,
      status: "RUNNING",
      channel: "youtube",
    } as StudioPublication,
    package: { id: packageId, revision: 4, isTest: false, status: "APPROVED" } as StudioPackage,
    output: {
      id: outputId,
      language: "en",
      title: "<script>untrusted title</script>",
      body: "<img src=x onerror=alert(1)>\n\n@sgsswamiji",
      asset,
      included: true,
    } as StudioOutput,
  };
}
function blogFixture() {
  const value = fixture();
  return {
    ...value,
    publication: {
      ...value.publication,
      status: "PUBLISHED" as const,
      channel: "website" as const,
    },
    output: { ...value.output, format: "blog" as const },
  };
}
function url(changes: Record<string, unknown> = {}) {
  return signStudioMediaUrl({
    publicationId,
    packageId,
    revision: 4,
    outputId,
    sha256: asset.sha256,
    expiresAt: Date.now() + 60000,
    origin: "https://hub.example.test",
    secret,
    ...changes,
  });
}
const params = () => ({ params: Promise.resolve({ id: publicationId }) });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DISTRIBUTION_HUB_ENABLED", "true");
  vi.stubEnv("DISTRIBUTION_HUB_STAGE", "ON");
  m.policy.mockResolvedValue(true);
  vi.stubEnv("STUDIO_PUBLISHING_ENABLED", "true");
  vi.stubEnv("STUDIO_MEDIA_SIGNING_SECRET", secret);
  vi.stubGlobal("React", React);
  m.repo.mockReturnValue(m);
  m.assets.mockReturnValue({ readDerivedDescriptor: m.read });
  m.read.mockResolvedValue(Buffer.from("abcdefghijkl"));
  m.publicationMedia.mockImplementation(async () => structuredClone(fixture()));
  m.publishedBlog.mockImplementation(async () => structuredClone(blogFixture()));
  m.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("public Studio signed-media and published-blog boundaries", () => {
  it.each(["TEST", "OFF", "SHADOW"])(
    "denies public media and blogs in %s before DB or storage",
    async (stage) => {
      vi.stubEnv("DISTRIBUTION_HUB_STAGE", stage);
      expect((await GET(new Request(url()), params())).status).toBe(404);
      await expect(Blog(params())).rejects.toThrow("NEXT_NOT_FOUND");
      expect(m.repo).not.toHaveBeenCalled();
      expect(m.assets).not.toHaveBeenCalled();
    },
  );
  it("denies disabled deployment or Admin policy before reading public media or blogs", async () => {
    vi.stubEnv("DISTRIBUTION_HUB_ENABLED", "false");
    expect((await GET(new Request(url()), params())).status).toBe(404);
    await expect(Blog(params())).rejects.toThrow("NEXT_NOT_FOUND");
    expect(m.policy).not.toHaveBeenCalled();
    vi.stubEnv("DISTRIBUTION_HUB_ENABLED", "true");
    m.policy.mockResolvedValue(false);
    expect((await GET(new Request(url()), params())).status).toBe(404);
    await expect(Blog(params())).rejects.toThrow("NEXT_NOT_FOUND");
    expect(m.repo).not.toHaveBeenCalled();
    expect(m.assets).not.toHaveBeenCalled();
  });
  it("rechecks the Admin switch after reading bytes before returning a public range", async () => {
    m.policy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const response = await GET(new Request(url(), { headers: { range: "bytes=0-2" } }), params());
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("abc");
    expect(m.read).toHaveBeenCalledTimes(1);
  });
  it("denies when publishing is disabled or token is missing/tampered/wrong-publication/expired", async () => {
    vi.stubEnv("STUDIO_PUBLISHING_ENABLED", "false");
    expect((await GET(new Request(url()), params())).status).toBe(404);
    await expect(Blog(params())).rejects.toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("STUDIO_PUBLISHING_ENABLED", "true");
    const tampered = new URL(url());
    const token = tampered.searchParams.get("token") ?? "";
    tampered.searchParams.set("token", `${token.slice(0, -4)}AAAA`);
    for (const address of [
      "https://hub.example.test/media",
      tampered.href,
      url({ publicationId: outputId }),
      url({ expiresAt: Date.now() - 1000 }),
    ])
      expect((await GET(new Request(address), params())).status).toBe(404);
    expect(m.publicationMedia).not.toHaveBeenCalled();
    expect(m.read).not.toHaveBeenCalled();
  });
  it("binds every signed identity and rejects TEST data even with a valid production token", async () => {
    for (const change of [
      { package: { ...fixture().package, id: outputId } },
      { package: { ...fixture().package, revision: 5 } },
      { package: { ...fixture().package, isTest: true } },
      { publication: { ...fixture().publication, isTest: true } },
      { publication: { ...fixture().publication, outputId: packageId } },
      { output: { ...fixture().output, id: packageId } },
      { output: { ...fixture().output, asset: { ...asset, sha256: "b".repeat(64) } } },
    ]) {
      m.publicationMedia.mockResolvedValueOnce({ ...fixture(), ...change });
      expect((await GET(new Request(url()), params())).status).toBe(404);
    }
    expect(m.read).not.toHaveBeenCalled();
  });
  it("serves only bounded private bytes and supports a single valid range", async () => {
    const full = await GET(new Request(url()), params());
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("abcdefghijkl");
    expect(full.headers.get("cache-control")).toBe("private, no-store");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(full.headers.get("referrer-policy")).toBe("no-referrer");
    expect(full.headers.get("content-disposition")).toContain(asset.filename);
    expect(m.assets).toHaveBeenCalledWith({ isTest: false });
    const range = await GET(new Request(url(), { headers: { range: "bytes=2-5" } }), params());
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("cdef");
    expect(range.headers.get("content-range")).toBe("bytes 2-5/12");
    const suffix = await GET(new Request(url(), { headers: { range: "bytes=-3" } }), params());
    expect(await suffix.text()).toBe("jkl");
    for (const value of ["bytes=99-100", "bytes=0-1,3-4", "bytes=3-1"]) {
      const denied = await GET(new Request(url(), { headers: { range: value } }), params());
      expect(denied.status).toBe(416);
      expect(denied.headers.get("content-range")).toBe("bytes */12");
      expect(await denied.text()).toBe("");
    }
  });
  it("rechecks revocation and all descriptor identities after storage IO before releasing a range", async () => {
    for (const change of [
      null,
      { package: { ...fixture().package, revision: 5 } },
      { package: { ...fixture().package, id: outputId } },
      { output: { ...fixture().output, id: packageId } },
      { output: { ...fixture().output, asset: { ...asset, storageKey: "changed/key" } } },
      { output: { ...fixture().output, asset: { ...asset, mimeType: "text/html" } } },
      { output: { ...fixture().output, asset: { ...asset, filename: "changed.mp4" } } },
      { output: { ...fixture().output, asset: { ...asset, byteSize: 13 } } },
    ]) {
      m.publicationMedia.mockResolvedValueOnce(fixture());
      if (change === null)
        m.publicationMedia.mockRejectedValueOnce(new Error("SOURCE_DEPENDENCY_CHANGED"));
      else m.publicationMedia.mockResolvedValueOnce({ ...fixture(), ...change });
      const result = await GET(new Request(url(), { headers: { range: "bytes=0-2" } }), params());
      expect(result.status).toBe(404);
      expect(await result.text()).not.toContain("abc");
    }
  });
  it("refuses token expiry during IO and storage integrity failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
    const address = url({ expiresAt: Date.now() + 1000 });
    m.read.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(Date.now() + 2000));
      return Buffer.from("abcdefghijkl");
    });
    expect((await GET(new Request(address), params())).status).toBe(404);
    m.read.mockRejectedValueOnce(new Error("ASSET_INTEGRITY_FAILED"));
    expect((await GET(new Request(url()), params())).status).toBe(404);
  });
  it("renders branded escaped blog prose only after the current published-production guard", async () => {
    const html = renderToStaticMarkup(await Blog(params()));
    expect(m.publishedBlog).toHaveBeenCalledWith(publicationId);
    expect(html).toContain("Sri Ganapathy Sachchidananda Swamiji");
    expect(html).toContain("@sgsswamiji");
    expect(html).toContain("&lt;script&gt;untrusted title&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    m.publishedBlog.mockResolvedValueOnce({
      ...blogFixture(),
      package: { ...blogFixture().package, isTest: true },
    });
    await expect(Blog(params())).rejects.toThrow("NEXT_NOT_FOUND");
    m.publishedBlog.mockRejectedValueOnce(new Error("REVIEWER_ROLE_REVOKED"));
    await expect(Blog(params())).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

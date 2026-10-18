import { describe, expect, it } from "vitest";
import { contentPreviewPackSchema } from "./content-pack";

function at<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("MISSING_TEST_FIXTURE");
  return value;
}

function fixture() {
  const attribution = {
    narrator: "Sri Swamiji",
    subject: "Source teaching",
    kind: "discourse_summary",
    quotedSpeaker: null,
  };
  const hash = "a".repeat(64);
  return {
    schemaVersion: 1,
    world: "TEST",
    status: "DRAFT_REVIEW_REQUIRED",
    publishAllowed: false,
    source: {
      id: "master",
      url: "https://www.youtube.com/watch?v=fNyMZjjzMZ0",
      title: "Source",
      displayTitle: "Source",
      sha256: hash,
      durationMs: 30000,
      language: "te",
      descriptionSha256: hash,
      transcriptSha256: hash,
    },
    brand: {
      id: "brand",
      revision: 1,
      name: "Ashrama",
      speaker: "Sri Swamiji",
      logoSha256: hash,
      profileSha256: hash,
    },
    segments: [
      {
        id: "s1",
        startMs: 0,
        endMs: 30000,
        text: "మొదటి భాగం",
        language: "te",
        provenance: "machine_transcript",
      },
    ],
    clips: [
      {
        id: "clip",
        title: "Draft",
        summary: "Draft summary",
        attribution,
        startMs: 0,
        endMs: 30000,
        segmentIds: ["s1"],
        formats: ["short", "reel"],
      },
    ],
    posts: [
      {
        id: "post",
        title: "Draft",
        summary: "Draft summary",
        attribution,
        sourceClipId: "clip",
        format: "post",
      },
    ],
    blogs: [
      {
        id: "blog",
        title: "Draft",
        dek: "Draft summary",
        paragraphs: ["Summary"],
        attribution,
        sourceClipIds: ["clip"],
        format: "blog",
      },
    ],
    platforms: ["youtube", "facebook", "instagram", "x", "reddit"].map((channel) => ({
      channel,
      title: "Draft",
      body: "Draft summary",
      assetIds: ["clip"],
      recommendation: "Review draft",
    })),
  };
}

describe("strict preview JSON boundary", () => {
  it("accepts a complete local preview document", () => {
    expect(contentPreviewPackSchema.safeParse(fixture()).success).toBe(true);
  });
  it("rejects human approval, publication or translation claims injected into otherwise valid drafts", () => {
    const pack = fixture();
    expect(contentPreviewPackSchema.safeParse({ ...pack, approved: true }).success).toBe(false);
    expect(contentPreviewPackSchema.safeParse({ ...pack, publishAllowed: true }).success).toBe(
      false,
    );
    expect(
      contentPreviewPackSchema.safeParse({
        ...pack,
        source: { ...pack.source, nativeApproval: { approved: true } },
      }).success,
    ).toBe(false);
    expect(
      contentPreviewPackSchema.safeParse({
        ...pack,
        clips: [{ ...pack.clips[0], officialTranslation: true }],
      }).success,
    ).toBe(false);
  });
  it("executes cross-reference and complete transcript range validation", () => {
    const pack = fixture();
    at(pack.clips, 0).startMs = 1000;
    expect(contentPreviewPackSchema.safeParse(pack).success).toBe(false);
  });
  it("does not coerce timestamps, hashes or the world to pass validation", () => {
    const pack = fixture();
    expect(contentPreviewPackSchema.safeParse({ ...pack, world: "test" }).success).toBe(false);
    expect(
      contentPreviewPackSchema.safeParse({
        ...pack,
        source: { ...pack.source, durationMs: "30000" },
      }).success,
    ).toBe(false);
    expect(
      contentPreviewPackSchema.safeParse({
        ...pack,
        brand: { ...pack.brand, logoSha256: "not-a-hash" },
      }).success,
    ).toBe(false);
  });
});

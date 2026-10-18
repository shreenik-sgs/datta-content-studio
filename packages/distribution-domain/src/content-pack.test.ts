import { describe, expect, it } from "vitest";
import {
  type ContentPreviewPack,
  PREVIEW_DESTINATIONS,
  canonicalPreviewBrandProfile,
  previewArtifactFilename,
  validateContentPreviewPack,
} from "./content-pack";

function at<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("MISSING_TEST_FIXTURE");
  return value;
}

function fixture(): ContentPreviewPack {
  const attribution = {
    narrator: "Sri Swamiji",
    subject: "Source teaching",
    kind: "discourse_summary" as const,
    quotedSpeaker: null,
  };
  return {
    schemaVersion: 1,
    world: "TEST",
    status: "DRAFT_REVIEW_REQUIRED",
    publishAllowed: false,
    source: {
      id: "master",
      url: "https://www.youtube.com/watch?v=fNyMZjjzMZ0",
      title: "Source title",
      displayTitle: "Source title",
      sha256: "a".repeat(64),
      durationMs: 1200000,
      language: "te",
      descriptionSha256: "b".repeat(64),
      transcriptSha256: "c".repeat(64),
    },
    brand: {
      id: "ashrama",
      revision: 1,
      name: "Ashrama",
      speaker: "Sri Swamiji",
      logoSha256: "d".repeat(64),
      profileSha256: "e".repeat(64),
    },
    segments: [
      {
        id: "s1",
        startMs: 10000,
        endMs: 20000,
        text: "మొదటి భాగం",
        language: "te",
        provenance: "machine_transcript",
      },
      {
        id: "s2",
        startMs: 20000,
        endMs: 30000,
        text: "రెండవ భాగం",
        language: "te",
        provenance: "machine_transcript",
      },
    ],
    clips: [
      {
        id: "clip1",
        title: "Draft title",
        summary: "Draft summary",
        attribution,
        startMs: 10000,
        endMs: 30000,
        segmentIds: ["s1", "s2"],
        formats: ["short", "reel"],
      },
    ],
    posts: [
      {
        id: "post1",
        title: "Draft post",
        summary: "Draft post summary",
        attribution,
        sourceClipId: "clip1",
        format: "post",
      },
    ],
    blogs: [
      {
        id: "blog1",
        title: "Draft blog",
        dek: "Draft overview",
        paragraphs: ["Source-linked summary."],
        attribution,
        sourceClipIds: ["clip1"],
        format: "blog",
      },
    ],
    platforms: PREVIEW_DESTINATIONS.map((channel) => ({
      channel,
      title: "Draft title",
      body: "Draft summary",
      assetIds: ["clip1", "post1", "blog1"],
      recommendation: "Manual review before any upload.",
    })),
  };
}

function change(mutator: (pack: ContentPreviewPack) => void, reason: string): void {
  const pack = fixture();
  mutator(pack);
  expect(() => validateContentPreviewPack(pack)).toThrow(`INVALID_PREVIEW_PACK:${reason}`);
}

describe("local multi-format content preview pack", () => {
  it("names derivatives with the master fingerprint, destination, format, language, aspect and stable identity", () => {
    const input = {
      sourceId: "fNyMZjjzMZ0",
      sourceSha256: "a".repeat(64),
      channel: "youtube" as const,
      kind: "short" as const,
      language: "te",
      aspect: "9:16" as const,
      artifactId: "contentment",
      extension: "mp4" as const,
    };
    const name = previewArtifactFilename(input);
    expect(name).toMatch(
      /^sgs-fNyMZjjzMZ0-aaaaaaaaaaaa-youtube-short-te-9x16-contentment-[a-f0-9]{16}\.mp4$/,
    );
    expect(previewArtifactFilename(input)).toBe(name);
    expect(previewArtifactFilename({ ...input, channel: "instagram", kind: "reel" })).not.toBe(
      name,
    );
    expect(previewArtifactFilename({ ...input, sourceSha256: "b".repeat(64) })).not.toBe(name);
    expect(previewArtifactFilename({ ...input, sourceId: "another-master" })).not.toBe(name);
    const long = {
      ...input,
      sourceId: "a".repeat(128),
      artifactId: "b".repeat(128),
      language: "tel-Latn-US",
      channel: "instagram" as const,
    };
    expect(previewArtifactFilename(long).length).toBeLessThanOrEqual(100);
    expect(previewArtifactFilename({ ...long, artifactId: `${"b".repeat(127)}c` })).not.toBe(
      previewArtifactFilename(long),
    );
    expect(previewArtifactFilename({ ...input, artifactId: "Contentment" }).toLowerCase()).not.toBe(
      name.toLowerCase(),
    );
    for (const change of [
      { sourceId: "../master" },
      { artifactId: "../clip" },
      { artifactId: "clip\n" },
      { sourceSha256: `${"a".repeat(64)}\n` },
      { channel: "unknown" },
      { language: "te\n" },
      { extension: "html" },
      { aspect: "../" },
    ])
      expect(() => previewArtifactFilename({ ...input, ...change } as typeof input)).toThrow(
        "INVALID_PREVIEW_ARTIFACT_NAME",
      );
  });
  it("accepts complete TEST drafts with source evidence and all five destination recommendations", () => {
    expect(() => validateContentPreviewPack(fixture())).not.toThrow();
  });
  it("cannot become publishing authorization", () => {
    change((pack) => Object.assign(pack, { publishAllowed: true }), "PREVIEW_ONLY");
    change((pack) => Object.assign(pack, { world: "ON" }), "PREVIEW_ONLY");
    change((pack) => Object.assign(pack, { status: "APPROVED" }), "PREVIEW_ONLY");
  });
  it("requires actual checksum identities and non-credentialed HTTPS source links", () => {
    change((pack) => {
      pack.brand.logoSha256 = "https://example.test/logo.png";
    }, "CHECKSUM");
    change((pack) => {
      pack.source.transcriptSha256 = "";
    }, "CHECKSUM");
    change((pack) => {
      pack.source.url = "https://secret:token@example.test/source";
    }, "SOURCE_URL");
    change((pack) => {
      pack.source.url = "file:///tmp/source.mp4";
    }, "SOURCE_URL");
  });
  it("rejects truncated or missing transcript evidence within a clip", () => {
    change((pack) => {
      at(pack.clips, 0).startMs = 15000;
    }, "CLIP_SEGMENT_RANGE");
    change((pack) => {
      at(pack.clips, 0).segmentIds = ["s2"];
    }, "CLIP_EVIDENCE_INCOMPLETE");
    change((pack) => {
      at(pack.clips, 0).segmentIds.reverse();
    }, "CLIP_SEGMENT_RANGE");
    change((pack) => {
      at(pack.clips, 0).segmentIds = ["missing"];
    }, "CLIP_SEGMENT_RANGE");
  });
  it("retains complete teaching boundaries even when longer than a preferred short duration", () => {
    const pack = fixture();
    at(pack.segments, 1).endMs = 610000;
    at(pack.clips, 0).endMs = 610000;
    expect(() => validateContentPreviewPack(pack)).not.toThrow();
  });
  it("rejects out-of-master, noninteger, nonfinite and unordered timing", () => {
    change((pack) => {
      at(pack.clips, 0).endMs = 1200001;
    }, "CLIP_RANGE");
    change((pack) => {
      at(pack.segments, 0).endMs = 10000.5;
    }, "SEGMENT");
    change((pack) => {
      pack.source.durationMs = Number.NaN;
    }, "SOURCE");
    change((pack) => {
      pack.segments.reverse();
    }, "SEGMENT");
  });
  it("requires story and scripture quotations to retain their character attribution", () => {
    change((pack) => {
      at(pack.clips, 0).attribution.kind = "story_character";
    }, "QUOTED_SPEAKER");
    change((pack) => {
      at(pack.blogs, 0).attribution.narrator = "Another speaker";
    }, "ATTRIBUTION");
    const pack = fixture();
    at(pack.clips, 0).attribution = {
      narrator: "Sri Swamiji",
      subject: "Story context",
      kind: "story_character",
      quotedSpeaker: "A named character",
    };
    expect(() => validateContentPreviewPack(pack)).not.toThrow();
  });
  it("requires short/reel/post/blog coverage and distinct safe asset IDs", () => {
    change((pack) => {
      at(pack.clips, 0).formats = ["short"];
    }, "FORMAT_COVERAGE");
    change((pack) => {
      pack.blogs = [];
    }, "FORMAT_COVERAGE");
    change((pack) => {
      at(pack.posts, 0).id = "clip1";
    }, "ASSET_ID");
    change((pack) => {
      at(pack.clips, 0).id = "../file";
    }, "ASSET_ID");
  });
  it("rejects dangling provenance and missing/duplicate platform recommendations", () => {
    change((pack) => {
      at(pack.posts, 0).sourceClipId = "unknown";
    }, "POST");
    change((pack) => {
      at(pack.blogs, 0).sourceClipIds = ["unknown"];
    }, "BLOG");
    change((pack) => {
      at(pack.platforms, 0).assetIds = ["unknown"];
    }, "DESTINATION_COPY");
    change((pack) => {
      pack.platforms.pop();
    }, "DESTINATION_COVERAGE");
    change((pack) => {
      at(pack.platforms, 0).channel = "reddit";
    }, "DESTINATION_COVERAGE");
  });
  it("keeps exact native excerpts explicitly unreviewed and rejects English shadow as quotation", () => {
    const pack = fixture();
    pack.quotes = [
      {
        id: "q1",
        kind: "unreviewed_native_quote",
        text: "మొదటి భాగం\nరెండవ భాగం",
        language: "te",
        sourceClipId: "clip1",
        segmentIds: ["s1", "s2"],
        attribution: at(pack.clips, 0).attribution,
      },
    ];
    expect(() => validateContentPreviewPack(pack)).not.toThrow();
    at(pack.quotes ?? [], 0).text = "English semantic shadow";
    at(pack.quotes ?? [], 0).language = "en";
    expect(() => validateContentPreviewPack(pack)).toThrow("QUOTE_FIDELITY");
  });
  it("cannot join noncontiguous native segments into an apparently exact quote", () => {
    const pack = fixture();
    pack.segments.push({ ...at(pack.segments, 1), id: "s3", startMs: 30000, endMs: 40000 });
    at(pack.clips, 0).segmentIds.push("s3");
    at(pack.clips, 0).endMs = 40000;
    pack.quotes = [
      {
        id: "q1",
        kind: "unreviewed_native_quote",
        text: "మొదటి భాగం\nరెండవ భాగం",
        language: "te",
        sourceClipId: "clip1",
        segmentIds: ["s1", "s3"],
        attribution: at(pack.clips, 0).attribution,
      },
    ];
    expect(() => validateContentPreviewPack(pack)).toThrow("QUOTE_CONTIGUITY");
  });
  it("canonicalizes the actual brand identity without trusting its claimed hash", () => {
    const brand = fixture().brand;
    const expected = JSON.stringify({
      id: "ashrama",
      revision: 1,
      name: "Ashrama",
      speaker: "Sri Swamiji",
      logoSha256: "d".repeat(64),
    });
    expect(canonicalPreviewBrandProfile(brand)).toBe(expected);
    brand.profileSha256 = "0".repeat(64);
    expect(canonicalPreviewBrandProfile(brand)).toBe(expected);
    brand.name = "Different Ashrama";
    expect(canonicalPreviewBrandProfile(brand)).not.toBe(expected);
  });
});

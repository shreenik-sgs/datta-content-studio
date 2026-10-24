import { describe, expect, it } from "vitest";
import type { StudioPackage, StudioProvenance } from "./intelligent-content";
import { studioAssetName } from "./studio-assets";
import { STUDIO_MEDIA_DEFAULTS } from "./studio-media-edits";
import { STUDIO_BRAND_NAME } from "./studio-planner";
import {
  studioPackageBlockers,
  validateStudioGenerationRequest,
  validateStudioOutputs,
  validateStudioProvenance,
} from "./studio-validation";
const masterId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const packageId = "33333333-3333-4333-8333-333333333333";
const outputId = "44444444-4444-4444-8444-444444444444";
function fixture(): StudioPackage {
  const provenance: StudioProvenance = {
    provider: "local",
    model: "local-excerpts",
    promptVersion: "test",
    generatedAt: "2026-10-05T00:00:00.000Z",
    brandName: STUDIO_BRAND_NAME,
    brandLogoSha256: "a".repeat(64),
    transcript: {
      language: "en",
      durationMs: 2000,
      segments: [
        { id: "one", startMs: 0, endMs: 1000, text: "One." },
        { id: "two", startMs: 1000, endMs: 2000, text: "Two." },
      ],
      provenance: "MACHINE_TRANSCRIPT",
      sourceTranscriptId: null,
    },
    skippedChannels: [],
  };
  return {
    id: packageId,
    isTest: true,
    revision: 1,
    status: "DRAFT",
    source: {
      masterId,
      versionId,
      sha256: "b".repeat(64),
      revision: 1,
      title: "Test",
      language: "en",
      category: "other",
      mimeType: "video/mp4",
    },
    createdBy: "creator@example.test",
    contributorIds: ["creator@example.test"],
    request: { languages: ["en"], channels: ["youtube"], captions: false, instructions: "" },
    outputs: [
      {
        id: outputId,
        channel: "youtube",
        format: "short",
        language: "en",
        title: "Test",
        body: "One. Two. @sgsswamiji",
        rationale: "Source excerpt",
        included: true,
        sourceSegmentIds: ["one", "two"],
        startMs: 0,
        endMs: 2000,
        aspect: "9:16",
        asset: {
          ...studioAssetName(
            {
              masterId,
              sourceVersionId: versionId,
              packageId,
              outputId,
              channel: "youtube",
              format: "short",
              language: "en",
              aspect: "9:16",
            },
            "mp4",
          ),
          sha256: "c".repeat(64),
          byteSize: 100,
          mimeType: "video/mp4",
        },
        captions: [],
        warnings: [],
      },
    ],
    provenance,
    approval: null,
    feedback: [],
    failure: null,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
}
const check = (pkg: StudioPackage) =>
  validateStudioOutputs(pkg.outputs, {
    packageId: pkg.id,
    source: pkg.source,
    request: pkg.request,
    provenance: pkg.provenance,
  });
describe("Studio domain persistence guards", () => {
  it("binds custom illustration evidence to its source and package and rejects a failed image review", () => {
    const p = fixture();
    const o = p.outputs[0];
    if (!o || !p.provenance || !o.asset) throw Error("MISSING_FIXTURE");
    o.endMs = p.provenance.transcript.durationMs = 30000;
    const last = p.provenance.transcript.segments[1];
    if (!last) throw Error("MISSING_FIXTURE");
    last.endMs = 30000;
    const illustration = {
      assetId: "generated-one",
      startMs: 10000,
      endMs: 14000,
      sourceSegmentIds: ["two"],
      reason: "A specific sacred offering.",
      prompt: "A serene offering illustrating the cited teaching.",
      generated: {
        asset: {
          ...studioAssetName(
            {
              masterId,
              sourceVersionId: versionId,
              packageId,
              outputId,
              channel: "youtube",
              format: "short",
              language: "en",
              aspect: "9:16",
            },
            "png",
          ),
          sha256: "d".repeat(64),
          byteSize: 100,
          mimeType: "image/png",
        },
        provider: "gemini" as const,
        model: "gemini-image",
        reviewerModel: "gemini-review",
        generatedAt: p.createdAt,
        reviewedAt: p.createdAt,
        checks: {
          contextFaithful: true,
          nonDeceptive: true,
          noInventedText: true,
          visualQuality: true,
          safeComposition: true,
          reason: "The offering depicts the cited spiritual sacrifice.",
        },
      },
    };
    o.presentationReview = {
      illustrationMode: "context-generated",
      policy: "source-safe-portrait-v1",
      sourceSha256: p.source.sha256,
      renderedSha256: o.asset.sha256,
      fileVersion: 1,
      model: "gemini-review",
      reviewedAt: p.createdAt,
      framing: "screened-portrait",
      repairs: 0,
      source: {
        illustrations: [illustration],
        openingComplete: true,
        endingComplete: true,
        naturalStart: true,
        naturalEnd: true,
        reason: "Complete.",
        scenes: [],
      },
      checks: {
        illustrationsRelevant: true,
        textIntact: true,
        subjectIntact: true,
        captionsClear: true,
        naturalBoundaries: true,
        reason: "Passed.",
      },
    };
    expect(() => check(p)).not.toThrow();
    const asset = illustration.generated.asset;
    illustration.generated.asset = {
      ...asset,
      ...studioAssetName(
        {
          masterId,
          sourceVersionId: versionId,
          packageId: "99999999-9999-4999-8999-999999999999",
          outputId,
          channel: "youtube",
          format: "short",
          language: "en",
          aspect: "9:16",
        },
        "png",
      ),
    };
    expect(() => check(p)).toThrow("STUDIO_ILLUSTRATION_INVALID");
    illustration.generated.asset = asset;
    illustration.generated.checks.contextFaithful = false;
    expect(() => check(p)).toThrow("STUDIO_ILLUSTRATION_INVALID");
  });
  it("retains reasons for excluded proposals without accepting malformed review metadata", () => {
    const provenance = fixture().provenance;
    if (!provenance) throw Error("MISSING_FIXTURE");
    const excluded = {
      messageId: "message-02",
      title: "Incomplete verse",
      reasons: ["The explanation was outside the excerpt."],
    };
    expect(() =>
      validateStudioProvenance({ ...provenance, excludedMessages: [excluded] }),
    ).not.toThrow();
    for (const excludedMessages of [
      null,
      {},
      [null],
      [{ ...excluded, messageId: "invalid identifier!" }],
      [{ ...excluded, reasons: [] }],
      [{ ...excluded, reasons: [""] }],
      [{ ...excluded, title: "" }],
    ]) {
      expect(() =>
        validateStudioProvenance({ ...provenance, excludedMessages } as StudioProvenance),
      ).toThrow("INVALID_STUDIO_PROVENANCE");
    }
  });
  it.each(["facebook", "youtube"] as const)(
    "rejects overlong %s renders and blocks older persisted files until corrected or excluded",
    (channel) => {
      const p = fixture();
      const output = p.outputs[0];
      const last = p.provenance?.transcript.segments[1];
      if (!output || !last || !p.provenance) throw new Error("MISSING_FIXTURE");
      const limit = channel === "facebook" ? 90_000 : 180_000;
      p.request.channels = [channel];
      output.channel = channel;
      output.format = channel === "facebook" ? "reel" : "short";
      output.asset = null;
      output.endMs = last.endMs = p.provenance.transcript.durationMs = limit;
      expect(() => check(p)).not.toThrow();
      expect(studioPackageBlockers(p)).not.toContain("STUDIO_CLIP_TOO_LONG");
      output.endMs = last.endMs = p.provenance.transcript.durationMs = limit + 1;
      expect(() => check(p)).toThrow("INVALID_STUDIO_SPAN");
      expect(studioPackageBlockers(p)).toContain("STUDIO_CLIP_TOO_LONG");
      output.included = false;
      expect(studioPackageBlockers(p)).not.toContain("STUDIO_CLIP_TOO_LONG");
    },
  );

  it("accepts complete bound assets and exposes regeneration blockers for drafts", () => {
    const p = fixture();
    expect(() => validateStudioGenerationRequest(p.request)).not.toThrow();
    if (!p.provenance) throw new Error("MISSING_PROVENANCE");
    expect(() => validateStudioProvenance(p.provenance as StudioProvenance)).not.toThrow();
    expect(() => check(p)).not.toThrow();
    expect(studioPackageBlockers(p)).toEqual([]);
    if (!p.outputs[0]) throw new Error("MISSING_OUTPUT");
    p.outputs[0].asset = null;
    expect(() => check(p)).not.toThrow();
    expect(studioPackageBlockers(p)).toEqual(["ASSETS_REQUIRE_REGENERATION"]);
  });
  it.each(["transcript", "transcript_and_audio"] as const)(
    "accepts Gemini %s provenance and explicit recognition lineage",
    (inputMode) => {
      const current = fixture();
      if (!current.provenance) throw new Error("MISSING_PROVENANCE");
      current.provenance = {
        ...current.provenance,
        provider: "gemini",
        model: "gemini-configured-model",
        inputMode,
      };
      for (const recognition of [
        { provider: "sarvam" as const, model: "saaras:v4" },
        { provider: "openai" as const, model: "whisper-1" },
      ]) {
        current.provenance.transcript.recognition = recognition;
        expect(() =>
          validateStudioProvenance(current.provenance as StudioProvenance),
        ).not.toThrow();
        expect(() => check(current)).not.toThrow();
      }
    },
  );
  it.each([
    null,
    [],
    "sarvam",
    {},
    { provider: "gemini", model: "gemini-model" },
    { provider: "sarvam" },
    { provider: "sarvam", model: "" },
    { provider: "sarvam", model: " " },
    { provider: "sarvam", model: "bad\u0000model" },
    { provider: "sarvam", model: 42 },
    { provider: "sarvam", model: "x".repeat(201) },
  ])("rejects malformed persisted recognition with a stable domain error", (recognition) => {
    const current = fixture();
    if (!current.provenance) throw new Error("MISSING_PROVENANCE");
    Object.assign(current.provenance.transcript, { recognition });
    expect(() => validateStudioProvenance(current.provenance as StudioProvenance)).toThrow(
      "INVALID_STUDIO_PROVENANCE",
    );
  });
  it.each([null, "video", "", 42])("rejects invalid persisted source input modes", (inputMode) => {
    const current = fixture();
    if (!current.provenance) throw new Error("MISSING_PROVENANCE");
    Object.assign(current.provenance, { provider: "gemini", inputMode });
    expect(() => validateStudioProvenance(current.provenance as StudioProvenance)).toThrow(
      "INVALID_STUDIO_PROVENANCE",
    );
  });
  it("refuses missing or duplicated request selections", () => {
    const p = fixture();
    for (const request of [
      { ...p.request, languages: [] },
      { ...p.request, channels: ["youtube", "youtube"] },
      { ...p.request, instructions: "\u0000" },
    ])
      expect(() => validateStudioGenerationRequest(request as StudioPackage["request"])).toThrow(
        "INVALID_STUDIO_REQUEST",
      );
  });
  it("refuses fabricated timeline, cut segments, missing attribution and platform copy overflow", () => {
    for (const edit of [
      { startMs: 1 },
      { sourceSegmentIds: ["two", "one"] },
      { body: "No brand" },
      { body: `${"x".repeat(4501)} @sgsswamiji` },
      { format: "blog" },
    ]) {
      const p = fixture();
      if (!p.outputs[0]) throw new Error("MISSING_OUTPUT");
      p.outputs[0] = { ...p.outputs[0], ...edit } as (typeof p.outputs)[0];
      expect(() => check(p)).toThrow();
    }
  });
  it.each(["website", "x", "youtube", "instagram"] as const)(
    "preserves citation integrity when persisting %s outputs",
    (channel) => {
      const current = fixture();
      const output = current.outputs[0];
      if (!output || !current.provenance) throw new Error("MISSING_FIXTURE");
      current.provenance.transcript.durationMs = 3000;
      current.provenance.transcript.segments.push({
        id: "three",
        startMs: 2000,
        endMs: 3000,
        text: "Three.",
      });
      current.request.channels = [channel];
      const video = channel === "youtube" || channel === "instagram";
      Object.assign(output, {
        channel,
        format:
          channel === "youtube"
            ? "short"
            : channel === "instagram"
              ? "reel"
              : channel === "website"
                ? "blog"
                : "post",
        aspect: video ? "9:16" : channel === "website" ? "prose" : "4:5",
        asset: null,
        sourceSegmentIds: ["one", "three"],
        startMs: video ? 0 : null,
        endMs: video ? 3000 : null,
      });
      if (video) expect(() => check(current)).toThrow("STUDIO_SOURCE_EVIDENCE_REQUIRED");
      else expect(() => check(current)).not.toThrow();
      for (const ids of [
        ["three", "one"],
        ["one", "missing"],
        ["one", "one"],
      ]) {
        output.sourceSegmentIds = ids;
        expect(() => check(current)).toThrow();
      }
      if (video) {
        output.sourceSegmentIds = ["one", "two", "three"];
        expect(() => check(current)).not.toThrow();
        output.startMs = 1;
        expect(() => check(current)).toThrow("INVALID_STUDIO_SPAN");
      }
    },
  );
  it("rejects saved title and Telegram caption edits that cannot fit the publishing transport", () => {
    for (const channel of ["youtube", "pinterest"] as const) {
      const p = fixture();
      const output = p.outputs[0];
      if (!output) throw new Error("MISSING_OUTPUT");
      p.request.channels = [channel];
      Object.assign(output, { channel, title: "x".repeat(101), asset: null });
      if (channel === "pinterest")
        Object.assign(output, { format: "post", aspect: "4:5", startMs: null, endMs: null });
      expect(() => check(p)).toThrow("INVALID_STUDIO_COPY");
    }
    const p = fixture();
    const output = p.outputs[0];
    if (!output) throw new Error("MISSING_OUTPUT");
    p.request.channels = ["telegram"];
    Object.assign(output, {
      channel: "telegram",
      format: "post",
      aspect: "4:5",
      startMs: null,
      endMs: null,
      asset: null,
      body: `${"👨‍👩‍👧‍👦".repeat(100)} @sgsswamiji`,
    });
    expect([...output.body].length).toBeLessThan(1000);
    expect(() => check(p)).toThrow("INVALID_STUDIO_COPY");
    output.body = "A reviewed image caption. @sgsswamiji";
    expect(() => check(p)).not.toThrow();
  });
  it("refuses asset relabeling across master, output and channel", () => {
    for (const change of ["master", "output", "channel"]) {
      const p = fixture();
      const o = p.outputs[0];
      if (!o?.asset) throw new Error("MISSING_ASSET");
      if (change === "master") o.asset.storageKey = o.asset.storageKey.replace(masterId, versionId);
      if (change === "output")
        o.asset.storageKey = o.asset.storageKey.replace(`/${outputId}/`, `/${versionId}/`);
      if (change === "channel")
        o.asset.storageKey = o.asset.storageKey.replace("_youtube_", "_instagram_");
      expect(() => check(p)).toThrow("INVALID_STUDIO_ASSET");
    }
  });
  it("allows explicitly hidden translated captions only with complete source-bound review text", () => {
    const p = fixture();
    const output = p.outputs[0];
    if (!output || !p.provenance) throw Error("MISSING_FIXTURE");
    p.provenance.transcript.language = "te";
    p.request.captions = true;
    output.mediaEdits = { ...STUDIO_MEDIA_DEFAULTS, captions: "off" };
    output.captionCues = p.provenance.transcript.segments.map((s) => ({
      ...s,
      text: "Complete English translation.",
    }));
    expect(() => check(p)).not.toThrow();
    output.mediaEdits.captions = "on";
    expect(() => check(p)).toThrow("STUDIO_TRANSLATION_INCOMPLETE");
    output.mediaEdits.captions = "off";
    const cue = output.captionCues[0];
    if (!cue) throw Error("MISSING_FIXTURE");
    cue.startMs = 100;
    expect(() => check(p)).toThrow("STUDIO_TRANSLATION_INCOMPLETE");
  });
  it("requires translated captions for foreign-language video and never manufactures translations", () => {
    const p = fixture();
    const o = p.outputs[0];
    if (!o) throw new Error("MISSING_OUTPUT");
    p.request.languages = ["te"];
    o.language = "te";
    o.asset = null;
    expect(() => check(p)).toThrow("STUDIO_TRANSLATION_INCOMPLETE");
  });
  it("allows complete translated edit cues pending rendering while still blocking review and incomplete rendered media", () => {
    const p = fixture();
    const output = p.outputs[0];
    if (!output || !p.provenance) throw new Error("MISSING_FIXTURE");
    p.provenance.transcript.language = "te";
    const renderedAsset = output.asset;
    output.asset = null;
    output.captionCues = p.provenance.transcript.segments.map((segment) => ({
      ...segment,
      text: "Translated complete sentence.",
    }));
    expect(() => check(p)).not.toThrow();
    expect(studioPackageBlockers(p)).toContain("ASSETS_REQUIRE_REGENERATION");
    output.asset = renderedAsset;
    expect(() => check(p)).toThrow("STUDIO_TRANSLATION_INCOMPLETE");
    output.asset = null;
    const cue = output.captionCues[0];
    if (!cue) throw new Error("MISSING_CUE");
    cue.endMs += 1;
    expect(() => check(p)).toThrow("STUDIO_TRANSLATION_INCOMPLETE");
    cue.endMs -= 1;
    cue.text = "";
    expect(() => check(p)).toThrow("STUDIO_TRANSLATION_INCOMPLETE");
  });
  it("requires current approved-transcript identity or explicit machine provenance", () => {
    const p = fixture();
    if (!p.provenance) throw new Error("MISSING_PROVENANCE");
    const wrong = {
      ...p.provenance,
      transcript: {
        ...p.provenance.transcript,
        provenance: "APPROVED_TRANSCRIPT" as const,
        sourceTranscriptId: null,
      },
    };
    expect(() => validateStudioProvenance(wrong)).toThrow("INVALID_STUDIO_PROVENANCE");
    expect(() =>
      validateStudioProvenance({ ...p.provenance, brandName: "Unbranded" } as StudioProvenance),
    ).toThrow("INVALID_STUDIO_PROVENANCE");
  });
});

it("keeps historical approved branding readable without relabeling its files", () => {
  const pkg = fixture();
  if (!pkg.provenance) throw Error("missing provenance");
  pkg.provenance.brandName = "Sri Ganapathy Sachchidananda Ashrama";
  for (const output of pkg.outputs)
    output.body = output.body.replace("@sgsswamiji", "SGS Datta Sannidhi");
  const provenance = pkg.provenance;
  expect(() => validateStudioProvenance(provenance)).not.toThrow();
  expect(() => check(pkg)).not.toThrow();
});

it("binds alternate speaker identity and subscription target to request, provenance and reviewed pixels", async () => {
  const { studioClosingCardPlan } = await import("./studio-ending");
  const pkg = fixture();
  const target = { label: "Gurubhavana ADPT", url: "https://www.youtube.com/@gurubhavanaadpt" };
  pkg.request = { ...pkg.request, youtubeClosing: target, sourceBranding: "bala-swamiji" };
  const output = pkg.outputs[0];
  if (!output?.asset || !pkg.provenance) throw Error("MISSING_FIXTURE");
  pkg.provenance = {
    ...pkg.provenance,
    sourceBranding: "bala-swamiji",
    brandName: "Sri Datta Vijayananda Teertha Swamiji",
    brandLogoSha256: null,
  };
  output.body = `Complete teaching.\n\nSubscribe to ${target.label}: ${target.url}`;
  output.presentationReview = {
    policy: "source-safe-portrait-v1",
    sourceSha256: pkg.source.sha256,
    renderedSha256: output.asset.sha256,
    fileVersion: 1,
    model: "fixture",
    reviewedAt: pkg.updatedAt,
    framing: "full-picture",
    repairs: 0,
    source: {
      openingComplete: true,
      endingComplete: true,
      naturalStart: true,
      naturalEnd: true,
      reason: "Complete source",
      scenes: [],
    },
    checks: {
      illustrationsRelevant: true,
      textIntact: true,
      subjectIntact: true,
      captionsClear: true,
      naturalBoundaries: true,
      reason: "Complete fixture",
    },
    closingCard: studioClosingCardPlan(2000, {
      youtubeClosing: target,
      sourceBranding: "bala-swamiji",
    }),
  };
  expect(() => validateStudioGenerationRequest(pkg.request)).not.toThrow();
  expect(() => validateStudioProvenance(pkg.provenance as StudioProvenance)).not.toThrow();
  expect(() => check(pkg)).not.toThrow();
  expect(() =>
    validateStudioProvenance({
      ...(pkg.provenance as StudioProvenance),
      brandName: STUDIO_BRAND_NAME,
    }),
  ).toThrow();
  expect(() =>
    validateStudioGenerationRequest({
      ...pkg.request,
      channels: ["facebook", "youtube", "website"],
    }),
  ).not.toThrow();
  const originalCard = output.presentationReview.closingCard;
  if (!originalCard) throw Error("MISSING_CLOSING");
  output.presentationReview.closingCard = studioClosingCardPlan(2000, { destination: "youtube" });
  expect(() => check(pkg)).toThrow("STUDIO_CLOSING_CARD_INVALID");
  output.presentationReview.closingCard = originalCard;
  pkg.request = { ...pkg.request, youtubeClosing: { ...target, label: "Another channel" } };
  expect(() => check(pkg)).toThrow("STUDIO_CLOSING_CARD_INVALID");
});

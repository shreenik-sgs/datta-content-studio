import {
  type StudioOutput,
  type StudioPackage,
  studioAssetName,
  studioClosingCardPlan,
  studioYoutubeFooter,
} from "@satsang/distribution-domain";
export function closingFixture() {
  const id = "00000000-0000-4000-8000-000000000001";
  const oldTarget = {
    label: "Sri Datta Vijayananda Teertha Swamiji",
    url: "https://www.youtube.com/@gurubhavanaadpt",
  };
  const target = {
    ...oldTarget,
    url: "https://www.youtube.com/@sridattavijayam",
    fullVideosUrl: oldTarget.url,
  };
  const pkg = {
    id,
    status: "GENERATING",
    outputs: [],
    approval: null,
    generation: null,
    source: { masterId: id, versionId: id, sha256: "a".repeat(64) },
    request: {
      languages: ["en"],
      channels: ["youtube"],
      captions: true,
      sourceBranding: "bala-swamiji",
      youtubeClosing: target,
    },
  } as unknown as StudioPackage;
  const names = (fileVersion: number) =>
    studioAssetName(
      {
        masterId: id,
        sourceVersionId: id,
        packageId: id,
        outputId: id,
        channel: "youtube",
        format: "short",
        language: "en",
        aspect: "9:16",
        fileVersion,
        renderId: "12345678",
      },
      "mp4",
    );
  const at = "2026-10-26T01:00:00.000Z";
  const prior: StudioOutput = {
    id,
    channel: "youtube",
    format: "short",
    language: "en",
    aspect: "9:16",
    title: "Retained teaching",
    body: `Original editorial copy\n\n${studioYoutubeFooter(oldTarget)}`,
    rationale: "Complete passage",
    included: true,
    fileVersion: 1,
    generatedAt: at,
    sourceSegmentIds: ["original"],
    startMs: 1000,
    endMs: 61000,
    captions: [],
    warnings: [],
    captionCues: [{ id: "one", startMs: 0, endMs: 60000, text: "Original English captions" }],
    asset: { ...names(1), sha256: "b".repeat(64), byteSize: 100, mimeType: "video/mp4" },
    aiReview: {
      status: "PASSED",
      policyVersion: "content-integrity-v1",
      provider: "gemini",
      model: "fixture",
      recordedAt: at,
      inputMode: "transcript_and_audio",
      fileVersion: 1,
      sourceSha256: pkg.source.sha256,
      humanFeedbackConsidered: false,
      checks: {
        channel: "youtube",
        language: "en",
        openingComplete: true,
        endingComplete: true,
        contextComplete: true,
        attributionCorrect: true,
        captionsFaithful: true,
        copySupported: true,
        reason: "Complete",
      },
    },
    presentationReview: {
      policy: "source-safe-portrait-v1",
      sourceSha256: pkg.source.sha256,
      renderedSha256: "b".repeat(64),
      fileVersion: 1,
      model: "fixture",
      reviewedAt: at,
      framing: "full-picture",
      repairs: 0,
      source: {
        openingComplete: true,
        endingComplete: true,
        naturalStart: true,
        naturalEnd: true,
        reason: "Complete",
        scenes: [],
      },
      checks: {
        illustrationsRelevant: true,
        textIntact: true,
        subjectIntact: true,
        captionsClear: true,
        naturalBoundaries: true,
        reason: "Complete",
      },
      closingCard: studioClosingCardPlan(60000, {
        destination: "youtube",
        sourceBranding: "bala-swamiji",
        youtubeClosing: oldTarget,
      }),
    },
  };
  if (!prior.aiReview || !prior.presentationReview) throw Error("Missing review");
  const next: StudioOutput = {
    ...prior,
    asset: { ...names(2), sha256: "c".repeat(64), byteSize: 120, mimeType: "video/mp4" },
    fileVersion: 2,
    body: `Original editorial copy\n\n${studioYoutubeFooter(target)}`,
    closingDestination: "youtube",
    aiReview: { ...prior.aiReview, fileVersion: 2 },
    presentationReview: {
      ...prior.presentationReview,
      fileVersion: 2,
      renderedSha256: "c".repeat(64),
      closingCard: studioClosingCardPlan(60000, {
        destination: "youtube",
        sourceBranding: "bala-swamiji",
        youtubeClosing: target,
      }),
      closingRefresh: {
        policy: "preserved-export-closing-v1",
        previousSha256: "b".repeat(64),
        previousFileVersion: 1,
        cardSha256: "d".repeat(64),
        verifiedAt: at,
        unchangedUntilMs: 58000,
        audioSha256: "e".repeat(64),
        minimumFrameSsim: 0.999,
        minimumCaptionSsim: 0.999,
      },
    },
  };
  return { pkg, prior, next, target };
}

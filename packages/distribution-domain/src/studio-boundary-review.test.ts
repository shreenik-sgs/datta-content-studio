import { expect, it } from "vitest";
import {
  STUDIO_BOUNDARY_EVIDENCE_POLICY,
  STUDIO_BOUNDARY_REVIEW_POLICY,
  type StudioBoundaryReview,
  applyStudioBoundaryReview,
  validateStudioBoundaryReview,
} from "./studio-boundary-review";
import {
  type StudioContentReview,
  studioContentReviewIssues,
  validateStudioContentReview,
} from "./studio-content-review";
const complete = {
  verdict: "complete" as const,
  audibleWords: "A complete sentence.",
  meaning: "A complete sentence.",
  reason: "The audio finishes the thought.",
  needsOutsideSpeech: false,
  cutDuringWord: false,
};
const boundary: StudioBoundaryReview = {
  policy: STUDIO_BOUNDARY_REVIEW_POLICY,
  startMs: 4084911,
  endMs: 4253741,
  opening: complete,
  ending: {
    ...complete,
    verdict: "incomplete" as const,
    audibleWords: "ఈ పద్యాలు తెలుగు విలువ ఆ భాష",
    meaning: "These verses, the value of Telugu, that language...",
    reason:
      "The clip starts an unfinished comment after the earlier moral. The following source speech is excluded.",
    needsOutsideSpeech: true,
  },
};
const check: StudioContentReview = {
  channel: "youtube",
  language: "en",
  openingComplete: true,
  endingComplete: true,
  contextComplete: true,
  attributionCorrect: true,
  captionsFaithful: true,
  copySupported: true,
  reason: "Broad review passed an earlier complete moral.",
};
it("rejects Day 1's trailing native phrase despite an earlier complete moral and polished subtitles", () => {
  const result = applyStudioBoundaryReview(check, boundary);
  expect(result.endingComplete).toBe(false);
  expect(result.openingComplete).toBe(true);
  expect(studioContentReviewIssues([result])[0]).toContain("ఈ పద్యాలు తెలుగు విలువ ఆ భాష");
});
it("does not allow uncertainty or clipped syllables to become a pass", () => {
  for (const change of [
    { verdict: "uncertain" as const },
    { cutDuringWord: true },
    { needsOutsideSpeech: true },
  ]) {
    expect(
      applyStudioBoundaryReview(check, { ...boundary, ending: { ...complete, ...change } })
        .endingComplete,
    ).toBe(false);
  }
});
it("binds review evidence to the exact included range", () => {
  expect(() =>
    validateStudioBoundaryReview(boundary, {
      startMs: boundary.startMs,
      endMs: boundary.endMs + 1000,
    }),
  ).toThrow("STUDIO_VIDEO_REVIEW_INVALID");
  expect(() =>
    validateStudioBoundaryReview({ ...boundary, ending: { ...complete, audibleWords: "" } }),
  ).toThrow();
});
it("preserves historical evidence and validates the new blind-audio policy", () => {
  expect(validateStudioBoundaryReview(boundary)).toEqual(boundary);
  const blind: StudioBoundaryReview = {
    ...boundary,
    evidencePolicy: STUDIO_BOUNDARY_EVIDENCE_POLICY,
  };
  expect(validateStudioBoundaryReview(blind)).toEqual(blind);
  expect(() =>
    validateStudioBoundaryReview({
      ...boundary,
      // @ts-expect-error Exercise malformed persisted evidence at the runtime boundary.
      evidencePolicy: "unverified-transcript",
    }),
  ).toThrow("STUDIO_VIDEO_REVIEW_INVALID");
});
it("does not accept a general pass that contradicts its boundary evidence", () => {
  const plan = {
    outputs: [
      {
        channel: "youtube",
        language: "en",
        format: "short",
        title: "Title",
        body: "Body",
        rationale: "Rationale",
        sourceSegmentIds: ["end"],
      },
    ],
    translations: [],
    skippedChannels: [],
  } as Parameters<typeof validateStudioContentReview>[1];
  expect(() => validateStudioContentReview({ checks: [{ ...check, boundary }] }, plan)).toThrow(
    "STUDIO_VIDEO_REVIEW_INVALID",
  );
});

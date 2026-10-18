import { describe, expect, it } from "vitest";
import { type NativeBakeoffSample, nativeBakeoff } from "./native-bakeoff";
const sample: NativeBakeoffSample = {
  id: "video",
  language: "te",
  synthetic: true,
  sourceSha256: "a".repeat(64),
  reviewerId: "synthetic",
  reviewerAuthorized: true,
  referenceMoments: 3,
  detectedReferenceMoments: 2,
  reviewedCandidates: 3,
  acceptedWithoutMeaningCorrection: 2,
  withinTwoSeconds: 2,
  criticalTerms: 5,
  terminologyErrors: 1,
  reviewMinutes: 8,
  contextSafe: 2,
  negationPreserved: 3,
  translationsReviewed: 2,
  translationFaithful: 1,
  framingReviewed: 2,
  framingAcceptable: 2,
  reviewerEdits: 1,
  baselineReviewMinutes: 10,
};
describe("native corpus measurement", () => {
  it("reports measured dimensions separately without granting release approval", () => {
    expect(nativeBakeoff([sample])).toMatchObject({
      editorialAcceptance: 2 / 3,
      teachingRecall: 2 / 3,
      terminologyErrorRate: 0.2,
      translationFidelity: 0.5,
      minutesSaved: 2,
      realCorpusReady: false,
      releaseApproved: false,
    });
  });
  it("never qualifies a synthetic corpus or unauthorized reviewer", () => {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      ...sample,
      id: String(i),
      sourceSha256: i.toString(16).padStart(64, "0"),
      language: (i < 20 ? "te" : i < 25 ? "kn" : "ta") as "te" | "kn" | "ta",
    }));
    expect(nativeBakeoff(samples)).toMatchObject({ corpusComplete: true, realCorpusReady: false });
    expect(() => nativeBakeoff([{ ...sample, reviewerAuthorized: false }])).toThrow(
      "INVALID_REVIEWED_CORPUS",
    );
    expect(() => nativeBakeoff([{ ...sample, contextSafe: 4 }])).toThrow("INVALID_REVIEWED_CORPUS");
  });
});

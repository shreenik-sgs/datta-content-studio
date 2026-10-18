import { type NativeBenchmarkSample, nativeBenchmark } from "./native-intelligence";
export type NativeBakeoffSample = NativeBenchmarkSample & {
  synthetic: boolean;
  sourceSha256: string;
  reviewerId: string;
  reviewerAuthorized: boolean;
  referenceMoments: number;
  detectedReferenceMoments: number;
  contextSafe: number;
  negationPreserved: number;
  translationsReviewed: number;
  translationFaithful: number;
  framingReviewed: number;
  framingAcceptable: number;
  reviewerEdits: number;
  baselineReviewMinutes: number;
};
/** Human evaluation input; no model may assert reviewer authorization or quality.
 * Corpus readiness is not a release approval or a measured production outcome. */
export function nativeBakeoff(samples: readonly NativeBakeoffSample[]) {
  const numeric = [
    "referenceMoments",
    "detectedReferenceMoments",
    "reviewedCandidates",
    "acceptedWithoutMeaningCorrection",
    "withinTwoSeconds",
    "criticalTerms",
    "terminologyErrors",
    "reviewMinutes",
    "contextSafe",
    "negationPreserved",
    "translationsReviewed",
    "translationFaithful",
    "framingReviewed",
    "framingAcceptable",
    "reviewerEdits",
    "baselineReviewMinutes",
  ] as const;
  if (
    new Set(samples.map((s) => s.sourceSha256)).size !== samples.length ||
    samples.some(
      (s) =>
        typeof s.synthetic !== "boolean" ||
        numeric.some(
          (key) =>
            !Number.isFinite(s[key]) ||
            s[key] < 0 ||
            (!["reviewMinutes", "baselineReviewMinutes"].includes(key) &&
              !Number.isSafeInteger(s[key])),
        ),
    )
  )
    throw new Error("INVALID_REVIEWED_CORPUS");
  const basic = nativeBenchmark(samples);
  if (
    samples.some(
      (s) =>
        !s.id.trim() ||
        !s.reviewerId.trim() ||
        !s.reviewerAuthorized ||
        !/^[a-f0-9]{64}$/.test(s.sourceSha256) ||
        s.referenceMoments < 3 ||
        s.referenceMoments > 5 ||
        s.detectedReferenceMoments > s.referenceMoments ||
        s.contextSafe > s.reviewedCandidates ||
        s.negationPreserved > s.reviewedCandidates ||
        s.translationFaithful > s.translationsReviewed ||
        s.framingAcceptable > s.framingReviewed,
    )
  )
    throw new Error("INVALID_REVIEWED_CORPUS");
  const total = (key: keyof NativeBakeoffSample) => samples.reduce((n, s) => n + Number(s[key]), 0);
  const ratio = (a: number, b: number) => (b ? a / b : null);
  return {
    ...basic,
    realCorpusReady: basic.corpusComplete && samples.every((s) => !s.synthetic),
    teachingRecall: ratio(total("detectedReferenceMoments"), total("referenceMoments")),
    contextSafety: ratio(total("contextSafe"), basic.reviewed),
    negationPreservation: ratio(total("negationPreserved"), basic.reviewed),
    translationFidelity: ratio(total("translationFaithful"), total("translationsReviewed")),
    verticalFraming: ratio(total("framingAcceptable"), total("framingReviewed")),
    reviewerEdits: total("reviewerEdits"),
    minutesSaved: total("baselineReviewMinutes")
      ? total("baselineReviewMinutes") - basic.reviewMinutes
      : null,
    releaseApproved: false as const,
  };
}

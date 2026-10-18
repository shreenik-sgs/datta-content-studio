import type { StudioContentReview } from "./studio-content-review";

export const STUDIO_BOUNDARY_REVIEW_POLICY = "exact-native-audio-boundaries-v1";
export const STUDIO_BOUNDARY_EVIDENCE_POLICY = "audio-only-native-boundaries-v2";
export type StudioBoundaryFinding = {
  verdict: "complete" | "incomplete" | "uncertain";
  audibleWords: string;
  meaning: string;
  reason: string;
  needsOutsideSpeech: boolean;
  cutDuringWord: boolean;
};
export type StudioBoundaryReview = {
  policy: typeof STUDIO_BOUNDARY_REVIEW_POLICY;
  /** Absent on older review records; new checks are deliberately blind to ASR text. */
  evidencePolicy?: typeof STUDIO_BOUNDARY_EVIDENCE_POLICY;
  startMs: number;
  endMs: number;
  opening: StudioBoundaryFinding;
  ending: StudioBoundaryFinding;
};

/** A fluent translation, source punctuation or a general positive review cannot override a cut. */
export function studioBoundaryPasses(value: StudioBoundaryFinding): boolean {
  return value.verdict === "complete" && !value.needsOutsideSpeech && !value.cutDuringWord;
}
export function validateStudioBoundaryFinding(raw: unknown): StudioBoundaryFinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("STUDIO_VIDEO_REVIEW_INVALID");
  const v = raw as StudioBoundaryFinding;
  if (
    !["complete", "incomplete", "uncertain"].includes(v.verdict) ||
    [v.audibleWords, v.meaning, v.reason].some(
      (text) => typeof text !== "string" || !text.trim() || text.length > 2400,
    ) ||
    typeof v.needsOutsideSpeech !== "boolean" ||
    typeof v.cutDuringWord !== "boolean"
  )
    throw Error("STUDIO_VIDEO_REVIEW_INVALID");
  return v;
}
export function validateStudioBoundaryReview(
  v: StudioBoundaryReview,
  range?: { startMs: number; endMs: number },
): StudioBoundaryReview {
  if (
    !v ||
    v.policy !== STUDIO_BOUNDARY_REVIEW_POLICY ||
    (v.evidencePolicy !== undefined && v.evidencePolicy !== STUDIO_BOUNDARY_EVIDENCE_POLICY) ||
    !Number.isSafeInteger(v.startMs) ||
    !Number.isSafeInteger(v.endMs) ||
    v.startMs < 0 ||
    v.endMs <= v.startMs ||
    (range && (v.startMs !== range.startMs || v.endMs !== range.endMs))
  )
    throw Error("STUDIO_VIDEO_REVIEW_INVALID");
  validateStudioBoundaryFinding(v.opening);
  validateStudioBoundaryFinding(v.ending);
  return v;
}
export function applyStudioBoundaryReview(
  check: StudioContentReview,
  boundary: StudioBoundaryReview,
): StudioContentReview {
  validateStudioBoundaryReview(boundary);
  return {
    ...check,
    boundary,
    openingComplete: check.openingComplete && studioBoundaryPasses(boundary.opening),
    endingComplete: check.endingComplete && studioBoundaryPasses(boundary.ending),
    reason: [
      ...(["opening", "ending"] as const)
        .filter((k) => !studioBoundaryPasses(boundary[k]))
        .map(
          (k) =>
            `${k}: ${boundary[k].audibleWords} (${boundary[k].meaning}). ${boundary[k].reason}`,
        ),
      check.reason,
    ]
      .join(" ")
      .slice(0, 3000),
  };
}

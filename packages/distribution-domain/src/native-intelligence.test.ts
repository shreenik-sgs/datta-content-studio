import { describe, expect, it } from "vitest";
import type { TranscriptVersion } from "./intelligence";
import {
  INTEGRITY_CHECKS,
  type NativeAnalysis,
  type NativeReview,
  nativeApprovalDecision,
  nativeBenchmark,
  teachingIntegrity,
  validateNativeAnalysis,
} from "./native-intelligence";
const transcript: TranscriptVersion = {
  id: "t",
  parentVersionId: null,
  number: 1,
  masterVersionId: "v",
  sourceSha256: "a".repeat(64),
  language: "te",
  revision: 2,
  durationMs: 30000,
  segments: [
    { id: "a", startMs: 1000, endMs: 10000, originalText: "కృత్రిమ పరీక్ష", displayText: "కృత్రిమ పరీక్ష" },
    { id: "b", startMs: 10000, endMs: 20000, originalText: "పరీక్ష మాత్రమే", displayText: "పరీక్ష మాత్రమే" },
  ],
  provenance: {
    provider: "manual",
    model: null,
    promptVersion: null,
    schemaVersion: 1,
    recipeVersion: "v1",
  },
  review: {
    decision: "APPROVED",
    revision: 2,
    reviewerId: "r",
    reviewedAt: "2026-10-03T12:00:00Z",
  },
};
const fixture = (): NativeAnalysis => ({
  schemaVersion: 1,
  transcriptVersionId: "t",
  transcriptRevision: 2,
  sourceSha256: transcript.sourceSha256,
  language: "te",
  glossaryVersionIds: [],
  annotations: transcript.segments.map((s) => ({
    segmentId: s.id,
    confidence: 0.99,
    speakerId: "speaker",
    speakerName: "Synthetic speaker",
    languageSpans: [{ startMs: s.startMs, endMs: s.endMs, language: "te" }],
    words: [],
    englishShadow: "Synthetic test only",
    uncertainty: [],
  })),
  teachings: [
    {
      id: "meaning",
      segmentIds: ["a", "b"],
      kind: "qualification",
      nativeSummary: "కృత్రిమ పరీక్ష",
      englishShadow: null,
      requiredContextIds: ["b"],
    },
  ],
  candidates: [
    {
      id: "c",
      segmentIds: ["a", "b"],
      startMs: 1000,
      endMs: 20000,
      rationale: "Synthetic full-context fixture",
      attributedSpeakerId: "speaker",
      checks: INTEGRITY_CHECKS.map((check) => ({
        check,
        status: "PASS",
        evidence: "Synthetic test evidence",
        segmentIds: ["a", "b"],
      })),
      scores: {
        fidelity: 1,
        selfContainment: 1,
        contextCompleteness: 1,
        significance: 0.5,
        clarity: 0.9,
        accessibility: 0.8,
        visualSuitability: 0.5,
        hook: 0.2,
      },
    },
  ],
  provenance: { provider: "test", model: "synthetic", promptVersion: "v1", schemaVersion: 1 },
});
const review: NativeReview = {
  decision: "APPROVED",
  reason: "Synthetic review only",
  checks: INTEGRITY_CHECKS.map((check) => ({ check, evidence: "Synthetic evidence" })),
  reviewerId: "r",
  language: "te",
  reviewedAt: "2026-10-03T12:00:00Z",
  revision: 1,
};
describe("V3.2 native teaching governance", () => {
  it("requires authoritative approved native source, exact boundaries and complete traceability", () => {
    const a = fixture();
    expect(() => validateNativeAnalysis(a, transcript)).not.toThrow();
    expect(() =>
      validateNativeAnalysis({ ...a, teachings: [], candidates: [] }, transcript),
    ).toThrow("NATIVE_MEANING_REQUIRED");
    expect(() => validateNativeAnalysis({ ...a, language: "kn" }, transcript)).toThrow(
      "NATIVE_SOURCE_MISMATCH",
    );
    expect(() => validateNativeAnalysis(a, { ...transcript, review: null })).toThrow(
      "TRANSCRIPT_NOT_APPROVED",
    );
    requiredValue(a.candidates[0]).startMs++;
    expect(() => validateNativeAnalysis(a, transcript)).toThrow("INVALID_NATIVE_BOUNDARY");
  });
  it("rejects missing context and attribution even when all model scores are high", () => {
    const a = fixture();
    const c = requiredValue(a.candidates[0]);
    c.segmentIds = ["a"];
    c.endMs = 10000;
    expect(
      teachingIntegrity(a, c)
        .filter((c) => c.status === "FAIL")
        .map((c) => c.check),
    ).toEqual(["context", "negation", "instruction"]);
    expect(nativeApprovalDecision(a, c, review, ["te"]).allowed).toBe(false);
    c.segmentIds = ["a", "b"];
    requiredValue(a.annotations[1]).speakerId = "story-voice";
    expect(teachingIntegrity(a, c).find((c) => c.check === "attribution")?.status).toBe("FAIL");
  });
  it("requires current language qualification and all ten human evidence checks", () => {
    const a = fixture();
    const c = requiredValue(a.candidates[0]);
    expect(nativeApprovalDecision(a, c, null, ["te"]).allowed).toBe(false);
    expect(nativeApprovalDecision(a, c, review, ["kn"]).allowed).toBe(false);
    expect(
      nativeApprovalDecision(a, c, { ...review, checks: review.checks.slice(1) }, ["te"]).allowed,
    ).toBe(false);
    expect(nativeApprovalDecision(a, c, review, ["te"]).allowed).toBe(true);
    requiredValue(a.annotations[0]).confidence = 0.4;
    expect(teachingIntegrity(a, c).find((c) => c.check === "terminology")?.status).toBe("REVIEW");
  });
  it("rejects malformed language spans, confidence and duplicated integrity evidence", () => {
    const a = fixture();
    requiredValue(requiredValue(a.annotations[0]).languageSpans[0]).startMs = 0;
    expect(() => validateNativeAnalysis(a, transcript)).toThrow("INVALID_LANGUAGE_SPAN");
    const b = fixture();
    requiredValue(b.annotations[0]).words = [
      { startMs: 1000, endMs: 2000, text: "x", confidence: Number.NaN },
    ];
    expect(() => validateNativeAnalysis(b, transcript)).toThrow("INVALID_WORD_SPAN");
    const c = fixture();
    requiredValue(c.candidates[0]).checks.fill(
      requiredValue(requiredValue(c.candidates[0]).checks[0]),
    );
    expect(() => validateNativeAnalysis(c, transcript)).toThrow("INTEGRITY_EVIDENCE_REQUIRED");
  });
  it("never presents missing benchmark evidence as passing quality", () => {
    const unreviewed = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      language: (i < 20 ? "te" : i < 25 ? "kn" : "ta") as "te" | "kn" | "ta",
      reviewedCandidates: 0,
      acceptedWithoutMeaningCorrection: 0,
      withinTwoSeconds: 0,
      criticalTerms: 0,
      terminologyErrors: 0,
      reviewMinutes: 0,
    }));
    expect(nativeBenchmark(unreviewed).corpusComplete).toBe(false);
    expect(
      nativeBenchmark(unreviewed.map((s) => ({ ...s, referenceMoments: 3, reviewedCandidates: 3 })))
        .corpusComplete,
    ).toBe(true);
    expect(nativeBenchmark([])).toMatchObject({
      corpusComplete: false,
      editorialAcceptance: null,
      boundaryPrecision: null,
      terminologyErrorRate: null,
    });
    expect(() =>
      nativeBenchmark([
        {
          id: "x",
          language: "te",
          reviewedCandidates: 1,
          acceptedWithoutMeaningCorrection: 2,
          withinTwoSeconds: 1,
          criticalTerms: 1,
          terminologyErrors: 0,
          reviewMinutes: 1,
        },
      ]),
    ).toThrow("INVALID_BENCHMARK");
  });
});

function requiredValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("REQUIRED_VALUE_MISSING");
  return value;
}

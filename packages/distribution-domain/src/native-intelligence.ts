import { type TranscriptVersion, isEditorialApproved, validateTranscript } from "./intelligence";
export const NATIVE_LANGUAGES = ["te", "kn", "ta"] as const;
export type NativeLanguage = (typeof NATIVE_LANGUAGES)[number];
export const INTEGRITY_CHECKS = [
  "self_containment",
  "context",
  "negation",
  "attribution",
  "pronouns",
  "instruction",
  "quote_fidelity",
  "boundaries",
  "terminology",
  "visual_audio",
] as const;
export type IntegrityCheck = (typeof INTEGRITY_CHECKS)[number];
export type IntegrityEvidence = {
  check: IntegrityCheck;
  status: "PASS" | "REVIEW" | "FAIL";
  evidence: string;
  segmentIds: string[];
};
export type NativeAnnotation = {
  segmentId: string;
  confidence: number;
  speakerId: string;
  speakerName: string;
  languageSpans: {
    startMs: number;
    endMs: number;
    language: "te" | "kn" | "ta" | "sa" | "en";
  }[];
  words: {
    startMs: number;
    endMs: number;
    text: string;
    confidence: number;
  }[];
  englishShadow: string | null;
  uncertainty: string[];
};
export type TeachingSegment = {
  id: string;
  segmentIds: string[];
  kind:
    | "introduction"
    | "proposition"
    | "explanation"
    | "story"
    | "instruction"
    | "qualification"
    | "conclusion"
    | "blessing";
  nativeSummary: string;
  englishShadow: string | null;
  requiredContextIds: string[];
};
export type NativeCandidate = {
  id: string;
  segmentIds: string[];
  startMs: number;
  endMs: number;
  rationale: string;
  attributedSpeakerId: string;
  checks: IntegrityEvidence[];
  scores: {
    fidelity: number;
    selfContainment: number;
    contextCompleteness: number;
    significance: number;
    clarity: number;
    accessibility: number;
    visualSuitability: number;
    hook: number;
  };
};
export type NativeAnalysis = {
  schemaVersion: 1;
  transcriptVersionId: string;
  transcriptRevision: number;
  sourceSha256: string;
  language: NativeLanguage;
  glossaryVersionIds: string[];
  annotations: NativeAnnotation[];
  teachings: TeachingSegment[];
  candidates: NativeCandidate[];
  provenance: {
    provider: string;
    model: string;
    promptVersion: string;
    schemaVersion: 1;
  };
};
export function validateNativeSource(
  analysis: Pick<
    NativeAnalysis,
    "transcriptVersionId" | "transcriptRevision" | "sourceSha256" | "language" | "annotations"
  >,
  transcript: TranscriptVersion,
): void {
  validateTranscript(transcript);
  if (
    analysis.transcriptVersionId !== transcript.id ||
    analysis.transcriptRevision !== transcript.revision ||
    analysis.sourceSha256 !== transcript.sourceSha256 ||
    analysis.language !== transcript.language ||
    !NATIVE_LANGUAGES.includes(analysis.language)
  )
    throw new Error("NATIVE_SOURCE_MISMATCH");
  if (!isEditorialApproved(transcript.review, transcript.revision))
    throw new Error("TRANSCRIPT_NOT_APPROVED");
  const ids = new Set(transcript.segments.map((s) => s.id));
  if (
    analysis.annotations.length !== ids.size ||
    new Set(analysis.annotations.map((a) => a.segmentId)).size !== ids.size ||
    analysis.annotations.some((a) => !ids.has(a.segmentId))
  )
    throw new Error("NATIVE_TRACEABILITY_REQUIRED");
  for (const a of analysis.annotations) {
    const segment = requiredValue(transcript.segments.find((s) => s.id === a.segmentId));
    if (
      !a.speakerId.trim() ||
      !a.speakerName.trim() ||
      !Number.isFinite(a.confidence) ||
      a.confidence < 0 ||
      a.confidence > 1 ||
      !a.languageSpans.length
    )
      throw new Error("INVALID_NATIVE_ANNOTATION");
    let end = segment.startMs;
    for (const span of a.languageSpans) {
      if (
        span.startMs !== end ||
        span.endMs <= span.startMs ||
        span.endMs > segment.endMs ||
        !["te", "kn", "ta", "sa", "en"].includes(span.language)
      )
        throw new Error("INVALID_LANGUAGE_SPAN");
      end = span.endMs;
    }
    if (end !== segment.endMs) throw new Error("INVALID_LANGUAGE_SPAN");
    let wordEnd = segment.startMs;
    for (const word of a.words) {
      if (
        word.startMs < wordEnd ||
        word.endMs <= word.startMs ||
        word.endMs > segment.endMs ||
        !Number.isFinite(word.startMs) ||
        !Number.isFinite(word.endMs) ||
        !Number.isFinite(word.confidence) ||
        word.confidence < 0 ||
        word.confidence > 1 ||
        !word.text.trim()
      )
        throw new Error("INVALID_WORD_SPAN");
      wordEnd = word.endMs;
    }
  }
}
export function validateNativeAnalysis(
  analysis: NativeAnalysis,
  transcript: TranscriptVersion,
): void {
  validateNativeSource(analysis, transcript);
  if (!analysis.teachings.length || !analysis.candidates.length)
    throw new Error("NATIVE_MEANING_REQUIRED");
  const ids = new Set(transcript.segments.map((s) => s.id));
  const validIds = (refs: string[]) =>
    refs.length > 0 && new Set(refs).size === refs.length && refs.every((id) => ids.has(id));
  if (
    new Set(analysis.candidates.map((c) => c.id)).size !== analysis.candidates.length ||
    new Set(analysis.teachings.map((t) => t.id)).size !== analysis.teachings.length
  )
    throw new Error("DUPLICATE_NATIVE_ID");
  for (const teaching of analysis.teachings)
    if (!validIds(teaching.segmentIds) || teaching.requiredContextIds.some((id) => !ids.has(id)))
      throw new Error("INVALID_TEACHING_SOURCE");
  for (const candidate of analysis.candidates) {
    const first = transcript.segments.findIndex((s) => s.id === candidate.segmentIds[0]);
    const selected = transcript.segments.slice(first, first + candidate.segmentIds.length);
    if (
      !validIds(candidate.segmentIds) ||
      selected.some((s, i) => s.id !== candidate.segmentIds[i]) ||
      candidate.startMs !== selected[0]?.startMs ||
      candidate.endMs !== selected.at(-1)?.endMs
    )
      throw new Error("INVALID_NATIVE_BOUNDARY");
    if (
      candidate.checks.length !== INTEGRITY_CHECKS.length ||
      new Set(candidate.checks.map((c) => c.check)).size !== INTEGRITY_CHECKS.length ||
      candidate.checks.some(
        (c) => !INTEGRITY_CHECKS.includes(c.check) || !c.evidence.trim() || !validIds(c.segmentIds),
      )
    )
      throw new Error("INTEGRITY_EVIDENCE_REQUIRED");
    if (Object.values(candidate.scores).some((n) => !Number.isFinite(n) || n < 0 || n > 1))
      throw new Error("INVALID_CANDIDATE_SCORE");
  }
}
/** Deterministic safeguards supplement semantic review; they never claim to understand doctrine. */
export function teachingIntegrity(
  analysis: NativeAnalysis,
  candidate: NativeCandidate,
): IntegrityEvidence[] {
  return INTEGRITY_CHECKS.map((check) => {
    const evidence = candidate.checks.find((c) => c.check === check);
    let result: IntegrityEvidence = evidence
      ? { ...evidence }
      : {
          check,
          status: "REVIEW",
          evidence: "Review evidence is missing.",
          segmentIds: candidate.segmentIds,
        };
    const selected = analysis.annotations.filter((a) => candidate.segmentIds.includes(a.segmentId));
    if (check === "context" || check === "negation" || check === "instruction") {
      const missing = analysis.teachings
        .filter((t) => t.segmentIds.some((id) => candidate.segmentIds.includes(id)))
        .flatMap((t) => t.requiredContextIds)
        .filter((id) => !candidate.segmentIds.includes(id));
      if (missing.length)
        result = {
          check,
          status: "FAIL",
          evidence: "Required source context lies outside this boundary.",
          segmentIds: [...new Set(missing)],
        };
    }
    if (
      check === "attribution" &&
      selected.some((a) => a.speakerId !== candidate.attributedSpeakerId)
    )
      result = {
        check,
        status: "FAIL",
        evidence:
          "The selected words include a different speaker. Preserve attribution or choose another boundary.",
        segmentIds: selected.map((a) => a.segmentId),
      };
    if (
      (check === "terminology" || check === "quote_fidelity") &&
      selected.some(
        (a) =>
          a.confidence < 0.85 ||
          a.uncertainty.length > 0 ||
          a.words.some((w) => w.confidence < 0.85),
      )
    )
      result = {
        check,
        status: result.status === "FAIL" ? "FAIL" : "REVIEW",
        evidence:
          "Native wording contains uncertainty or low-confidence recognition. Correct the transcript or document native review.",
        segmentIds: selected.map((a) => a.segmentId),
      };
    return result;
  });
}
export type NativeReview = {
  decision: "APPROVED" | "REJECTED";
  reason: string;
  checks: {
    check: IntegrityCheck;
    evidence: string;
  }[];
  reviewerId: string;
  language: NativeLanguage;
  reviewedAt: string;
  revision: number;
};
export function nativeApprovalDecision(
  analysis: NativeAnalysis,
  candidate: NativeCandidate,
  review: NativeReview | null,
  reviewerLanguages: readonly string[],
) {
  const checks = teachingIntegrity(analysis, candidate);
  if (checks.some((c) => c.status === "FAIL"))
    return { allowed: false, reason: "TEACHING_INTEGRITY_FAILED" } as const;
  if (
    !review ||
    review.decision !== "APPROVED" ||
    review.language !== analysis.language ||
    !reviewerLanguages.includes(analysis.language) ||
    !review.reason.trim()
  )
    return { allowed: false, reason: "NATIVE_REVIEW_REQUIRED" } as const;
  if (
    INTEGRITY_CHECKS.some(
      (check) => !review.checks.some((c) => c.check === check && c.evidence.trim()),
    )
  )
    return { allowed: false, reason: "INTEGRITY_EVIDENCE_REQUIRED" } as const;
  return { allowed: true } as const;
}
export type NativeBenchmarkSample = {
  id: string;
  language: NativeLanguage;
  /** Human-marked reference moments, independently recorded before candidate review. */
  referenceMoments?: number;
  reviewedCandidates: number;
  acceptedWithoutMeaningCorrection: number;
  withinTwoSeconds: number;
  criticalTerms: number;
  terminologyErrors: number;
  reviewMinutes: number;
};
export function nativeBenchmark(samples: readonly NativeBenchmarkSample[]) {
  if (
    new Set(samples.map((s) => s.id)).size !== samples.length ||
    samples.some(
      (s) =>
        !NATIVE_LANGUAGES.includes(s.language) ||
        Object.entries(s).some(
          ([k, v]) =>
            typeof v === "number" &&
            (!Number.isFinite(v) ||
              v < 0 ||
              (!["reviewMinutes", "baselineReviewMinutes"].includes(k) &&
                !Number.isSafeInteger(v))),
        ) ||
        s.acceptedWithoutMeaningCorrection > s.reviewedCandidates ||
        s.withinTwoSeconds > s.reviewedCandidates ||
        s.terminologyErrors > s.criticalTerms,
    )
  )
    throw new Error("INVALID_BENCHMARK");
  const sum = (
    key:
      | "reviewedCandidates"
      | "acceptedWithoutMeaningCorrection"
      | "withinTwoSeconds"
      | "criticalTerms"
      | "terminologyErrors"
      | "reviewMinutes",
  ) => samples.reduce((n, s) => n + s[key], 0);
  const reviewed = sum("reviewedCandidates");
  const terms = sum("criticalTerms");
  const corpus = Object.fromEntries(
    NATIVE_LANGUAGES.map((l) => [l, samples.filter((s) => s.language === l).length]),
  );
  return {
    corpus,
    corpusComplete: NATIVE_LANGUAGES.every(
      (language) =>
        samples.filter(
          (s) =>
            s.language === language &&
            (s.referenceMoments ?? 0) >= 3 &&
            (s.referenceMoments ?? 0) <= 5 &&
            s.reviewedCandidates > 0,
        ).length >= (language === "te" ? 20 : 5),
    ),
    reviewed,
    editorialAcceptance: reviewed ? sum("acceptedWithoutMeaningCorrection") / reviewed : null,
    boundaryPrecision: reviewed ? sum("withinTwoSeconds") / reviewed : null,
    terminologyErrorRate: terms ? sum("terminologyErrors") / terms : null,
    reviewMinutes: sum("reviewMinutes"),
  };
}

function requiredValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("REQUIRED_VALUE_MISSING");
  return value;
}

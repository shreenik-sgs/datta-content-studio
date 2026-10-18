import { describe, expect, it } from "vitest";
import {
  type QuoteCandidate,
  type TranscriptSegment,
  type TranscriptVersion,
  effectiveQuoteDecision,
  evaluateEditorialCorpus,
  glossarySuggestions,
  quoteReviewDecision,
  reviewQuote,
  reviewTranscript,
  reviseTranscript,
  sourceContextWindow,
  validateTranscript,
} from "./index";
const now = "2026-09-29T12:00:00Z";
const transcript: TranscriptVersion = {
  id: "transcript-1",
  parentVersionId: null,
  number: 1,
  masterVersionId: "master-version",
  sourceSha256: "a".repeat(64),
  language: "en",
  revision: 2,
  durationMs: 30000,
  segments: [
    {
      id: "s1",
      startMs: 2000,
      endMs: 5000,
      originalText: "Jaya Guru Datta.",
      displayText: "Jaya Guru Datta.",
    },
    {
      id: "s2",
      startMs: 5000,
      endMs: 9000,
      originalText: "Practice with devotion.",
      displayText: "Practice with devotion.",
    },
    {
      id: "s3",
      startMs: 12000,
      endMs: 15000,
      originalText: "Return tomorrow.",
      displayText: "Return tomorrow.",
    },
  ],
  provenance: {
    provider: "manual",
    model: null,
    promptVersion: null,
    schemaVersion: 1,
    recipeVersion: "manual-1",
  },
  review: { decision: "APPROVED", reviewerId: "reviewer", reviewedAt: now, revision: 2 },
};
const quote: QuoteCandidate = {
  id: "q1",
  kind: "EXACT_QUOTE",
  masterVersionId: "master-version",
  sourceSha256: "a".repeat(64),
  transcriptVersionId: "transcript-1",
  transcriptRevision: 2,
  segmentIds: ["s1", "s2"],
  startMs: 2000,
  endMs: 9000,
  text: "Jaya Guru Datta. Practice with devotion.",
  revision: 1,
  review: null,
  provenance: transcript.provenance,
};

describe("DS-DIST-R2 source and quote protection", () => {
  it("DS-DIST-R2-SOURCE refuses reversed, overlapping, duplicated and out-of-range segments", () => {
    expect(() => validateTranscript(transcript)).not.toThrow();
    for (const segments of [
      [{ ...(transcript.segments[0] as TranscriptSegment), endMs: 1000 }],
      [
        { ...(transcript.segments[0] as TranscriptSegment) },
        { ...(transcript.segments[1] as TranscriptSegment), startMs: 3000 },
      ],
      [
        { ...(transcript.segments[0] as TranscriptSegment) },
        { ...(transcript.segments[1] as TranscriptSegment), id: "s1" },
      ],
      [{ ...(transcript.segments[0] as TranscriptSegment), endMs: 31000 }],
    ])
      expect(() => validateTranscript({ ...transcript, segments })).toThrow("INVALID_TRANSCRIPT");
  });
  it("DS-DIST-R2-SOURCE preserves original text and discards approval in corrected versions", () => {
    const corrected = reviseTranscript({
      transcript,
      expectedRevision: 2,
      newId: "transcript-2",
      corrections: [{ segmentId: "s1", displayText: "Jaya Guru Datta!" }],
    });
    expect(corrected.parentVersionId).toBe(transcript.id);
    expect(corrected.number).toBe(2);
    expect(corrected.review).toBeNull();
    expect(corrected.segments[0]).toMatchObject({
      originalText: "Jaya Guru Datta.",
      displayText: "Jaya Guru Datta!",
    });
    expect((transcript.segments[0] as TranscriptSegment).displayText).toBe("Jaya Guru Datta.");
    expect(() =>
      reviseTranscript({ transcript, expectedRevision: 1, newId: "t2", corrections: [] }),
    ).toThrow("REVISION_CONFLICT");
    expect(() =>
      reviseTranscript({ transcript, expectedRevision: 2, newId: transcript.id, corrections: [] }),
    ).toThrow("INVALID_TRANSCRIPT_VERSION");
  });
  it("DS-DIST-R2-REVIEW requires an explicit human reviewer and rejects stale decisions", () => {
    const draft = { ...transcript, review: null };
    expect(
      reviewTranscript({
        transcript: draft,
        expectedRevision: 2,
        decision: "APPROVED",
        reviewerId: "human",
        reviewedAt: now,
      }).review,
    ).toMatchObject({ decision: "APPROVED", revision: 3 });
    expect(() =>
      reviewTranscript({
        transcript: draft,
        expectedRevision: 1,
        decision: "APPROVED",
        reviewerId: "human",
        reviewedAt: now,
      }),
    ).toThrow("REVISION_CONFLICT");
    expect(() =>
      reviewTranscript({
        transcript: draft,
        expectedRevision: 2,
        decision: "APPROVED",
        reviewerId: "",
        reviewedAt: now,
      }),
    ).toThrow("INVALID_REVIEW");
  });
  it("DS-DIST-R2-QUOTE requires exact reviewed words, source, timecodes and contiguous segments", () => {
    expect(quoteReviewDecision({ quote, transcript })).toEqual({ allowed: true });
    for (const patch of [
      { text: "Devotion is good." },
      { text: "Jaya Guru Datta! Practice with devotion." },
      { segmentIds: ["s1", "s3"] },
      { startMs: 0 },
      { endMs: 8000 },
      { sourceSha256: "b".repeat(64) },
      { transcriptRevision: 1 },
      { kind: "SUMMARY" as const },
    ])
      expect(quoteReviewDecision({ quote: { ...quote, ...patch }, transcript }).allowed).toBe(
        false,
      );
    expect(
      quoteReviewDecision({ quote, transcript: { ...transcript, review: null } }),
    ).toMatchObject({ reason: "TRANSCRIPT_NOT_APPROVED" });
  });
  it("DS-DIST-R2-QUOTE includes source context bounded to the media duration", () => {
    expect(
      sourceContextWindow({ startMs: 2000, endMs: 9000, durationMs: 30000, contextMs: 5000 }),
    ).toEqual({ startMs: 0, endMs: 14000 });
    expect(() =>
      sourceContextWindow({ startMs: 9000, endMs: 2000, durationMs: 30000, contextMs: 5000 }),
    ).toThrow("INVALID_SOURCE_SPAN");
  });
  it("DS-DIST-R2-GLOSSARY returns suggestions without changing original words or regex execution", () => {
    const text = "Ganapati Sachidananda and a.b";
    expect(
      glossarySuggestions(
        text,
        [
          { id: "name", term: "Sachidananda", preferred: "Sachchidananda", language: "en" },
          { id: "literal", term: "a.b", preferred: "literal", language: "en" },
        ],
        "en",
      ),
    ).toEqual([
      { entryId: "name", start: 9, end: 21, replacement: "Sachchidananda" },
      { entryId: "literal", start: 26, end: 29, replacement: "literal" },
    ]);
    expect(text).toBe("Ganapati Sachidananda and a.b");
  });
  it("DS-DIST-R2-EVALUATION never reports untested quality as perfect", () => {
    expect(evaluateEditorialCorpus([])).toEqual({
      samples: 0,
      exactQuotePasses: 0,
      exactQuoteRate: null,
      criticalGlossaryErrors: 0,
      glossaryTerms: 0,
      criticalGlossaryErrorRate: null,
    });
    expect(
      evaluateEditorialCorpus([
        {
          sampleId: "a",
          recipeVersion: "v1",
          exactQuotePass: true,
          criticalGlossaryErrors: 1,
          glossaryTerms: 100,
        },
        {
          sampleId: "b",
          recipeVersion: "v1",
          exactQuotePass: false,
          criticalGlossaryErrors: 0,
          glossaryTerms: 100,
        },
      ]),
    ).toEqual({
      samples: 2,
      exactQuotePasses: 1,
      exactQuoteRate: 0.5,
      criticalGlossaryErrors: 1,
      glossaryTerms: 200,
      criticalGlossaryErrorRate: 0.005,
    });
  });
});

it("DS-DIST-R2-REVIEW never approves an altered or stale candidate, and records human rejection", () => {
  expect(
    reviewQuote({
      quote,
      transcript,
      expectedRevision: 1,
      decision: "APPROVED",
      reviewerId: "human",
      reviewedAt: now,
    }).review,
  ).toMatchObject({ decision: "APPROVED", revision: 2 });
  expect(() =>
    reviewQuote({
      quote: { ...quote, text: "Made up" },
      transcript,
      expectedRevision: 1,
      decision: "APPROVED",
      reviewerId: "human",
      reviewedAt: now,
    }),
  ).toThrow("QUOTE_TEXT_MISMATCH");
  expect(() =>
    reviewQuote({
      quote,
      transcript,
      expectedRevision: 2,
      decision: "APPROVED",
      reviewerId: "human",
      reviewedAt: now,
    }),
  ).toThrow("REVISION_CONFLICT");
  expect(
    reviewQuote({
      quote: { ...quote, text: "Made up" },
      transcript,
      expectedRevision: 1,
      decision: "REJECTED",
      reviewerId: "human",
      reviewedAt: now,
    }).review?.decision,
  ).toBe("REJECTED");
});

it("DS-DIST-R2-EVALUATION refuses mixed model recipes and duplicated corpus evidence", () => {
  const sample = {
    sampleId: "a",
    recipeVersion: "v1",
    exactQuotePass: true,
    criticalGlossaryErrors: 0,
    glossaryTerms: 100,
  };
  expect(() =>
    evaluateEditorialCorpus([sample, { ...sample, sampleId: "b", recipeVersion: "v2" }]),
  ).toThrow("INVALID_CORPUS_SAMPLE");
  expect(() => evaluateEditorialCorpus([sample, sample])).toThrow("INVALID_CORPUS_SAMPLE");
});
it("DS-DIST-R2-REVIEW requires offset-aware timestamps and bounds glossary expansion", () => {
  expect(() =>
    reviewTranscript({
      transcript,
      expectedRevision: 2,
      decision: "APPROVED",
      reviewerId: "human",
      reviewedAt: "2026-09-29T12:00:00",
    }),
  ).toThrow("INVALID_REVIEW");
  expect(() =>
    glossarySuggestions(
      "x".repeat(10001),
      [{ id: "x", term: "x", preferred: "y", language: "en" }],
      "en",
    ),
  ).toThrow("GLOSSARY_MATCH_LIMIT");
});

it("DS-DIST-R2-QUOTE historical approval is unusable after source replacement, correction, rejection or withdrawal", () => {
  const approvedQuote = {
    ...quote,
    revision: 2,
    review: { decision: "APPROVED" as const, reviewerId: "human", reviewedAt: now, revision: 2 },
  };
  const input = {
    quote: approvedQuote,
    transcript,
    currentMasterVersionId: transcript.masterVersionId,
    sourceWithdrawn: false,
    transcriptSuperseded: false,
  };
  expect(effectiveQuoteDecision(input)).toEqual({ allowed: true });
  expect(effectiveQuoteDecision({ ...input, sourceWithdrawn: true })).toMatchObject({
    reason: "CONTENT_WITHDRAWN",
  });
  expect(effectiveQuoteDecision({ ...input, currentMasterVersionId: "replacement" })).toMatchObject(
    { reason: "SOURCE_VERSION_STALE" },
  );
  expect(effectiveQuoteDecision({ ...input, transcriptSuperseded: true })).toMatchObject({
    reason: "TRANSCRIPT_SUPERSEDED",
  });
  expect(effectiveQuoteDecision({ ...input, quote })).toMatchObject({
    reason: "QUOTE_NOT_APPROVED",
  });
  expect(
    effectiveQuoteDecision({
      ...input,
      transcript: {
        ...transcript,
        review: {
          decision: "REJECTED",
          reviewerId: "human",
          reviewedAt: now,
          revision: transcript.revision,
        },
      },
    }),
  ).toMatchObject({ reason: "TRANSCRIPT_NOT_APPROVED" });
  expect(approvedQuote.review.decision).toBe("APPROVED");
});

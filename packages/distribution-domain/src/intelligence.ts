import { requireContentRevision } from "./content";

export type EditorialProvenance = {
  provider: string;
  model: string | null;
  promptVersion: string | null;
  schemaVersion: number;
  recipeVersion: string;
};
export type EditorialReview = {
  decision: "APPROVED" | "REJECTED";
  reviewerId: string;
  reviewedAt: string;
  revision: number;
};
export type TranscriptSegment = {
  id: string;
  startMs: number;
  endMs: number;
  originalText: string;
  displayText: string;
};
export type TranscriptVersion = {
  id: string;
  parentVersionId: string | null;
  number: number;
  masterVersionId: string;
  sourceSha256: string;
  language: string;
  revision: number;
  durationMs: number;
  segments: TranscriptSegment[];
  provenance: EditorialProvenance;
  review: EditorialReview | null;
};
export type QuoteCandidate = {
  id: string;
  kind: "EXACT_QUOTE" | "SUMMARY";
  masterVersionId: string;
  sourceSha256: string;
  transcriptVersionId: string;
  transcriptRevision: number;
  segmentIds: string[];
  startMs: number;
  endMs: number;
  text: string;
  revision: number;
  review: EditorialReview | null;
  provenance: EditorialProvenance;
};
export type GlossaryEntry = { id: string; term: string; preferred: string; language: string };
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const text = (value: string, maximum = 4000) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const validInstant = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
function validProvenance(value: EditorialProvenance): boolean {
  return (
    text(value.provider, 100) &&
    text(value.recipeVersion, 100) &&
    positive(value.schemaVersion) &&
    (value.provider === "manual"
      ? value.model === null && value.promptVersion === null
      : value.model !== null &&
        text(value.model, 100) &&
        value.promptVersion !== null &&
        text(value.promptVersion, 100))
  );
}
function validReview(value: EditorialReview): boolean {
  return (
    ["APPROVED", "REJECTED"].includes(value.decision) &&
    text(value.reviewerId, 128) &&
    positive(value.revision) &&
    validInstant(value.reviewedAt)
  );
}
export function validateTranscript(value: TranscriptVersion): void {
  if (
    !text(value.id, 128) ||
    !text(value.masterVersionId, 128) ||
    !/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
    !positive(value.number) ||
    !positive(value.revision) ||
    !positive(value.durationMs) ||
    !text(value.language, 16) ||
    !validProvenance(value.provenance) ||
    value.parentVersionId === value.id ||
    !Array.isArray(value.segments) ||
    value.segments.length < 1 ||
    value.segments.length > 20000 ||
    (value.review !== null &&
      (!validReview(value.review) || value.review.revision > value.revision))
  )
    throw new Error("INVALID_TRANSCRIPT");
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const segment of value.segments) {
    if (
      !text(segment.id, 128) ||
      ids.has(segment.id) ||
      !Number.isSafeInteger(segment.startMs) ||
      !positive(segment.endMs) ||
      segment.startMs < previousEnd ||
      segment.endMs <= segment.startMs ||
      segment.endMs > value.durationMs ||
      !text(segment.originalText) ||
      !text(segment.displayText)
    )
      throw new Error("INVALID_TRANSCRIPT");
    ids.add(segment.id);
    previousEnd = segment.endMs;
  }
}
export function reviseTranscript(input: {
  transcript: TranscriptVersion;
  expectedRevision: number;
  newId: string;
  corrections: { segmentId: string; displayText: string }[];
}): TranscriptVersion {
  const { transcript, newId, corrections } = input;
  requireContentRevision(transcript.revision, input.expectedRevision);
  validateTranscript(transcript);
  if (
    !text(newId, 128) ||
    newId === transcript.id ||
    corrections.length < 1 ||
    corrections.length > transcript.segments.length ||
    new Set(corrections.map((item) => item.segmentId)).size !== corrections.length
  )
    throw new Error("INVALID_TRANSCRIPT_VERSION");
  const changes = new Map(corrections.map((item) => [item.segmentId, item.displayText]));
  if (
    corrections.some(
      (item) =>
        !text(item.displayText) ||
        !transcript.segments.some((segment) => segment.id === item.segmentId),
    )
  )
    throw new Error("INVALID_TRANSCRIPT_VERSION");
  const corrected: TranscriptVersion = {
    ...transcript,
    id: newId,
    parentVersionId: transcript.id,
    number: transcript.number + 1,
    revision: 1,
    review: null,
    segments: transcript.segments.map((segment) => ({
      ...segment,
      displayText: changes.get(segment.id) ?? segment.displayText,
    })),
    provenance: {
      provider: "manual",
      model: null,
      promptVersion: null,
      schemaVersion: 1,
      recipeVersion: "human-correction-v1",
    },
  };
  validateTranscript(corrected);
  return corrected;
}
export function reviewTranscript(input: {
  transcript: TranscriptVersion;
  expectedRevision: number;
  decision: EditorialReview["decision"];
  reviewerId: string;
  reviewedAt: string;
}): TranscriptVersion {
  requireContentRevision(input.transcript.revision, input.expectedRevision);
  validateTranscript(input.transcript);
  const revision = input.transcript.revision + 1;
  const review: EditorialReview = {
    decision: input.decision,
    reviewerId: input.reviewerId,
    reviewedAt: input.reviewedAt,
    revision,
  };
  if (!validReview(review)) throw new Error("INVALID_REVIEW");
  return { ...input.transcript, revision, review };
}
export type QuoteRefusal =
  | "INVALID_TRANSCRIPT"
  | "TRANSCRIPT_NOT_APPROVED"
  | "SOURCE_MISMATCH"
  | "NOT_EXACT_QUOTE"
  | "INVALID_SOURCE_SPAN"
  | "QUOTE_TEXT_MISMATCH";
export type QuoteDecision = { allowed: true } | { allowed: false; reason: QuoteRefusal };
const exactText = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();
export function quoteReviewDecision(input: {
  quote: QuoteCandidate;
  transcript: TranscriptVersion;
}): QuoteDecision {
  const { quote, transcript } = input;
  try {
    validateTranscript(transcript);
  } catch {
    return { allowed: false, reason: "INVALID_TRANSCRIPT" };
  }
  if (
    !transcript.review ||
    transcript.review.decision !== "APPROVED" ||
    transcript.review.revision !== transcript.revision
  )
    return { allowed: false, reason: "TRANSCRIPT_NOT_APPROVED" };
  if (
    quote.masterVersionId !== transcript.masterVersionId ||
    quote.sourceSha256 !== transcript.sourceSha256 ||
    quote.transcriptVersionId !== transcript.id ||
    quote.transcriptRevision !== transcript.revision
  )
    return { allowed: false, reason: "SOURCE_MISMATCH" };
  if (quote.kind !== "EXACT_QUOTE") return { allowed: false, reason: "NOT_EXACT_QUOTE" };
  if (quote.segmentIds.length < 1 || quote.segmentIds.length > transcript.segments.length)
    return { allowed: false, reason: "INVALID_SOURCE_SPAN" };
  const first = transcript.segments.findIndex((segment) => segment.id === quote.segmentIds[0]);
  const segments = transcript.segments.slice(first, first + quote.segmentIds.length);
  if (
    first < 0 ||
    segments.length !== quote.segmentIds.length ||
    segments.some((segment, index) => segment.id !== quote.segmentIds[index]) ||
    quote.startMs !== segments[0]?.startMs ||
    quote.endMs !== segments.at(-1)?.endMs
  )
    return { allowed: false, reason: "INVALID_SOURCE_SPAN" };
  if (exactText(quote.text) !== exactText(segments.map((segment) => segment.displayText).join(" ")))
    return { allowed: false, reason: "QUOTE_TEXT_MISMATCH" };
  return { allowed: true };
}
export type EffectiveQuoteRefusal =
  | QuoteRefusal
  | "CONTENT_WITHDRAWN"
  | "SOURCE_VERSION_STALE"
  | "TRANSCRIPT_SUPERSEDED"
  | "QUOTE_NOT_APPROVED";
export type EffectiveQuoteDecision =
  | { allowed: true }
  | { allowed: false; reason: EffectiveQuoteRefusal };
/** Historical human decisions remain immutable; usability follows current source lineage. */
export function effectiveQuoteDecision(input: {
  quote: QuoteCandidate;
  transcript: TranscriptVersion;
  currentMasterVersionId: string;
  sourceWithdrawn: boolean;
  transcriptSuperseded: boolean;
}): EffectiveQuoteDecision {
  if (input.sourceWithdrawn) return { allowed: false, reason: "CONTENT_WITHDRAWN" };
  if (
    input.quote.masterVersionId !== input.currentMasterVersionId ||
    input.transcript.masterVersionId !== input.currentMasterVersionId
  )
    return { allowed: false, reason: "SOURCE_VERSION_STALE" };
  if (input.transcriptSuperseded) return { allowed: false, reason: "TRANSCRIPT_SUPERSEDED" };
  const sourceDecision = quoteReviewDecision(input);
  if (!sourceDecision.allowed) return sourceDecision;
  if (!isEditorialApproved(input.quote.review, input.quote.revision))
    return { allowed: false, reason: "QUOTE_NOT_APPROVED" };
  return { allowed: true };
}
export function sourceContextWindow(input: {
  startMs: number;
  endMs: number;
  durationMs: number;
  contextMs: number;
}): { startMs: number; endMs: number } {
  if (
    !Number.isSafeInteger(input.startMs) ||
    input.startMs < 0 ||
    !positive(input.endMs) ||
    !positive(input.durationMs) ||
    input.endMs <= input.startMs ||
    input.endMs > input.durationMs ||
    !Number.isSafeInteger(input.contextMs) ||
    input.contextMs < 0
  )
    throw new Error("INVALID_SOURCE_SPAN");
  return {
    startMs: Math.max(0, input.startMs - input.contextMs),
    endMs: Math.min(input.durationMs, input.endMs + input.contextMs),
  };
}
export function glossarySuggestions(
  source: string,
  entries: readonly GlossaryEntry[],
  language: string,
): { entryId: string; start: number; end: number; replacement: string }[] {
  if (source.length > 100000 || entries.length > 1000) throw new Error("GLOSSARY_INPUT_TOO_LARGE");
  const suggestions: { entryId: string; start: number; end: number; replacement: string }[] = [];
  for (const entry of entries) {
    if (
      entry.language !== language ||
      !text(entry.term, 200) ||
      !text(entry.preferred, 200) ||
      entry.term === entry.preferred
    )
      continue;
    let start = source.indexOf(entry.term);
    while (start !== -1) {
      if (suggestions.length >= 10000) throw new Error("GLOSSARY_MATCH_LIMIT");
      suggestions.push({
        entryId: entry.id,
        start,
        end: start + entry.term.length,
        replacement: entry.preferred,
      });
      start = source.indexOf(entry.term, start + entry.term.length);
    }
  }
  return suggestions.sort((a, b) => a.start - b.start || a.entryId.localeCompare(b.entryId));
}
export type EditorialCorpusSample = {
  sampleId: string;
  recipeVersion: string;
  exactQuotePass: boolean;
  criticalGlossaryErrors: number;
  glossaryTerms: number;
};
export function evaluateEditorialCorpus(samples: readonly EditorialCorpusSample[]): {
  samples: number;
  exactQuotePasses: number;
  exactQuoteRate: number | null;
  criticalGlossaryErrors: number;
  glossaryTerms: number;
  criticalGlossaryErrorRate: number | null;
} {
  if (
    new Set(samples.map((sample) => sample.sampleId)).size !== samples.length ||
    new Set(samples.map((sample) => sample.recipeVersion)).size > 1 ||
    samples.some(
      (sample) =>
        !text(sample.sampleId, 128) ||
        !text(sample.recipeVersion, 100) ||
        typeof sample.exactQuotePass !== "boolean" ||
        !Number.isSafeInteger(sample.criticalGlossaryErrors) ||
        sample.criticalGlossaryErrors < 0 ||
        !Number.isSafeInteger(sample.glossaryTerms) ||
        sample.glossaryTerms < sample.criticalGlossaryErrors,
    )
  )
    throw new Error("INVALID_CORPUS_SAMPLE");
  const exactQuotePasses = samples.filter((sample) => sample.exactQuotePass).length;
  const criticalGlossaryErrors = samples.reduce(
    (total, sample) => total + sample.criticalGlossaryErrors,
    0,
  );
  const glossaryTerms = samples.reduce((total, sample) => total + sample.glossaryTerms, 0);
  return {
    samples: samples.length,
    exactQuotePasses,
    exactQuoteRate: samples.length ? exactQuotePasses / samples.length : null,
    criticalGlossaryErrors,
    glossaryTerms,
    criticalGlossaryErrorRate: glossaryTerms ? criticalGlossaryErrors / glossaryTerms : null,
  };
}

export function reviewQuote(input: {
  quote: QuoteCandidate;
  transcript: TranscriptVersion;
  expectedRevision: number;
  decision: EditorialReview["decision"];
  reviewerId: string;
  reviewedAt: string;
}): QuoteCandidate {
  requireContentRevision(input.quote.revision, input.expectedRevision);
  const revision = input.quote.revision + 1;
  const review: EditorialReview = {
    decision: input.decision,
    reviewerId: input.reviewerId,
    reviewedAt: input.reviewedAt,
    revision,
  };
  if (!validReview(review)) throw new Error("INVALID_REVIEW");
  if (input.decision === "APPROVED") {
    const decision = quoteReviewDecision(input);
    if (!decision.allowed) throw new Error(decision.reason);
  }
  return { ...input.quote, revision, review };
}

export function isEditorialApproved(review: EditorialReview | null, revision: number): boolean {
  return (
    review !== null &&
    validReview(review) &&
    review.decision === "APPROVED" &&
    review.revision === revision
  );
}

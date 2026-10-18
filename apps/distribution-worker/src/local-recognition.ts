import {
  NATIVE_LANGUAGES,
  type NativeLanguage,
  type NativeRecognitionResult,
  normalizeNativeRecognition,
} from "@satsang/distribution-domain";

export type LocalWhisperInput = {
  raw: unknown;
  /** Hash recorded for the media supplied to the local recognition run. */
  sourceSha256: string;
  durationMs: number;
  language: NativeLanguage;
  /** Actual local model identifier, not a provider adoption or approval. */
  model: string;
  /** Explicit review fallback: retain segment text/times and omit unverified word annotations. */
  timingMode?: "segment_only";
};
export type LocalRecognitionWarning = {
  code:
    | "ZERO_DURATION_WORD"
    | "SUB_MILLISECOND_WORD"
    | "WORD_PROBABILITY_UNAVAILABLE"
    | "WORD_TIMESTAMPS_UNAVAILABLE"
    | "SEGMENT_ONLY_TIMING"
    | "EMPTY_INSTANTANEOUS_SEGMENT"
    | "REPLACEMENT_CHARACTER";
  segmentId: string;
  wordIndex?: number;
  message: string;
};

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_LOCAL_WHISPER_JSON");
  return value as Record<string, unknown>;
}
function seconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("INVALID_LOCAL_WHISPER_TIMESTAMP");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4000)
    throw new Error("INVALID_LOCAL_WHISPER_TEXT");
  return value;
}

/** Pure local import of Whisper/MLX JSON. The caller verifies the media hash and
 * retains the raw recognition artifact. No inference, network I/O, wording edits,
 * speaker identification or editorial approval occurs here. */
export function normalizeLocalWhisperRecognition(
  input: LocalWhisperInput,
  source: { versionId: string; sha256: string; transcriptId: string },
): ReturnType<typeof normalizeNativeRecognition> & {
  recognition: NativeRecognitionResult;
  timingMode: "strict" | "segment_only";
  warnings: LocalRecognitionWarning[];
} {
  if (
    typeof input.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    input.sourceSha256 !== source.sha256
  )
    throw new Error("NATIVE_SOURCE_MISMATCH");
  if (
    !Number.isSafeInteger(input.durationMs) ||
    input.durationMs <= 0 ||
    !NATIVE_LANGUAGES.includes(input.language) ||
    typeof input.model !== "string" ||
    !input.model.trim() ||
    input.model.length > 100 ||
    (input.timingMode !== undefined && input.timingMode !== "segment_only")
  )
    throw new Error("INVALID_LOCAL_WHISPER_INPUT");
  const raw = record(input.raw);
  if (raw.sourceSha256 !== undefined && raw.sourceSha256 !== source.sha256)
    throw new Error("NATIVE_SOURCE_MISMATCH");
  if (raw.language !== input.language) throw new Error("LOCAL_WHISPER_LANGUAGE_MISMATCH");
  if (!Array.isArray(raw.segments) || raw.segments.length < 1 || raw.segments.length > 1000)
    throw new Error("INVALID_LOCAL_WHISPER_SEGMENTS");
  const warnings: LocalRecognitionWarning[] = [];
  const ids = new Set<number>();
  let previousEndMs = 0;
  const segments: NativeRecognitionResult["segments"] = raw.segments.flatMap((value) => {
    const segment = record(value);
    if (
      typeof segment.id !== "number" ||
      !Number.isSafeInteger(segment.id) ||
      segment.id < 0 ||
      ids.has(segment.id)
    )
      throw new Error("INVALID_LOCAL_WHISPER_SEGMENT_ID");
    ids.add(segment.id);
    const id = `whisper-${segment.id}`;
    const start = seconds(segment.start);
    const end = seconds(segment.end);
    if (end < start || end > input.durationMs / 1000)
      throw new Error("INVALID_LOCAL_WHISPER_TIMESTAMP");
    // Whisper clears instantaneous segments but leaves their timestamped records.
    // Only these empty records can be omitted; never discard real source wording.
    if (
      start === end &&
      typeof segment.text === "string" &&
      !segment.text.trim() &&
      (segment.words === undefined || (Array.isArray(segment.words) && segment.words.length === 0))
    ) {
      warnings.push({
        code: "EMPTY_INSTANTANEOUS_SEGMENT",
        segmentId: id,
        message: "Empty instantaneous Whisper segment omitted; no source wording was removed.",
      });
      return [];
    }
    const startMs = Math.round(start * 1000);
    const endMs = Math.round(end * 1000);
    // Compare in the domain's millisecond precision, avoiding floating-point
    // artifacts such as 217.92 versus 217.92000000000002 at adjacent boundaries.
    if (startMs < previousEndMs || endMs <= startMs)
      throw new Error("INVALID_LOCAL_WHISPER_TIMESTAMP");
    previousEndMs = endMs;
    const segmentText = text(segment.text);
    const words: NativeRecognitionResult["segments"][number]["words"] = [];
    const segmentWarnings: string[] = [];
    const warn = (warning: Omit<LocalRecognitionWarning, "segmentId">) => {
      warnings.push({ ...warning, segmentId: id });
      segmentWarnings.push(warning.message);
    };
    if (segmentText.includes("\uFFFD")) {
      warn({
        code: "REPLACEMENT_CHARACTER",
        message:
          "Raw segment contains a Unicode replacement character; wording is unchanged and requires native correction against the audio.",
      });
    }
    if (input.timingMode === "segment_only") {
      warn({
        code: "SEGMENT_ONLY_TIMING",
        message:
          "Explicit segment-only import: all word annotations are omitted and their timing/probabilities remain unverified in the retained raw artifact.",
      });
    } else if (
      segment.words === undefined ||
      (Array.isArray(segment.words) && !segment.words.length)
    ) {
      warn({
        code: "WORD_TIMESTAMPS_UNAVAILABLE",
        message: "Word timestamps were not supplied; segment text remains unchanged.",
      });
    } else {
      if (!Array.isArray(segment.words) || segment.words.length > 10000)
        throw new Error("INVALID_LOCAL_WHISPER_WORDS");
      let previousWordEndMs = startMs;
      for (const [wordIndex, value] of segment.words.entries()) {
        const word = record(value);
        const wordText = text(word.word);
        const wordStart = seconds(word.start);
        const wordEnd = seconds(word.end);
        const wordStartMs = Math.round(wordStart * 1000);
        const wordEndMs = Math.round(wordEnd * 1000);
        if (
          wordStartMs < previousWordEndMs ||
          wordEnd < wordStart ||
          wordEnd > end ||
          wordStart < start
        )
          throw new Error("INVALID_LOCAL_WHISPER_TIMESTAMP");
        previousWordEndMs = wordEndMs;
        // Whisper alignment can emit zero-duration words. Keep their wording in
        // raw segment text; never manufacture a duration or shift another word.
        if (wordStart === wordEnd || wordStartMs === wordEndMs) {
          warn({
            code: wordStart === wordEnd ? "ZERO_DURATION_WORD" : "SUB_MILLISECOND_WORD",
            wordIndex,
            message: `Word ${wordIndex} has no representable duration; its timed annotation was omitted, preserving segment text.`,
          });
          continue;
        }
        if (
          typeof word.probability !== "number" ||
          !Number.isFinite(word.probability) ||
          word.probability < 0 ||
          word.probability > 1
        ) {
          warn({
            code: "WORD_PROBABILITY_UNAVAILABLE",
            wordIndex,
            message: `Word ${wordIndex} has no valid probability; its timed annotation was omitted, preserving segment text.`,
          });
          continue;
        }
        words.push({
          startMs: wordStartMs,
          endMs: wordEndMs,
          text: wordText,
          confidence: word.probability,
        });
      }
    }
    return [
      {
        id,
        startMs,
        endMs,
        text: segmentText,
        // avg_logprob and no_speech_prob do not express segment correctness.
        confidence: null,
        speakerId: null,
        speakerName: null,
        words,
        languageSpans: [{ startMs, endMs, language: input.language }],
        uncertainty: [
          "Local machine transcript requires native review against the source audio.",
          "Language coverage uses the requested transcription language; code-switching requires native review.",
          ...segmentWarnings,
        ],
      },
    ];
  });
  const recognition: NativeRecognitionResult = {
    provider: "local-whisper",
    model: input.model,
    sourceSha256: input.sourceSha256,
    language: input.language,
    durationMs: input.durationMs,
    segments,
  };
  return {
    ...normalizeNativeRecognition(recognition, source),
    recognition,
    timingMode: input.timingMode ?? "strict",
    warnings,
  };
}

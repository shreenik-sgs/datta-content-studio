import { type TranscriptVersion, validateTranscript } from "./intelligence";
import {
  NATIVE_LANGUAGES,
  type NativeAnalysis,
  type NativeAnnotation,
  type NativeLanguage,
} from "./native-intelligence";
export type NativeRecognitionResult = {
  provider: string;
  model: string;
  sourceSha256: string;
  language: NativeLanguage;
  durationMs: number;
  segments: {
    id: string;
    startMs: number;
    endMs: number;
    text: string;
    confidence: number | null;
    speakerId: string | null;
    speakerName: string | null;
    words: NativeAnnotation["words"];
    languageSpans: NativeAnnotation["languageSpans"];
    uncertainty: string[];
  }[];
};
/** Vendor-neutral, lossless normalization. No translation, transliteration or
 * glossary replacement may silently become authoritative source wording. */
export function normalizeNativeRecognition(
  result: NativeRecognitionResult,
  source: {
    versionId: string;
    sha256: string;
    transcriptId: string;
  },
): {
  transcript: TranscriptVersion;
  annotations: NativeAnalysis["annotations"];
} {
  if (
    !result.provider.trim() ||
    !result.model.trim() ||
    !NATIVE_LANGUAGES.includes(result.language) ||
    result.sourceSha256 !== source.sha256 ||
    !/^[a-f0-9]{64}$/.test(source.sha256) ||
    result.segments.length > 1000
  )
    throw new Error("NATIVE_SOURCE_MISMATCH");
  const transcript: TranscriptVersion = {
    id: source.transcriptId,
    parentVersionId: null,
    number: 1,
    masterVersionId: source.versionId,
    sourceSha256: source.sha256,
    language: result.language,
    revision: 1,
    durationMs: result.durationMs,
    segments: result.segments.map((segment) => ({
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
      originalText: segment.text,
      displayText: segment.text,
    })),
    review: null,
    provenance: {
      provider: result.provider,
      model: result.model,
      promptVersion: "native-recognition-config-v1",
      schemaVersion: 1,
      recipeVersion: "native-recognition-v1",
    },
  };
  validateTranscript(transcript);
  const annotations = result.segments.map((segment) => {
    if (
      segment.confidence !== null &&
      (!Number.isFinite(segment.confidence) || segment.confidence < 0 || segment.confidence > 1)
    )
      throw new Error("INVALID_NATIVE_ANNOTATION");
    let end = segment.startMs;
    for (const span of segment.languageSpans) {
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
    for (const word of segment.words) {
      if (
        !Number.isSafeInteger(word.startMs) ||
        !Number.isSafeInteger(word.endMs) ||
        word.startMs < wordEnd ||
        word.endMs <= word.startMs ||
        word.endMs > segment.endMs ||
        !Number.isFinite(word.confidence) ||
        word.confidence < 0 ||
        word.confidence > 1 ||
        !word.text.trim()
      )
        throw new Error("INVALID_WORD_SPAN");
      wordEnd = word.endMs;
    }
    return {
      segmentId: segment.id,
      confidence: segment.confidence ?? 0,
      speakerId: segment.speakerId ?? `unresolved:${segment.id}`,
      speakerName: segment.speakerName ?? "Speaker not identified",
      words: segment.words,
      languageSpans: segment.languageSpans,
      englishShadow: null,
      uncertainty: [
        ...segment.uncertainty,
        ...(segment.confidence === null ? ["Recognition confidence was not supplied."] : []),
        ...(!segment.speakerId || !segment.speakerName
          ? ["Speaker attribution requires native review."]
          : []),
      ],
    };
  });
  return { transcript, annotations };
}

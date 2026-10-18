import { describe, expect, it } from "vitest";
import { type NativeRecognitionResult, normalizeNativeRecognition } from "./native-recognition";
const source = { versionId: "v", transcriptId: "t", sha256: "a".repeat(64) };
const input: NativeRecognitionResult = {
  provider: "synthetic",
  model: "test",
  sourceSha256: source.sha256,
  language: "te",
  durationMs: 3000,
  segments: [
    {
      id: "s",
      startMs: 0,
      endMs: 3000,
      text: "తెలుగు సంస్కృతం English",
      confidence: null,
      speakerId: null,
      speakerName: null,
      words: [],
      languageSpans: [
        { startMs: 0, endMs: 1000, language: "te" },
        { startMs: 1000, endMs: 2000, language: "sa" },
        { startMs: 2000, endMs: 3000, language: "en" },
      ],
      uncertainty: [],
    },
  ],
};
describe("native recognition normalization", () => {
  it.each(["te", "kn", "ta"] as const)(
    "preserves native and code-switched text and never invents approval (%s)",
    (language) => {
      const output = normalizeNativeRecognition({ ...input, language }, source);
      expect(output.transcript.review).toBeNull();
      expect(output.transcript.segments[0]?.originalText).toBe(input.segments[0]?.text);
      expect(output.annotations[0]?.languageSpans).toEqual(input.segments[0]?.languageSpans);
      expect(output.annotations[0]?.confidence).toBe(0);
      expect(output.annotations[0]?.uncertainty).toHaveLength(2);
    },
  );
  it("rejects a mismatched source or malformed language coverage", () => {
    expect(() =>
      normalizeNativeRecognition({ ...input, sourceSha256: "b".repeat(64) }, source),
    ).toThrow("NATIVE_SOURCE_MISMATCH");
    expect(() =>
      normalizeNativeRecognition(
        { ...input, segments: [{ ...requiredValue(input.segments[0]), languageSpans: [] }] },
        source,
      ),
    ).toThrow("INVALID_LANGUAGE_SPAN");
  });
});

function requiredValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("REQUIRED_VALUE_MISSING");
  return value;
}

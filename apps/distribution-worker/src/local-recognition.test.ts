import { describe, expect, it } from "vitest";
import { normalizeLocalWhisperRecognition } from "./local-recognition";

const source = { versionId: "master-v1", transcriptId: "transcript-v1", sha256: "a".repeat(64) };
const segment = () => ({
  id: 0,
  start: 0.12,
  end: 2.5,
  text: "  శ్రీ గురు దత్త. English  ",
  avg_logprob: -0.15,
  no_speech_prob: 0.001,
  words: [
    { start: 0.12, end: 0.8, word: "  శ్రీ", probability: 0.93 },
    { start: 0.8, end: 1.4, word: " గురు", probability: 0 },
    { start: 1.4, end: 2, word: " దత్త.", probability: 1 },
    { start: 2, end: 2.5, word: " English  ", probability: 0.84 },
  ],
});
const fixture = () => ({
  raw: { language: "te", text: "ignored aggregate text", segments: [segment()] },
  sourceSha256: source.sha256,
  durationMs: 3000,
  language: "te" as const,
  model: "mlx-community/whisper-large-v3-mlx",
});

describe("local Whisper recognition import", () => {
  it("preserves native text and real word probabilities without inventing segment confidence or approval", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = normalizeLocalWhisperRecognition(input, source);
    expect(result.transcript).toMatchObject({
      id: source.transcriptId,
      masterVersionId: source.versionId,
      sourceSha256: source.sha256,
      review: null,
      provenance: { provider: "local-whisper", model: input.model },
    });
    expect(result.transcript.segments[0]).toEqual({
      id: "whisper-0",
      startMs: 120,
      endMs: 2500,
      originalText: segment().text,
      displayText: segment().text,
    });
    expect(result.recognition.segments[0]?.confidence).toBeNull();
    // Existing domain contract represents missing confidence as 0 plus uncertainty.
    expect(result.annotations[0]?.confidence).toBe(0);
    expect(result.annotations[0]?.uncertainty).toContain(
      "Recognition confidence was not supplied.",
    );
    expect(result.annotations[0]?.words).toEqual(
      segment().words.map((word) => ({
        startMs: Math.round(word.start * 1000),
        endMs: Math.round(word.end * 1000),
        text: word.word,
        confidence: word.probability,
      })),
    );
    expect(result.annotations[0]?.englishShadow).toBeNull();
    expect(result.annotations[0]?.speakerId).toBe("unresolved:whisper-0");
    expect(result.warnings).toEqual([]);
    expect(input).toEqual(before);
  });

  it.each(["te", "kn", "ta"] as const)("accepts declared supported language %s", (language) => {
    const input = fixture();
    expect(
      normalizeLocalWhisperRecognition(
        { ...input, language, raw: { ...input.raw, language } },
        source,
      ).transcript.language,
    ).toBe(language);
  });

  it("omits zero-duration words while retaining their raw segment wording", () => {
    const input = fixture();
    required(required(input.raw.segments[0]).words[1]).end = 0.8;
    const result = normalizeLocalWhisperRecognition(input, source);
    expect(result.annotations[0]?.words.map((word) => word.text)).toEqual([
      "  శ్రీ",
      " దత్త.",
      " English  ",
    ]);
    expect(result.transcript.segments[0]?.originalText).toBe(segment().text);
    expect(result.warnings).toMatchObject([
      { code: "ZERO_DURATION_WORD", segmentId: "whisper-0", wordIndex: 1 },
    ]);
  });

  it("does not invent a millisecond for a positive span below timestamp resolution", () => {
    const input = fixture();
    required(required(input.raw.segments[0]).words[1]).end = 0.8001;
    expect(normalizeLocalWhisperRecognition(input, source).warnings[0]?.code).toBe(
      "SUB_MILLISECOND_WORD",
    );
  });

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1, "0.9"])(
    "does not manufacture a word probability from %s",
    (probability) => {
      const input = fixture();
      const raw = {
        ...input.raw,
        segments: [{ ...segment(), words: [{ start: 0.12, end: 2.5, word: " raw", probability }] }],
      };
      const result = normalizeLocalWhisperRecognition({ ...input, raw }, source);
      expect(result.annotations[0]?.words).toEqual([]);
      expect(result.warnings[0]?.code).toBe("WORD_PROBABILITY_UNAVAILABLE");
      expect(result.transcript.segments[0]?.originalText).toBe(segment().text);
    },
  );

  it("imports segments without word timing with explicit uncertainty", () => {
    const input = fixture();
    const { words: _words, ...untimed } = segment();
    const result = normalizeLocalWhisperRecognition(
      { ...input, raw: { ...input.raw, segments: [untimed] } },
      source,
    );
    expect(result.annotations[0]?.words).toEqual([]);
    expect(result.warnings[0]?.code).toBe("WORD_TIMESTAMPS_UNAVAILABLE");
  });

  it("rejects source and detected-language mismatches", () => {
    const input = fixture();
    expect(() =>
      normalizeLocalWhisperRecognition({ ...input, sourceSha256: "b".repeat(64) }, source),
    ).toThrow("NATIVE_SOURCE_MISMATCH");
    expect(() =>
      normalizeLocalWhisperRecognition(
        { ...input, raw: { ...input.raw, sourceSha256: "b".repeat(64) } },
        source,
      ),
    ).toThrow("NATIVE_SOURCE_MISMATCH");
    expect(() =>
      normalizeLocalWhisperRecognition({ ...input, raw: { ...input.raw, language: "en" } }, source),
    ).toThrow("LOCAL_WHISPER_LANGUAGE_MISMATCH");
  });

  it.each([
    { start: -1 },
    { start: "0" },
    { start: Number.NaN },
    { end: Number.POSITIVE_INFINITY },
    { start: 2.5 },
    { end: 0.1 },
    { end: 3.00001 },
  ])("rejects malformed and out-of-source segment timestamps %j", (change) => {
    const input = fixture();
    expect(() =>
      normalizeLocalWhisperRecognition(
        { ...input, raw: { ...input.raw, segments: [{ ...segment(), ...change }] } },
        source,
      ),
    ).toThrow("INVALID_LOCAL_WHISPER_TIMESTAMP");
  });

  it.each([
    { start: 0.1, end: 0.2 },
    { start: 2, end: 2.50001 },
    { start: 1, end: 0.9 },
    { start: "0.12", end: 1 },
    { start: 0.12, end: Number.NaN },
  ])("rejects invalid word timestamps even without probability %j", (change) => {
    const input = fixture();
    expect(() =>
      normalizeLocalWhisperRecognition(
        {
          ...input,
          raw: {
            ...input.raw,
            segments: [{ ...segment(), words: [{ word: " retained", ...change }] }],
          },
        },
        source,
      ),
    ).toThrow("INVALID_LOCAL_WHISPER_TIMESTAMP");
  });

  it("rejects overlapping segments, overlapping words and duplicate segment identifiers", () => {
    const input = fixture();
    for (const second of [
      { ...segment(), id: 1 },
      { ...segment(), start: 2.5, end: 3 },
    ]) {
      expect(() =>
        normalizeLocalWhisperRecognition(
          { ...input, raw: { ...input.raw, segments: [segment(), second] } },
          source,
        ),
      ).toThrow();
    }
    required(required(input.raw.segments[0]).words[1]).start = 0.7;
    expect(() => normalizeLocalWhisperRecognition(input, source)).toThrow(
      "INVALID_LOCAL_WHISPER_TIMESTAMP",
    );
  });

  it.each([
    null,
    [],
    {},
    { language: "te", segments: [] },
    { language: "te", segments: [null] },
    { language: "te", segments: [{ ...segment(), text: " " }] },
  ])("rejects malformed raw input %j", (raw) => {
    expect(() => normalizeLocalWhisperRecognition({ ...fixture(), raw }, source)).toThrow();
  });

  it("accepts adjacent segment and word boundaries at millisecond precision", () => {
    const raw = {
      language: "te",
      segments: [
        {
          id: 22,
          start: 215.28,
          end: 217.92000000000002,
          text: " first",
          words: [{ word: " first", start: 215.28, end: 217.92000000000002, probability: 0.8 }],
        },
        {
          id: 23,
          start: 217.92,
          end: 219,
          text: " second third",
          words: [
            { word: " second", start: 217.92, end: 218.20000000000002, probability: 0.8 },
            { word: " third", start: 218.2, end: 219, probability: 0.9 },
          ],
        },
      ],
    };
    const result = normalizeLocalWhisperRecognition(
      { ...fixture(), raw, durationMs: 220000 },
      source,
    );
    expect(result.transcript.segments.map((s) => [s.startMs, s.endMs])).toEqual([
      [215280, 217920],
      [217920, 219000],
    ]);
    expect(result.annotations[1]?.words.map((w) => [w.startMs, w.endMs])).toEqual([
      [217920, 218200],
      [218200, 219000],
    ]);
  });

  it("explicitly omits the 13 observed off-segment word annotations without clamping or rewriting", () => {
    // Real MLX boundary shapes, with neutral text. Keep the regression independent
    // of downloaded media and preserve all raw word times in the supplied object.
    const spans = [
      [62, 63, 62.34, 63.040000000000006],
      [130, 137.62, 137.14, 137.79999999999998],
      [140, 143.86, 143.56, 144.24],
      [170, 179.38, 178.84, 179.54],
      [215.28, 217.92000000000002, 214.76000000000002, 215.46],
      [270, 279.24, 278.7, 279.3],
      [360, 369.38, 368.98, 369.62],
      [510, 519.26, 518.76, 519.46],
      [710, 715.52, 715.16, 715.86],
      [900, 907.6800000000001, 907.22, 907.86],
      [975, 981.36, 980.78, 981.47],
      [1120, 1129.69, 1129.21, 1129.79],
      [1130, 1138.79, 1138.51, 1138.98],
    ];
    const raw = {
      language: "te",
      segments: spans.map(([start, end, wordStart, wordEnd], id) => ({
        id,
        start,
        end,
        text: ` raw segment ${id} `,
        words: [{ word: ` raw word ${id} `, start: wordStart, end: wordEnd, probability: 0.8 }],
      })),
    };
    const before = structuredClone(raw);
    for (const candidate of raw.segments) {
      expect(() =>
        normalizeLocalWhisperRecognition(
          { ...fixture(), durationMs: 1202283, raw: { ...raw, segments: [candidate] } },
          source,
        ),
      ).toThrow("INVALID_LOCAL_WHISPER_TIMESTAMP");
    }
    const result = normalizeLocalWhisperRecognition(
      { ...fixture(), raw, durationMs: 1202283, timingMode: "segment_only" },
      source,
    );
    expect(result.timingMode).toBe("segment_only");
    expect(result.transcript.segments.map((s) => s.originalText)).toEqual(
      raw.segments.map((s) => s.text),
    );
    expect(result.annotations.every((a) => a.words.length === 0)).toBe(true);
    expect(result.warnings.filter((w) => w.code === "SEGMENT_ONLY_TIMING")).toHaveLength(13);
    expect(result.transcript.review).toBeNull();
    expect(raw).toEqual(before);
  });

  it.each([undefined, "segment_only"] as const)(
    "omits only empty instantaneous segments with a warning (%s)",
    (timingMode) => {
      const raw = {
        language: "te",
        segments: [
          { id: 104, start: 1190, end: 1202.26, text: " unchanged ", words: [] },
          { id: 105, start: 1202.24, end: 1202.24, text: "", words: [] },
        ],
      };
      const result = normalizeLocalWhisperRecognition(
        { ...fixture(), raw, durationMs: 1202283, ...(timingMode ? { timingMode } : {}) },
        source,
      );
      expect(result.transcript.segments).toHaveLength(1);
      expect(result.transcript.segments[0]?.originalText).toBe(" unchanged ");
      expect(result.warnings).toContainEqual({
        code: "EMPTY_INSTANTANEOUS_SEGMENT",
        segmentId: "whisper-105",
        message: expect.any(String),
      });
      for (const change of [{ text: "real words" }, { end: 1202.25 }, { start: 1203, end: 1203 }]) {
        expect(() =>
          normalizeLocalWhisperRecognition(
            {
              ...fixture(),
              raw: {
                ...raw,
                segments: [required(raw.segments[0]), { ...required(raw.segments[1]), ...change }],
              },
              durationMs: 1202283,
              ...(timingMode ? { timingMode } : {}),
            },
            source,
          ),
        ).toThrow();
      }
    },
  );

  it("flags replacement characters without guessing their intended wording", () => {
    const raw = { language: "te", segments: [{ ...segment(), text: " raw \uFFFD text " }] };
    const result = normalizeLocalWhisperRecognition(
      { ...fixture(), raw, timingMode: "segment_only" },
      source,
    );
    expect(result.transcript.segments[0]?.originalText).toBe(" raw \uFFFD text ");
    expect(result.warnings.some((w) => w.code === "REPLACEMENT_CHARACTER")).toBe(true);
    expect(
      result.annotations[0]?.uncertainty.some((w) => w.includes("replacement character")),
    ).toBe(true);
    expect(result.transcript.review).toBeNull();
  });

  it("still rejects invalid source segment timing in segment-only mode", () => {
    for (const change of [
      { start: -1 },
      { end: 3.1 },
      { start: Number.NaN },
      { start: 2, end: 1 },
    ]) {
      const raw = { language: "te", segments: [{ ...segment(), ...change }] };
      expect(() =>
        normalizeLocalWhisperRecognition({ ...fixture(), raw, timingMode: "segment_only" }, source),
      ).toThrow("INVALID_LOCAL_WHISPER_TIMESTAMP");
    }
  });

  it("ignores any raw editorial approval instead of trusting model output", () => {
    const input = fixture();
    const result = normalizeLocalWhisperRecognition(
      { ...input, raw: { ...input.raw, review: { decision: "APPROVED" } } },
      source,
    );
    expect(result.transcript.review).toBeNull();
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("TEST_FIXTURE_MISSING");
  return value;
}

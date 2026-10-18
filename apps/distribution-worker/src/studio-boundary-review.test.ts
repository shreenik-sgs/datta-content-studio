import { expect, it, vi } from "vitest";
import { reviewStudioAudioBoundary } from "./studio-boundary-review";
it("reviews the exact clip and isolated edge without translated copy or drafting rationale", async () => {
  const result = {
    verdict: "incomplete",
    audibleWords: "తెలుగు విలువ ఆ భాష",
    meaning: "The value of Telugu, that language...",
    reason: "A new sentence is cut off.",
    needsOutsideSpeech: true,
    cutDuringWord: false,
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: "STOP",
            content: { role: "model", parts: [{ text: JSON.stringify(result) }] },
          },
        ],
      }),
    ),
  );
  const actual = await reviewStudioAudioBoundary({
    apiKey: "synthetic",
    model: "synthetic",
    fetcher,
    edge: "ending",
    audio: new Uint8Array([1, 2]),
    focusAudio: new Uint8Array([3]),
    language: "te",
    startMs: 100,
    endMs: 200,
    included: [{ id: "end", startMs: 100, endMs: 200, text: "తెలుగు విలువ ఆ భాష." }],
    outside: [
      {
        id: "next",
        startMs: 200,
        endMs: 400,
        text: "A completion only the next segment contains.",
      },
    ],
  });
  expect(actual).toEqual(result);
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.contents[0].parts.filter((p: { inlineData?: unknown }) => p.inlineData)).toHaveLength(
    2,
  );
  expect(body.systemInstruction.parts[0].text).toContain(
    "A complete earlier lesson does NOT excuse a new incomplete sentence",
  );
  expect(JSON.stringify(body.contents)).not.toContain("rationale");
  expect(JSON.stringify(body.contents)).not.toContain("తెలుగు విలువ ఆ భాష.");
  expect(JSON.stringify(body.contents)).not.toContain(
    "A completion only the next segment contains.",
  );
  expect(body.systemInstruction.parts[0].text).toContain("blind audio check");
  expect(body.systemInstruction.parts[0].text).toContain("language hint may be approximate");
});
it("fails closed when the reviewer supplies no audible boundary evidence", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: "STOP",
            content: { role: "model", parts: [{ text: '{"verdict":"complete"}' }] },
          },
        ],
      }),
    ),
  );
  await expect(
    reviewStudioAudioBoundary({
      apiKey: "synthetic",
      model: "synthetic",
      fetcher,
      edge: "opening",
      audio: new Uint8Array([1]),
      focusAudio: new Uint8Array([1]),
      language: "te",
      startMs: 0,
      endMs: 100,
      included: [],
      outside: [],
    }),
  ).rejects.toThrow("STUDIO_VIDEO_REVIEW_INVALID");
});

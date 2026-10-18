import { expect, it } from "vitest";
import type { StudioTranscript } from "./intelligent-content";
import { studioAudioReviewWindows } from "./studio-audio-analysis";
import type { StudioPlan } from "./studio-planner";

const transcript: StudioTranscript = {
  language: "te",
  durationMs: 4400135,
  provenance: "MACHINE_TRANSCRIPT",
  sourceTranscriptId: null,
  segments: [
    { id: "opening", startMs: 0, endMs: 60000, text: "Opening." },
    { id: "teaching", startMs: 3000000, endMs: 3060000, text: "Useful teaching." },
    { id: "closing", startMs: 4340000, endMs: 4400135, text: "Closing." },
  ],
};
const plan = (ids: string[]): StudioPlan => ({
  outputs: [
    {
      channel: "website",
      language: "en",
      format: "blog",
      title: "Teaching",
      body: "Source based.",
      rationale: "Fixture.",
      sourceSegmentIds: ids,
    },
  ],
  translations: [],
  skippedChannels: [],
});

it("extracts cited passages with context, leaving unrelated hour-long intervals out", () => {
  expect(studioAudioReviewWindows(plan(["teaching", "closing"]), transcript)).toEqual([
    { startMs: 2985000, endMs: 3075000 },
    { startMs: 4325000, endMs: 4400135 },
  ]);
});
it("deduplicates shared channel passages and clips context to the actual master", () => {
  const p = plan(["opening"]);
  const first = p.outputs[0];
  if (!first) throw Error("MISSING_FIXTURE");
  p.outputs.push({ ...first, channel: "reddit" });
  expect(studioAudioReviewWindows(p, transcript)).toEqual([{ startMs: 0, endMs: 75000 }]);
});
it("splits very long cited evidence into overlapping bounded windows with no coverage gaps", () => {
  const long = {
    ...transcript,
    segments: [{ id: "all", startMs: 0, endMs: transcript.durationMs, text: "Long evidence." }],
  };
  const windows = studioAudioReviewWindows(plan(["all"]), long);
  expect(windows.length).toBeGreaterThan(1);
  expect(windows[0]?.startMs).toBe(0);
  expect(windows.at(-1)?.endMs).toBe(transcript.durationMs);
  windows.forEach((w, i) => {
    expect(w.endMs - w.startMs).toBeLessThanOrEqual(600000);
    const previous = windows[i - 1];
    if (previous) expect(w.startMs).toBe(previous.endMs - 30000);
  });
});
it("refuses invented source IDs instead of reviewing unrelated speech", () => {
  expect(() => studioAudioReviewWindows(plan(["unknown"]), transcript)).toThrow(
    "STUDIO_SOURCE_EVIDENCE_REQUIRED",
  );
});

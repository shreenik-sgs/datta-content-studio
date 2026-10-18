import type { StudioTranscript } from "./intelligent-content";
import { type StudioPlan, studioSourceRange } from "./studio-planner";

export const STUDIO_TRANSCRIPTION_SECTION_MS = 30 * 60 * 1000;
export const STUDIO_SINGLE_TRANSCRIPTION_MS = 60 * 60 * 1000;

/** Prefer a quiet point near the section end, keeping contiguous source coverage. */
export function studioTranscriptionSectionEnd(
  startMs: number,
  durationMs: number,
  quietPoints: readonly number[],
  maximumMs = STUDIO_TRANSCRIPTION_SECTION_MS,
): number {
  const target = Math.min(durationMs, startMs + maximumMs);
  if (target === durationMs) return target;
  const candidates = quietPoints.filter(
    (ms) => Number.isSafeInteger(ms) && ms > startMs && ms >= target - 30000 && ms <= target,
  );
  return candidates.length ? Math.max(...candidates) : target;
}

/** Analysis windows are private scratch data, never curated clips or file versions. */
export function studioAudioReviewWindows(
  plan: StudioPlan,
  transcript: StudioTranscript,
): { startMs: number; endMs: number }[] {
  const selected = new Map<string, { startMs: number; endMs: number }>();
  for (const output of plan.outputs) {
    const range = studioSourceRange(output.sourceSegmentIds, transcript, output.format);
    for (const segment of range.segments)
      selected.set(segment.id, {
        startMs: Math.max(0, segment.startMs - 15000),
        endMs: Math.min(transcript.durationMs, segment.endMs + 15000),
      });
  }
  const merged: { startMs: number; endMs: number }[] = [];
  for (const range of [...selected.values()].sort((a, b) => a.startMs - b.startMs)) {
    const previous = merged.at(-1);
    if (previous && range.startMs <= previous.endMs)
      previous.endMs = Math.max(previous.endMs, range.endMs);
    else merged.push({ ...range });
  }
  // Ten minutes at 24 kbps is about 1.8 MB. Overlap retains speech at analysis
  // boundaries; final output boundaries still come from reviewed whole passages.
  const maximumMs = 10 * 60 * 1000;
  return merged.flatMap((range) => {
    const windows: { startMs: number; endMs: number }[] = [];
    for (let startMs = range.startMs; startMs < range.endMs; ) {
      const endMs = Math.min(range.endMs, startMs + maximumMs);
      windows.push({ startMs, endMs });
      if (endMs === range.endMs) break;
      startMs = endMs - 30000;
    }
    return windows;
  });
}

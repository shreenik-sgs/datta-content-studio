import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type StudioPlan,
  type StudioTranscript,
  studioAudioReviewWindows,
} from "@satsang/distribution-domain";
import { executeStudioSource } from "./studio-process";

export type StudioReviewAudio = { bytes: Uint8Array; startMs: number; endMs: number };

/** Extract only cited speech plus context. The caller removes its private scratch directory. */
export function createStudioReviewAudio(input: {
  sourcePath: string;
  mimeType: string;
  directory: string;
  ffmpeg: string;
  transcript: StudioTranscript;
  signal?: AbortSignal;
}): (plan: StudioPlan) => Promise<StudioReviewAudio[]> {
  const cached = new Map<string, StudioReviewAudio>();
  return async (plan) => {
    const result: StudioReviewAudio[] = [];
    for (const range of studioAudioReviewWindows(plan, input.transcript)) {
      const key = `${range.startMs}-${range.endMs}`;
      let saved = cached.get(key);
      if (!saved) {
        const path = join(input.directory, `analysis-${key}.mp3`);
        await executeStudioSource({
          executable: input.ffmpeg,
          sourcePath: input.sourcePath,
          mimeType: input.mimeType,
          directory: input.directory,
          timeoutMs: 180000,
          ...(input.signal ? { signal: input.signal } : {}),
          args: [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-n",
            "-ss",
            String(range.startMs / 1000),
            "-i",
            "__SOURCE__",
            "-t",
            String((range.endMs - range.startMs) / 1000),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "24k",
            path,
          ],
        });
        const bytes = await readFile(path);
        if (!bytes.length || bytes.length > 12 * 1024 * 1024)
          throw new Error("STUDIO_AUDIO_INVALID_OR_TOO_LARGE");
        saved = { ...range, bytes };
        cached.set(key, saved);
      }
      result.push(saved);
    }
    return result;
  };
}

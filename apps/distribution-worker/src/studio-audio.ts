import {
  STUDIO_AUDIO_POLICY,
  type StudioMediaEdits,
  studioSpeechTarget,
} from "@satsang/distribution-domain";
import { executeStudioSource } from "./studio-process.js";

type AudioMeasurement = {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRange: number;
  threshold: number;
  offset: number;
};
const preset = (edits?: StudioMediaEdits) =>
  `I=${studioSpeechTarget(edits)}:TP=${STUDIO_AUDIO_POLICY.truePeakDbtp}:LRA=${STUDIO_AUDIO_POLICY.loudnessRange}`;

/** Bounded numeric values only; no provider/source text enters an encoder filter. */
export function parseStudioAudioMeasurement(diagnostics: string): AudioMeasurement {
  const match = diagnostics.match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!match) throw Error("STUDIO_AUDIO_MEASUREMENT_FAILED");
  const raw = JSON.parse(match[0]);
  const result = {
    integratedLufs: Number(raw.input_i),
    truePeakDbtp: Number(raw.input_tp),
    loudnessRange: Number(raw.input_lra),
    threshold: Number(raw.input_thresh),
    offset: Number(raw.target_offset),
  };
  if (
    !Object.values(result).every(Number.isFinite) ||
    result.integratedLufs < -70 ||
    result.integratedLufs > 0 ||
    result.truePeakDbtp < -99 ||
    result.truePeakDbtp > 10 ||
    result.loudnessRange < 0 ||
    result.loudnessRange > 50 ||
    result.threshold < -100 ||
    result.threshold > 0 ||
    Math.abs(result.offset) > 99
  )
    throw Error("STUDIO_AUDIO_UNUSABLE");
  return result;
}

export function studioNoiseFilter(edits?: StudioMediaEdits): string {
  return edits?.reduceNoise ? "afftdn=nr=8:nf=-40," : "";
}

export function studioAudioNormalization(
  measured: AudioMeasurement,
  edits?: StudioMediaEdits,
): string {
  return `loudnorm=${preset(edits)}:measured_I=${measured.integratedLufs}:measured_TP=${measured.truePeakDbtp}:measured_LRA=${measured.loudnessRange}:measured_thresh=${measured.threshold}:offset=${measured.offset}:linear=true,aresample=48000`;
}

/** Measure the exact spoken excerpt, excluding the silent closing hold. */
export async function measureStudioAudio(input: {
  mediaEdits?: StudioMediaEdits;
  ffmpeg: string;
  sourcePath: string;
  mimeType: string;
  directory: string;
  startMs: number;
  endMs: number;
  signal?: AbortSignal;
}): Promise<AudioMeasurement> {
  const diagnostics = await executeStudioSource({
    executable: input.ffmpeg,
    sourcePath: input.sourcePath,
    mimeType: input.mimeType,
    directory: input.directory,
    timeoutMs: 120000,
    output: "stderr",
    ...(input.signal ? { signal: input.signal } : {}),
    args: [
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "info",
      "-ss",
      String(input.startMs / 1000),
      "-i",
      "__SOURCE__",
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-af",
      `atrim=duration=${(input.endMs - input.startMs) / 1000},asetpts=PTS-STARTPTS,${studioNoiseFilter(input.mediaEdits)}loudnorm=${preset(input.mediaEdits)}:print_format=json`,
      "-f",
      "null",
      "-",
    ],
  });
  return parseStudioAudioMeasurement(diagnostics);
}

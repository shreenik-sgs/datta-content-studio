import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type StudioTranscript, studioTranscriptionSectionEnd } from "@satsang/distribution-domain";
import { type StudioCheckpoints, studioFingerprint } from "./studio-checkpoints";
import { normalizeStudioTranscription } from "./studio-intelligence";
import { executeStudioSource } from "./studio-process";
import { type SarvamJobCheckpoint, transcribeSarvamStudioAudio } from "./studio-sarvam";
import { retrySarvamSection } from "./studio-sarvam-section-retry.js";

/** A single master and timeline, with independently resumable private ASR sections. */
export async function transcribeStudioSections(input: {
  sourcePath: string;
  mimeType: string;
  directory: string;
  ffmpeg: string;
  durationMs: number;
  fingerprint: string;
  capacityLimited?: boolean | undefined;
  checkpoints?: StudioCheckpoints;
  provider: Omit<
    Parameters<typeof transcribeSarvamStudioAudio>[0],
    "bytes" | "durationMs" | "recovery"
  >;
}): Promise<StudioTranscript> {
  const { checkpoints, durationMs } = input;
  const initialMaximumMs = input.capacityLimited
    ? durationMs > 120000
      ? 120000
      : 30000
    : 30 * 60 * 1000;
  const fingerprint = studioFingerprint({
    source: input.fingerprint,
    policy: "bounded-asr-v1",
    ...(input.capacityLimited ? { initialMaximumMs } : {}),
  });
  const boundary = async (startMs: number, endLimitMs: number, maximumMs: number) => {
    const target = Math.min(endLimitMs, startMs + maximumMs);
    const quietPoints: number[] = [];
    if (target < endLimitMs) {
      const scanStartMs = Math.max(startMs, target - 30000);
      const logs = await executeStudioSource({
        executable: input.ffmpeg,
        sourcePath: input.sourcePath,
        mimeType: input.mimeType,
        directory: input.directory,
        timeoutMs: 60000,
        output: "stderr",
        ...(input.provider.signal ? { signal: input.provider.signal } : {}),
        args: [
          "-nostdin",
          "-hide_banner",
          "-nostats",
          "-ss",
          String(scanStartMs / 1000),
          "-i",
          "__SOURCE__",
          "-t",
          "30",
          "-vn",
          "-af",
          "silencedetect=noise=-35dB:d=0.35",
          "-f",
          "null",
          "-",
        ],
      });
      for (const match of logs.matchAll(
        /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/g,
      )) {
        const end = Number(match[1]);
        const length = Number(match[2]);
        if (end <= 30 && length >= 0.35)
          quietPoints.push(scanStartMs + Math.round((end - length / 2) * 1000));
      }
    }
    return studioTranscriptionSectionEnd(startMs, endLimitMs, quietPoints, maximumMs);
  };
  let ranges = checkpoints?.get<{ startMs: number; endMs: number }[]>(
    "transcription-sections",
    fingerprint,
  );
  if (!ranges) {
    ranges = [];
    for (let startMs = 0; startMs < durationMs; ) {
      const endMs = await boundary(startMs, durationMs, initialMaximumMs);
      ranges.push({ startMs, endMs });
      startMs = endMs;
    }
    await checkpoints?.set("transcription-sections", fingerprint, ranges);
  }
  const segments: StudioTranscript["segments"] = [];
  let completed = 0;
  let total = ranges.length;
  const visit = async (range: { startMs: number; endMs: number }): Promise<void> => {
    const key = `${range.startMs}-${range.endMs}`;
    const sectionFingerprint = studioFingerprint({ fingerprint, ...range });
    const splitKey = `transcription-split:${key}`;
    const children = checkpoints?.get<typeof ranges>(splitKey, sectionFingerprint);
    if (children) {
      total += children.length - 1;
      for (const child of children) await visit(child);
      return;
    }
    await checkpoints?.progress({ phase: "transcription", provider: "sarvam", completed, total });
    let transcript = checkpoints?.get<StudioTranscript>(`transcript:${key}`, sectionFingerprint);
    if (!transcript) {
      const path = join(input.directory, `transcribe-${key}.mp3`);
      await executeStudioSource({
        executable: input.ffmpeg,
        sourcePath: input.sourcePath,
        mimeType: input.mimeType,
        directory: input.directory,
        timeoutMs: 180000,
        ...(input.provider.signal ? { signal: input.provider.signal } : {}),
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
      try {
        transcript = await retrySarvamSection({
          signal: input.provider.signal,
          onWait: async (retryAt) =>
            checkpoints?.progress({
              phase: "transcription",
              provider: "sarvam",
              completed,
              total,
              ...(retryAt ? { retryAt, errorCode: "STUDIO_PROVIDER_RATE_LIMITED" } : {}),
            }),
          // Read the latest saved job stage on every attempt. A rejected start
          // resumes that same job; completed sibling sections are never repeated.
          run: async () =>
            transcribeSarvamStudioAudio({
              ...input.provider,
              allowEmptySection: true,
              durationMs: range.endMs - range.startMs,
              bytes: await readFile(path),
              ...(checkpoints
                ? {
                    recovery: {
                      saved: checkpoints.get<SarvamJobCheckpoint>(
                        `sarvam-job:${key}`,
                        sectionFingerprint,
                      ),
                      save: (value: SarvamJobCheckpoint) =>
                        checkpoints.set(`sarvam-job:${key}`, sectionFingerprint, value),
                    },
                  }
                : {}),
            }),
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "STUDIO_TRANSCRIPTION_CONTEXT_LIMIT" ||
          range.endMs - range.startMs <= 30000
        )
          throw error;
        // Only a confirmed terminal capacity failure gets new paid jobs. Preserve
        // completed siblings and every source millisecond; never silently omit audio.
        const maximumMs = range.endMs - range.startMs > 120000 ? 120000 : 30000;
        const smaller: { startMs: number; endMs: number }[] = [];
        for (let startMs = range.startMs; startMs < range.endMs; ) {
          const endMs = await boundary(startMs, range.endMs, maximumMs);
          smaller.push({ startMs, endMs });
          startMs = endMs;
        }
        await checkpoints?.set(splitKey, sectionFingerprint, smaller);
        total += smaller.length - 1;
        for (const child of smaller) await visit(child);
        return;
      }
      await checkpoints?.set(`transcript:${key}`, sectionFingerprint, transcript);
    }
    for (const segment of transcript.segments)
      segments.push({
        ...segment,
        id: `segment-${segments.length + 1}`,
        startMs: range.startMs + segment.startMs,
        endMs: range.startMs + segment.endMs,
      });
    completed++;
    await checkpoints?.progress({
      phase: "transcription",
      provider: "sarvam",
      completed,
      total,
    });
  };
  for (const range of ranges) await visit(range);
  const joined = normalizeStudioTranscription(
    {
      language: input.provider.language,
      segments: segments.map((s) => ({
        text: s.text,
        start: s.startMs / 1000,
        end: s.endMs / 1000,
      })),
    },
    input.provider.language,
    durationMs,
  );
  return {
    ...joined,
    recognition: { provider: "sarvam", model: input.provider.model ?? "saaras:v4" },
  };
}

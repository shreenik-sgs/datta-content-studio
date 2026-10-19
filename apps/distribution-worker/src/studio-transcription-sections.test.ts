import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioCheckpoints } from "./studio-checkpoints";
import * as process from "./studio-process";
import { StudioProviderError } from "./studio-provider-error";
import * as sarvam from "./studio-sarvam";
import { transcribeStudioSections } from "./studio-transcription-sections";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("reuses the same paid section job after a rejected start and preserves its completed transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-section-rate-test-"));
  vi.useFakeTimers();
  try {
    vi.spyOn(process, "executeStudioSource").mockImplementation(async (input) => {
      await writeFile(input.args.at(-1) as string, "synthetic audio");
      return "";
    });
    const saved = new Map<string, { fingerprint: string; value: unknown }>();
    const checkpoints: StudioCheckpoints = {
      get: <T>(key: string, fingerprint: string) =>
        saved.get(key)?.fingerprint === fingerprint ? (saved.get(key)?.value as T) : undefined,
      set: async (key, fingerprint, value) => {
        saved.set(key, { fingerprint, value });
      },
      progress: vi.fn(async () => {}),
    };
    const provider = vi.spyOn(sarvam, "transcribeSarvamStudioAudio");
    provider.mockImplementationOnce(async (input) => {
      await input.recovery?.save({ jobId: "same-paid-job", stage: "created" });
      throw new StudioProviderError("STUDIO_PROVIDER_RATE_LIMITED", 60000, false, true);
    });
    provider.mockImplementationOnce(async (input) => {
      expect(input.recovery?.saved).toEqual({ jobId: "same-paid-job", stage: "created" });
      return {
        language: "te",
        durationMs: input.durationMs,
        provenance: "MACHINE_TRANSCRIPT",
        sourceTranscriptId: null,
        segments: [{ id: "segment-1", startMs: 0, endMs: input.durationMs, text: "జయ గురు దత్త." }],
      };
    });
    const input = {
      sourcePath: "/private/synthetic.mp4",
      mimeType: "video/mp4",
      directory,
      ffmpeg: "/synthetic/ffmpeg",
      durationMs: 20000,
      fingerprint: "source-fingerprint",
      checkpoints,
      provider: { language: "te", apiKey: "synthetic", fetcher: vi.fn<typeof fetch>() },
    };
    const task = transcribeStudioSections(input);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60000);
    const transcript = await task;
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await transcribeStudioSections(input)).toEqual(transcript);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(checkpoints.progress).toHaveBeenLastCalledWith({
      phase: "transcription",
      provider: "sarvam",
      completed: 1,
      total: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("starts capacity recovery with small sections and preserves every source millisecond", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-capacity-section-test-"));
  try {
    vi.spyOn(process, "executeStudioSource").mockImplementation(async (input) => {
      if (input.output === "stderr") return "silence_end: 25 | silence_duration: 1";
      await writeFile(input.args.at(-1) as string, "synthetic audio");
      return "";
    });
    const provider = vi
      .spyOn(sarvam, "transcribeSarvamStudioAudio")
      .mockImplementation(async (input) => ({
        language: "te",
        durationMs: input.durationMs,
        provenance: "MACHINE_TRANSCRIPT",
        sourceTranscriptId: null,
        segments: [{ id: "segment-1", startMs: 0, endMs: input.durationMs, text: "జయ గురు దత్త." }],
      }));
    const joined = await transcribeStudioSections({
      sourcePath: "/private/synthetic.mp4",
      mimeType: "video/mp4",
      directory,
      ffmpeg: "/synthetic/ffmpeg",
      durationMs: 310135,
      fingerprint: "capacity-limited-source",
      capacityLimited: true,
      provider: { language: "te", apiKey: "synthetic", fetcher: vi.fn<typeof fetch>() },
    });
    expect(provider).toHaveBeenCalledTimes(3);
    expect(provider.mock.calls.every(([input]) => input.durationMs <= 120000)).toBe(true);
    expect(joined.segments[0]?.startMs).toBe(0);
    expect(joined.segments.at(-1)?.endMs).toBe(310135);
    for (let i = 1; i < joined.segments.length; i++)
      expect(joined.segments[i]?.startMs).toBe(joined.segments[i - 1]?.endMs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it.each(["STUDIO_PROVIDER_TIMEOUT", "STUDIO_TRANSCRIPTION_CONTEXT_LIMIT"])(
  "recovers %s without repeating completed ASR or losing source coverage",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "studio-section-test-"));
    try {
      const extraction = vi
        .spyOn(process, "executeStudioSource")
        .mockImplementation(async (input) => {
          if (input.output === "stderr") return "silence_end: 25 | silence_duration: 1";
          const path = input.args.at(-1);
          if (!path) throw Error("MISSING_OUTPUT");
          await writeFile(path, "private synthetic audio", { mode: 0o600 });
          return "";
        });
      const saved = new Map<string, { fingerprint: string; value: unknown }>();
      const progress = vi.fn();
      const checkpoints: StudioCheckpoints = {
        get: <T>(key: string, fingerprint: string) =>
          saved.get(key)?.fingerprint === fingerprint
            ? (structuredClone(saved.get(key)?.value) as T)
            : undefined,
        set: async (key, fingerprint, value) => {
          saved.set(key, { fingerprint, value: structuredClone(value) });
        },
        progress,
      };
      let calls = 0;
      const provider = vi
        .spyOn(sarvam, "transcribeSarvamStudioAudio")
        .mockImplementation(async (input) => {
          calls++;
          await input.recovery?.save({ jobId: `saved-${calls}`, stage: "started" });
          if (calls === 2) throw Error(failure);
          return {
            language: "te",
            durationMs: input.durationMs,
            provenance: "MACHINE_TRANSCRIPT",
            sourceTranscriptId: null,
            segments: [
              { id: "segment-1", startMs: 0, endMs: input.durationMs, text: "జయ గురు దత్త." },
            ],
          };
        });
      const input = {
        sourcePath: "/private/synthetic.mp4",
        mimeType: "video/mp4",
        directory,
        ffmpeg: "/synthetic/ffmpeg",
        durationMs: 4400135,
        fingerprint: "source-fingerprint",
        checkpoints,
        provider: {
          language: "te",
          model: "saaras:v4",
          apiKey: "synthetic",
          fetcher: vi.fn<typeof fetch>(),
        },
      };
      if (failure === "STUDIO_PROVIDER_TIMEOUT")
        await expect(transcribeStudioSections(input)).rejects.toThrow(failure);
      const joined = await transcribeStudioSections(input);
      if (failure === "STUDIO_TRANSCRIPTION_CONTEXT_LIMIT") {
        expect(joined.segments[0]?.startMs).toBe(0);
        expect(joined.segments.at(-1)?.endMs).toBe(input.durationMs);
        for (let i = 1; i < joined.segments.length; i++)
          expect(joined.segments[i]?.startMs).toBe(joined.segments[i - 1]?.endMs);
        const callsBeforeResume = provider.mock.calls.length;
        expect(await transcribeStudioSections(input)).toEqual(joined);
        expect(provider).toHaveBeenCalledTimes(callsBeforeResume);
        expect(saved.has("transcription-split:1794500-3589000")).toBe(true);
        return;
      }
      expect(provider).toHaveBeenCalledTimes(4);
      expect(provider.mock.calls[2]?.[0].recovery?.saved).toEqual({
        jobId: "saved-2",
        stage: "started",
      });
      expect(joined.segments).toEqual([
        { id: "segment-1", startMs: 0, endMs: 1794500, text: "జయ గురు దత్త." },
        { id: "segment-2", startMs: 1794500, endMs: 3589000, text: "జయ గురు దత్త." },
        { id: "segment-3", startMs: 3589000, endMs: 4400135, text: "జయ గురు దత్త." },
      ]);
      expect(extraction.mock.calls.filter(([input]) => input.output === "stderr")).toHaveLength(2);
      expect(progress).toHaveBeenLastCalledWith({
        phase: "transcription",
        provider: "sarvam",
        completed: 3,
        total: 3,
      });
      expect(input.provider.fetcher).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

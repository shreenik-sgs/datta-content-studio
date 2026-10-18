import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioCheckpoints } from "./studio-checkpoints";
import * as process from "./studio-process";
import * as sarvam from "./studio-sarvam";
import { transcribeStudioSections } from "./studio-transcription-sections";

afterEach(() => vi.restoreAllMocks());
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

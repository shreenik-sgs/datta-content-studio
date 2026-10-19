import { afterEach, expect, it, vi } from "vitest";
import { transcribeAdaptiveSarvam } from "./studio-adaptive-transcription";
import type { StudioCheckpoints } from "./studio-checkpoints";
import * as sarvam from "./studio-sarvam";
import * as sections from "./studio-transcription-sections";

afterEach(() => vi.restoreAllMocks());
function fixture(durationMs = 45 * 60 * 1000) {
  const saved = new Map<string, { fingerprint: string; value: unknown }>();
  const checkpoints: StudioCheckpoints = {
    get: <T>(key: string, fingerprint: string) =>
      saved.get(key)?.fingerprint === fingerprint ? (saved.get(key)?.value as T) : undefined,
    set: async (key, fingerprint, value) => {
      saved.set(key, { fingerprint, value });
    },
    progress: vi.fn(),
  };
  return {
    sourcePath: "/private/synthetic.mp4",
    mimeType: "video/mp4",
    directory: "/private/synthetic",
    ffmpeg: "/synthetic/ffmpeg",
    durationMs,
    fingerprint: "source-fingerprint",
    checkpoints,
    provider: { language: "te", apiKey: "synthetic", fetcher: vi.fn<typeof fetch>() },
    audio: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
}

it("splits a short master after a confirmed capacity failure and resumes without repeating the failed paid job", async () => {
  const input = fixture();
  await input.checkpoints.set("sarvam-job", input.fingerprint, {
    jobId: "existing-job",
    stage: "started",
  });
  const whole = vi
    .spyOn(sarvam, "transcribeSarvamStudioAudio")
    .mockRejectedValue(new Error("STUDIO_TRANSCRIPTION_CONTEXT_LIMIT"));
  const split = vi
    .spyOn(sections, "transcribeStudioSections")
    .mockRejectedValueOnce(new Error("STUDIO_PROVIDER_TIMEOUT"))
    .mockResolvedValueOnce({
      language: "te",
      durationMs: input.durationMs,
      sourceTranscriptId: null,
      provenance: "MACHINE_TRANSCRIPT",
      segments: [{ id: "segment-1", text: "జయ గురు దత్త.", startMs: 0, endMs: input.durationMs }],
    });
  await expect(transcribeAdaptiveSarvam(input)).rejects.toThrow("STUDIO_PROVIDER_TIMEOUT");
  expect(whole.mock.calls[0]?.[0].recovery?.saved).toEqual({
    jobId: "existing-job",
    stage: "started",
  });
  expect(split.mock.calls[0]?.[0].capacityLimited).toBe(true);
  expect((await transcribeAdaptiveSarvam(input)).durationMs).toBe(input.durationMs);
  expect(whole).toHaveBeenCalledTimes(1);
  expect(input.audio).toHaveBeenCalledTimes(1);
  expect(split).toHaveBeenCalledTimes(2);
  expect(split.mock.calls[1]?.[0].checkpoints).toBe(input.checkpoints);
});

it.each([
  "STUDIO_PROVIDER_TIMEOUT",
  "STUDIO_TRANSCRIPTION_START_UNCERTAIN",
  "STUDIO_PROVIDER_AUTHENTICATION_FAILED",
])("does not create new section jobs after %s", async (code) => {
  const input = fixture();
  vi.spyOn(sarvam, "transcribeSarvamStudioAudio").mockRejectedValue(new Error(code));
  const split = vi.spyOn(sections, "transcribeStudioSections");
  await expect(transcribeAdaptiveSarvam(input)).rejects.toThrow(code);
  expect(split).not.toHaveBeenCalled();
  expect(input.checkpoints.get("sarvam-capacity-fallback", input.fingerprint)).toBeUndefined();
});

it("reports a capacity failure on a minimum-size section without retrying identical audio", async () => {
  vi.spyOn(sarvam, "transcribeSarvamStudioAudio").mockRejectedValue(
    new Error("STUDIO_TRANSCRIPTION_CONTEXT_LIMIT"),
  );
  const split = vi.spyOn(sections, "transcribeStudioSections");
  await expect(transcribeAdaptiveSarvam(fixture(30000))).rejects.toThrow(
    "STUDIO_TRANSCRIPTION_CONTEXT_LIMIT",
  );
  expect(split).not.toHaveBeenCalled();
});

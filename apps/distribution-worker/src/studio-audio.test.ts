import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUDIO_AUDIO_POLICY, validateStudioAudioLevel } from "@satsang/distribution-domain";
import sharp from "sharp";
import { expect, it } from "vitest";
import { measureStudioAudio, parseStudioAudioMeasurement } from "./studio-audio";
import { renderStudioVideo } from "./studio-media";

it("rejects inaudible, missing, or invalid measurements rather than passing a silent output", () => {
  expect(() => parseStudioAudioMeasurement("no measurements")).toThrow(
    "STUDIO_AUDIO_MEASUREMENT_FAILED",
  );
  expect(() =>
    parseStudioAudioMeasurement(
      '{"input_i":"-inf","input_tp":"-inf","input_lra":"0","input_thresh":"-70","target_offset":"inf"}',
    ),
  ).toThrow("STUDIO_AUDIO_UNUSABLE");
  for (const [level, peak] of [
    [-39, -17],
    [-22, 0],
    [Number.NaN, -4],
    [-22, Number.NaN],
  ] as const) {
    expect(() => validateStudioAudioLevel(level, peak)).toThrow("STUDIO_AUDIO_QUALITY_FAILED");
  }
  expect(() => validateStudioAudioLevel(-21.8, -4.2)).not.toThrow();
});

it("renders quiet and normal source clips to matching measured speech levels without clipping", async () => {
  const ffmpeg =
    process.env.DISTRIBUTION_TEST_FFMPEG ??
    (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
  const dir = await mkdtemp(join(realpathSync(tmpdir()), "studio-audio-"));
  const levels: number[] = [];
  try {
    const backdrop = await sharp({
      create: { width: 1080, height: 1920, channels: 4, background: "#00000000" },
    })
      .png()
      .toBuffer();
    for (const gain of [-17, 0]) {
      const directory = join(dir, String(gain));
      await mkdir(directory);
      const sourcePath = join(directory, "source.wav");
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-af",
        `volume=${gain}dB`,
        "-t",
        "5",
        sourcePath,
      ]);
      const output = await renderStudioVideo({
        ffmpeg,
        directory,
        sourcePath,
        mimeType: "audio/wav",
        backdrop,
        hasVideo: false,
        hasAudio: true,
        startMs: 0,
        endMs: 5000,
        captions: [],
      });
      const measured = await measureStudioAudio({
        ffmpeg,
        directory,
        sourcePath: output,
        mimeType: "video/mp4",
        startMs: 0,
        endMs: 5000,
      });
      expect(Math.abs(measured.integratedLufs - STUDIO_AUDIO_POLICY.integratedLufs)).toBeLessThan(
        0.5,
      );
      expect(measured.truePeakDbtp).toBeLessThanOrEqual(STUDIO_AUDIO_POLICY.maximumTruePeakDbtp);
      levels.push(measured.integratedLufs);
    }
    expect(Math.abs((levels[0] ?? Number.NaN) - (levels[1] ?? Number.NaN))).toBeLessThan(0.2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { replaceStudioClosingCard } from "./studio-closing-refresh";

const ffmpeg =
  process.env.DISTRIBUTION_TEST_FFMPEG ??
  (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
it.skipIf(!existsSync(ffmpeg))(
  "preserves the final AAC packet when the saved timeline rounds to milliseconds",
  async () => {
    const directory = await mkdtemp(join(realpathSync(tmpdir()), "studio-card-rounding-"));
    try {
      const sourcePath = join(directory, "previous.mp4");
      execFileSync(
        ffmpeg,
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=1080x1920:rate=30",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000",
          "-t",
          "6.033",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-threads",
          "1",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          sourcePath,
        ],
        { timeout: 60000 },
      );
      const card = await sharp({
        create: { width: 1080, height: 1920, channels: 3, background: "#173c36" },
      })
        .png()
        .toBuffer();
      const result = await replaceStudioClosingCard({
        sourcePath,
        directory,
        ffmpeg,
        card,
        startMs: 1001,
        endMs: 6001,
      });
      expect(result.audioSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.minimumFrameSsim).toBeGreaterThanOrEqual(0.995);
      expect(result.minimumCaptionSsim).toBeGreaterThanOrEqual(0.995);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  90000,
);

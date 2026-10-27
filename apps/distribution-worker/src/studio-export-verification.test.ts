import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrivateAssetStore } from "@satsang/distribution-assets";
import { type StudioOutput, studioClosingCardPlan } from "@satsang/distribution-domain";
import sharp from "sharp";
import { expect, it } from "vitest";
import { verifyStudioCardPixels, verifyStudioExport } from "./studio-export-verification";
import { studioVtt } from "./studio-media";

const ffmpeg =
  process.env.DISTRIBUTION_TEST_FFMPEG ??
  (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
it.skipIf(!existsSync(ffmpeg))(
  "checks real media and refuses a wrong portrait, name, either link, or retimed captions",
  async () => {
    const directory = await mkdtemp(join(realpathSync(tmpdir()), "studio-media-proof-"));
    try {
      const card = await sharp({
        create: { width: 1080, height: 1920, channels: 3, background: "#173c36" },
      })
        .png()
        .toBuffer();
      const image = join(directory, "card.png");
      const path = join(directory, "synthetic.mp4");
      await writeFile(image, card);
      const plan = studioClosingCardPlan(2000);
      execFileSync(
        ffmpeg,
        [
          "-v",
          "error",
          "-loop",
          "1",
          "-i",
          image,
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000",
          "-t",
          String(plan.endMs / 1000),
          "-r",
          "5",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          path,
        ],
        { timeout: 30000 },
      );
      const cues = [
        { id: "one", startMs: 0, endMs: 2000, text: "Original teaching & accurate captions." },
      ];
      let captions = Buffer.from(studioVtt(cues, 0, 2000));
      const output = {
        startMs: 0,
        endMs: 2000,
        language: "en",
        fileVersion: 2,
        asset: { mimeType: "video/mp4", sha256: sha(await readFile(path)) },
        presentationReview: { closingCard: plan },
        captionCues: cues,
        captions: [{ language: "en", asset: { sha256: sha(captions) } }],
      } as StudioOutput;
      const store = { readDerivedDescriptor: async () => captions } as unknown as PrivateAssetStore;
      const input = { path, directory, ffmpeg, card, output, store };
      expect(await verifyStudioExport(input)).toMatchObject({
        decoded: true,
        cardPixelsVerified: true,
        captionsVerified: true,
        fileVersion: 2,
      });
      for (const [left, top, width, height] of [
        [250, 250, 500, 500],
        [100, 830, 800, 200],
        [60, 1040, 880, 165],
        [60, 1250, 880, 100],
      ] as const) {
        const patch = await sharp({
          create: { width: width, height: height, channels: 3, background: "#ffffff" },
        })
          .png()
          .toBuffer();
        const wrong = await sharp(card)
          .composite([{ input: patch, left: left, top: top }])
          .png()
          .toBuffer();
        await expect(verifyStudioCardPixels({ ...input, card: wrong, plan })).rejects.toThrow(
          "STUDIO_EXPORT_CARD_MISMATCH",
        );
      }
      const cue = cues[0];
      const track = output.captions[0];
      if (!cue || !track) throw Error("fixture");
      captions = Buffer.from(studioVtt([{ ...cue, startMs: 1000 }], 0, 2000));
      track.asset.sha256 = sha(captions); // A consistent descriptor alone must not pass.
      await expect(verifyStudioExport(input)).rejects.toThrow("STUDIO_EXPORT_CAPTIONS_INVALID");
      await writeFile(path, (await readFile(path)).subarray(0, 120));
      await expect(verifyStudioExport(input)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60000,
);

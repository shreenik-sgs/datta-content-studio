import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PrivateAssetStore } from "@satsang/distribution-assets";
import type { StudioClosingCard, StudioOutput } from "@satsang/distribution-domain";
import sharp from "sharp";
import { studioVtt } from "./studio-media";
import { executeStudioSource } from "./studio-process";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Compare separate portrait, name, full-video and subscription regions. An
 * almost-correct background cannot hide a missing handle or the wrong portrait. */
export async function verifyStudioCardPixels(input: {
  path: string;
  directory: string;
  ffmpeg: string;
  card: Uint8Array;
  plan: StudioClosingCard;
  signal?: AbortSignal;
}) {
  const regions = [
    { left: 250, top: 250, width: 500, height: 500 },
    { left: 100, top: 830, width: 800, height: 200 },
    { left: 60, top: 1040, width: 880, height: 165 },
    { left: 60, top: 1250, width: 880, height: 100 },
  ];
  const expected = await Promise.all(
    regions.map((region) => sharp(input.card).extract(region).removeAlpha().raw().toBuffer()),
  );
  const differences: number[] = [];
  for (const [index, at] of [input.plan.startMs + 800, input.plan.endMs - 1000].entries()) {
    const frame = join(input.directory, `verified-card-${index}.png`);
    await executeStudioSource({
      executable: input.ffmpeg,
      sourcePath: input.path,
      mimeType: "video/mp4",
      directory: input.directory,
      timeoutMs: 120000,
      ...(input.signal ? { signal: input.signal } : {}),
      args: [
        "-v",
        "error",
        "-y",
        "-ss",
        String(at / 1000),
        "-i",
        "__SOURCE__",
        "-frames:v",
        "1",
        "-update",
        "1",
        frame,
      ],
    });
    const bytes = await readFile(frame);
    for (const [i, region] of regions.entries()) {
      const actual = await sharp(bytes).extract(region).removeAlpha().raw().toBuffer();
      const reference = expected[i];
      if (!reference || reference.length !== actual.length)
        throw Error("STUDIO_EXPORT_CARD_MISMATCH");
      let total = 0;
      for (let p = 0; p < actual.length; p++)
        total += Math.abs((actual[p] ?? 0) - (reference[p] ?? 0));
      const difference = total / actual.length;
      if (!Number.isFinite(difference) || difference >= 4)
        throw Error("STUDIO_EXPORT_CARD_MISMATCH");
      differences.push(difference);
    }
  }
  return differences;
}

/** Read actual private media and captions. This does not render or call AI. */
export async function verifyStudioExport(input: {
  path: string;
  directory: string;
  ffmpeg: string;
  card: Uint8Array;
  output: StudioOutput;
  store: PrivateAssetStore;
  signal?: AbortSignal;
}) {
  const { output } = input;
  const plan = output.presentationReview?.closingCard;
  if (!plan || !output.asset || output.asset.mimeType !== "video/mp4")
    throw Error("STUDIO_EXPORT_INVALID");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(input.path)) digest.update(chunk);
  if (digest.digest("hex") !== output.asset.sha256) throw Error("STUDIO_EXPORT_INVALID");
  const execute = (args: string[], executable = input.ffmpeg) =>
    executeStudioSource({
      executable,
      sourcePath: input.path,
      mimeType: "video/mp4",
      directory: input.directory,
      timeoutMs: 1200000,
      ...(input.signal ? { signal: input.signal } : {}),
      args,
    });
  const probeFile = join(input.directory, "verified-streams.json");
  await execute(
    [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      "-o",
      probeFile,
      "-i",
      "__SOURCE__",
    ],
    join(dirname(input.ffmpeg), "ffprobe"),
  );
  const probe = JSON.parse(await readFile(probeFile, "utf8")) as {
    streams: { codec_type: string; width?: number; height?: number }[];
    format: { duration: string };
  };
  const video = probe.streams.filter((s) => s.codec_type === "video");
  const audio = probe.streams.filter((s) => s.codec_type === "audio");
  const durationMs = Number(probe.format.duration) * 1000;
  if (
    video.length !== 1 ||
    audio.length !== 1 ||
    video[0]?.width !== 1080 ||
    video[0]?.height !== 1920 ||
    !Number.isFinite(durationMs) ||
    Math.abs(durationMs - plan.endMs) > 150
  )
    throw Error("STUDIO_EXPORT_INVALID");
  // Decode the whole export; a valid header or last frame cannot hide a truncated middle.
  await execute([
    "-v",
    "error",
    "-xerror",
    "-i",
    "__SOURCE__",
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ]);
  const audioResult = await execute([
    "-v",
    "error",
    "-i",
    "__SOURCE__",
    "-map",
    "0:a:0",
    "-c:a",
    "copy",
    "-f",
    "hash",
    "-hash",
    "sha256",
    "-",
  ]);
  const audioSha256 = /SHA256=([a-f0-9]{64})/.exec(audioResult)?.[1];
  if (!audioSha256) throw Error("STUDIO_EXPORT_INVALID");
  const caption = output.captions.find((c) => c.language === output.language);
  if (!caption || !output.captionCues?.length) throw Error("STUDIO_EXPORT_CAPTIONS_INVALID");
  const bytes = await input.store.readDerivedDescriptor(caption.asset);
  const text = Buffer.from(bytes).toString("utf8");
  if (
    output.startMs == null ||
    output.endMs == null ||
    sha(bytes) !== caption.asset.sha256 ||
    text !== studioVtt(output.captionCues, output.startMs, output.endMs)
  )
    throw Error("STUDIO_EXPORT_CAPTIONS_INVALID");
  const cardDifferences = await verifyStudioCardPixels({ ...input, plan });
  return {
    policy: "studio-export-verification-v1",
    verifiedAt: new Date().toISOString(),
    renderedSha256: output.asset.sha256,
    fileVersion: output.fileVersion ?? 1,
    durationMs,
    audioSha256,
    captionSha256: caption.asset.sha256,
    language: output.language,
    decoded: true,
    captionsVerified: true,
    cardPixelsVerified: true,
    cardDifferences,
    cardSha256: sha(input.card),
    closingCard: plan,
  };
}

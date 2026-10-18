import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function previewFileSha256(path: string): Promise<string> {
  if (!isAbsolute(path) || !(await lstat(path)).isFile()) throw new Error("LOCAL_FILE_REQUIRED");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export type PreviewClipRequest = {
  world: "TEST";
  publishAllowed: false;
  sourcePath: string;
  sourceSha256: string;
  backdropPath: string;
  backdropSha256: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  size: "vertical" | "x";
};
export function previewClipArguments(input: PreviewClipRequest): string[] {
  if (input.world !== "TEST" || input.publishAllowed !== false) throw new Error("PREVIEW_ONLY");
  if (![input.sourcePath, input.backdropPath, input.outputPath].every(isAbsolute))
    throw new Error("LOCAL_FILE_REQUIRED");
  if (
    ![input.startMs, input.endMs, input.durationMs].every(Number.isSafeInteger) ||
    input.startMs < 0 ||
    input.endMs <= input.startMs ||
    input.endMs > input.durationMs ||
    input.endMs - input.startMs > (input.size === "x" ? 140000 : 180000) ||
    !["vertical", "x"].includes(input.size)
  )
    throw new Error("INVALID_PREVIEW_BOUNDARY");
  const scale = input.size === "x" ? ",scale=720:1280" : "";
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    "-protocol_whitelist",
    "file,pipe",
    "-f",
    "image2",
    "-vcodec",
    "png",
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    input.backdropPath,
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    "mov",
    "-enable_drefs",
    "0",
    "-use_absolute_path",
    "0",
    "-f",
    "mov",
    "-ss",
    (input.startMs / 1000).toFixed(3),
    "-i",
    input.sourcePath,
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    `[1:v:0]setpts=PTS-STARTPTS,scale=1080:608:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:608:(ow-iw)/2:(oh-ih)/2:color=0x25151d,setsar=1[scene];[0:v:0][scene]overlay=0:570:shortest=1${scale},format=yuv420p[out]`,
    "-map",
    "[out]",
    "-map",
    "1:a:0",
    "-t",
    ((input.endMs - input.startMs) / 1000).toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-r",
    "30",
    "-threads",
    "2",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-movflags",
    "+faststart",
    input.outputPath,
  ];
}
export async function renderPreviewClip(input: PreviewClipRequest, ffmpeg = "ffmpeg") {
  const args = previewClipArguments(input);
  if (
    (await previewFileSha256(input.sourcePath)) !== input.sourceSha256 ||
    (await previewFileSha256(input.backdropPath)) !== input.backdropSha256
  )
    throw new Error("PREVIEW_SOURCE_HASH_MISMATCH");
  await run(ffmpeg, args, { timeout: 300000, maxBuffer: 1024 * 1024 });
  if (
    (await previewFileSha256(input.sourcePath)) !== input.sourceSha256 ||
    (await previewFileSha256(input.backdropPath)) !== input.backdropSha256
  )
    throw new Error("PREVIEW_SOURCE_CHANGED");
  await chmod(input.outputPath, 0o600);
  return {
    sha256: await previewFileSha256(input.outputPath),
    byteSize: (await lstat(input.outputPath)).size,
  };
}
export async function probePreviewMedia(path: string, ffprobe = "ffprobe") {
  if (!isAbsolute(path) || !(await lstat(path)).isFile()) throw new Error("LOCAL_FILE_REQUIRED");
  const { stdout } = await run(
    ffprobe,
    [
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "mov",
      "-enable_drefs",
      "0",
      "-use_absolute_path",
      "0",
      "-f",
      "mov",
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=codec_name,codec_type,width,height,r_frame_rate",
      "-of",
      "json",
      path,
    ],
    { timeout: 15000, maxBuffer: 65536 },
  );
  return JSON.parse(stdout) as {
    streams: {
      codec_name: string;
      codec_type: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }[];
    format: { duration: string; size: string };
  };
}

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { runIsolatedMediaProcess } from "./renderer.js";

const MAX_INPUT_PIXELS = 16777216;
export function validateStudioSourceDimensions(
  streams: { codec_type?: string; width?: number; height?: number }[],
): void {
  if (
    !Array.isArray(streams) ||
    streams.some(
      (stream) =>
        stream.codec_type === "video" &&
        (!Number.isSafeInteger(stream.width) ||
          !Number.isSafeInteger(stream.height) ||
          Number(stream.width) < 1 ||
          Number(stream.height) < 1 ||
          Number(stream.width) * Number(stream.height) > MAX_INPUT_PIXELS),
    )
  )
    throw new Error("STUDIO_MEDIA_DIMENSIONS_INVALID");
}

/** Only the verified source descriptor is visible to the demuxer; external references cannot open files or URLs. */
export async function executeStudioSource(input: {
  executable: string;
  args: string[];
  sourcePath: string;
  mimeType: string;
  directory: string;
  timeoutMs: number;
  signal?: AbortSignal;
  output?: "stdout" | "stderr";
}): Promise<string> {
  const demuxer = (
    {
      "video/mp2t": "mpegts",
      "video/mp4": "mov",
      "audio/mp4": "mov",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
    } as Record<string, string>
  )[input.mimeType];
  if (!demuxer) throw new Error("UNSUPPORTED_RENDER_MEDIA");
  const index = input.args.indexOf("__SOURCE__");
  if (index < 1 || input.args[index - 1] !== "-i") throw new Error("INVALID_STUDIO_PROCESS");
  const args = [
    "-max_alloc",
    "134217728",
    ...input.args.slice(0, index - 1),
    "-protocol_whitelist",
    "fd",
    "-format_whitelist",
    demuxer,
    ...(demuxer === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
    "-max_pixels",
    String(MAX_INPUT_PIXELS),
    "-threads",
    "1",
    "-f",
    demuxer,
    "-fd",
    "3",
    "-i",
    "fd:",
    ...input.args.slice(index + 1),
  ];
  const file = await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await runIsolatedMediaProcess({
      executable: input.executable,
      args,
      cwd: input.directory,
      deadline: Date.now() + input.timeoutMs,
      inputFd: file.fd,
      ...(input.output ? { output: input.output } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } finally {
    await file.close();
  }
}

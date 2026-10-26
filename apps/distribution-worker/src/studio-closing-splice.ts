import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STUDIO_SUBTITLE_TOP } from "@satsang/distribution-domain";
import { executeStudioSource } from "./studio-process.js";

type Packet = { pts: number; dts: number; duration: number; flags: string };
type Video = {
  codec_name: string;
  profile: string;
  level: number;
  width: number;
  height: number;
  pix_fmt: string;
  time_base: string;
  extradata_hash: string;
};
export type ClosingSpliceMetadata = { streams: Video[]; packets: Packet[] };

/** Only a closed H.264 GOP can separate copied footage from the newly encoded ending. */
export function planClosingSplice(data: ClosingSpliceMetadata, startMs: number) {
  const stream = data.streams[0];
  const packets = data.packets;
  const timeScale = Number(stream?.time_base?.split("/")[1]);
  if (
    data.streams.length !== 1 ||
    !stream ||
    stream.codec_name !== "h264" ||
    stream.width !== 1080 ||
    stream.height !== 1920 ||
    stream.pix_fmt !== "yuv420p" ||
    stream.profile !== "High" ||
    !stream.time_base.startsWith("1/") ||
    !Number.isSafeInteger(timeScale) ||
    timeScale < 1 ||
    !packets.length ||
    !/^SHA256:[a-f0-9]{64}$/i.test(stream.extradata_hash ?? "") ||
    !Number.isFinite(startMs) ||
    startMs < 0
  )
    throw Error("STUDIO_CLOSING_SPLICE_UNSUPPORTED");
  const step = packets[0]?.duration ?? 0;
  const presentation = packets.map((p) => p.pts).sort((a, b) => a - b);
  if (
    !Number.isSafeInteger(step) ||
    step < 1 ||
    packets.some(
      (p, i) =>
        !Number.isSafeInteger(p.pts) ||
        !Number.isSafeInteger(p.dts) ||
        p.duration !== step ||
        (i > 0 && p.dts !== (packets[i - 1]?.dts ?? Number.NaN) + step),
    ) ||
    presentation.some((pts, i) => pts !== i * step)
  )
    throw Error("STUDIO_CLOSING_SPLICE_UNSUPPORTED_TIMING");
  const candidates = packets
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => p.flags.includes("K") && p.pts * 1000 <= startMs * timeScale);
  const boundary = candidates.at(-1);
  if (!boundary || boundary.index * step !== boundary.p.pts)
    throw Error("STUDIO_CLOSING_SPLICE_UNSAFE_BOUNDARY");
  return {
    timeScale,
    splitSeconds: boundary.p.pts / timeScale,
    copiedPackets: boundary.index,
    encodedPackets: packets.length - boundary.index,
    totalPackets: packets.length,
  };
}

/** Encoding may reorder B frames; presentation times must still match exactly. */
export function validateClosingSpliceTimeline(
  before: ClosingSpliceMetadata,
  after: ClosingSpliceMetadata,
  copiedPackets: number,
) {
  const oldTimes = before.packets
    .map((p) => [p.pts, p.duration])
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  const newTimes = after.packets
    .map((p) => [p.pts, p.duration])
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  if (
    after.streams[0]?.time_base !== before.streams[0]?.time_base ||
    after.packets.length !== before.packets.length ||
    JSON.stringify(oldTimes) !== JSON.stringify(newTimes) ||
    after.packets.some(
      (p, i) =>
        !Number.isSafeInteger(p.dts) ||
        (i > 0 && p.dts <= (after.packets[i - 1]?.dts ?? Number.POSITIVE_INFINITY)) ||
        (i < copiedPackets &&
          (p.pts !== before.packets[i]?.pts || p.dts !== before.packets[i]?.dts)),
    )
  )
    throw Error("STUDIO_CLOSING_SPLICE_TIMING_CHANGED");
}

function hasIdr(bytes: Buffer) {
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 1 &&
      ((bytes[i + 3] ?? 0) & 31) === 5
    )
      return true;
  }
  return false;
}

/** No full-video fallback: unsupported inputs fail before any saved Studio asset is changed. */
export async function spliceClosingVideo(input: {
  sourcePath: string;
  directory: string;
  ffmpeg: string;
  cardPath: string;
  startMs: number;
  crf: number;
  signal?: AbortSignal;
}) {
  const { directory, sourcePath, ffmpeg } = input;
  const execute = (source: string, args: string[], executable = ffmpeg) =>
    executeStudioSource({
      executable,
      sourcePath: source,
      mimeType: "video/mp4",
      directory,
      timeoutMs: 300000,
      ...(input.signal ? { signal: input.signal } : {}),
      args,
    });
  const probe = async (source: string, label: string) => {
    const path = join(directory, `${label}-packets.json`);
    await execute(
      source,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_packets",
        "-show_streams",
        "-show_data_hash",
        "sha256",
        "-show_entries",
        "stream=codec_name,profile,level,width,height,pix_fmt,time_base,extradata_hash:packet=pts,dts,duration,flags",
        "-of",
        "json",
        "-o",
        path,
        "-i",
        "__SOURCE__",
      ],
      join(dirname(ffmpeg), "ffprobe"),
    );
    return JSON.parse(await readFile(path, "utf8")) as ClosingSpliceMetadata;
  };
  const before = await probe(sourcePath, "before");
  const plan = planClosingSplice(before, input.startMs);
  const { splitSeconds, copiedPackets, encodedPackets, timeScale } = plan;
  // K flags alone can denote an open GOP. Require an actual IDR NAL at the boundary.
  const idr = join(directory, "boundary.h264");
  await execute(sourcePath, [
    "-v",
    "error",
    "-y",
    "-ss",
    String(splitSeconds),
    "-i",
    "__SOURCE__",
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-c:v",
    "copy",
    "-bsf:v",
    "h264_mp4toannexb",
    "-f",
    "h264",
    idr,
  ]);
  if (!hasIdr(await readFile(idr))) throw Error("STUDIO_CLOSING_SPLICE_UNSAFE_BOUNDARY");
  if (copiedPackets) {
    await execute(sourcePath, [
      "-v",
      "error",
      "-y",
      "-i",
      "__SOURCE__",
      "-map",
      "0:v:0",
      "-frames:v",
      String(copiedPackets),
      "-c:v",
      "copy",
      "-an",
      "-map_metadata",
      "-1",
      "-video_track_timescale",
      String(timeScale),
      join(directory, "prefix.mp4"),
    ]);
  }
  const cardStart = input.startMs / 1000 - splitSeconds;
  await execute(sourcePath, [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-ss",
    String(splitSeconds),
    "-i",
    "__SOURCE__",
    "-loop",
    "1",
    "-i",
    input.cardPath,
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    `[1:v]crop=1080:${STUDIO_SUBTITLE_TOP}:0:0,format=yuva420p,fade=t=in:st=${cardStart}:d=0.4:alpha=1[card];[0:v][card]overlay=0:0:enable='gte(t,${cardStart})':shortest=1:format=yuv420[v]`,
    "-map",
    "[v]",
    "-an",
    "-frames:v",
    String(encodedPackets),
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(input.crf),
    "-profile:v",
    "high",
    "-level:v",
    String((before.streams[0]?.level ?? 0) / 10),
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "2",
    "-video_track_timescale",
    String(timeScale),
    "-map_metadata",
    "-1",
    join(directory, "ending.mp4"),
  ]);
  const list = join(directory, "join.ffconcat");
  await writeFile(
    list,
    `ffconcat version 1.0\n${copiedPackets ? `file prefix.mp4\nduration ${splitSeconds}\n` : ""}file ending.mp4\n`,
    { mode: 0o600 },
  );
  const path = join(directory, "closing-refresh.mp4");
  // The concat file and both video inputs are generated inside private scratch. Audio is
  // read through the isolated original descriptor, including its final AAC packet.
  await execute(sourcePath, [
    "-v",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "1",
    "-i",
    list,
    "-i",
    "__SOURCE__",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c",
    "copy",
    "-video_track_timescale",
    String(timeScale),
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-movflags",
    "+faststart",
    path,
  ]);
  const after = await probe(path, "after");
  validateClosingSpliceTimeline(before, after, copiedPackets);
  let prefixSha256: string | undefined;
  if (copiedPackets) {
    if (after.streams[0]?.extradata_hash !== before.streams[0]?.extradata_hash)
      throw Error("STUDIO_CLOSING_SPLICE_HEADERS_CHANGED");
    const hash = async (source: string) => {
      const output = await execute(source, [
        "-v",
        "error",
        "-i",
        "__SOURCE__",
        "-map",
        "0:v:0",
        "-frames:v",
        String(copiedPackets),
        "-c:v",
        "copy",
        "-bsf:v",
        "h264_mp4toannexb,filter_units=pass_types=1-5",
        "-f",
        "hash",
        "-hash",
        "sha256",
        "-",
      ]);
      const value = /SHA256=([a-f0-9]{64})/.exec(output)?.[1];
      if (!value) throw Error("STUDIO_CLOSING_SPLICE_PREFIX_CHANGED");
      return value;
    };
    prefixSha256 = await hash(sourcePath);
    if (prefixSha256 !== (await hash(path))) throw Error("STUDIO_CLOSING_SPLICE_PREFIX_CHANGED");
  }
  const audioTiming = async (source: string, name: string) => {
    const report = join(directory, `${name}-audio.json`);
    await execute(
      source,
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_packets",
        "-show_streams",
        "-show_entries",
        "stream=time_base:packet=pts,dts,duration",
        "-of",
        "json",
        "-o",
        report,
        "-i",
        "__SOURCE__",
      ],
      join(dirname(ffmpeg), "ffprobe"),
    );
    const data = JSON.parse(await readFile(report, "utf8")) as {
      streams: { time_base: string }[];
      packets: Packet[];
    };
    return JSON.stringify({
      timeBase: data.streams[0]?.time_base,
      packets: data.packets.map((p) => [p.pts, p.dts, p.duration]),
    });
  };
  const audioTimes = await audioTiming(sourcePath, "before");
  if (audioTimes !== (await audioTiming(path, "after")))
    throw Error("STUDIO_CLOSING_SPLICE_AUDIO_TIMING_CHANGED");
  return {
    path,
    ...plan,
    prefixSha256,
    timingSha256: createHash("sha256")
      .update(JSON.stringify(before.packets.map((p) => [p.pts, p.duration])))
      .digest("hex"),
  };
}

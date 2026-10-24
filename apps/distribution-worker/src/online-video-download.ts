import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ONLINE_IMPORT_PLAYLIST_LIMIT,
  type OnlineVideoSource,
  onlineVideoSource,
} from "@satsang/distribution-domain";
import { startOnlineVideoProxy } from "./online-video-network.js";

// Livestream archives may expose only DASH segments. yt-dlp's native downloader sends
// every segment through our pinned HTTPS proxy; FFmpeg only merges local files.
export const ONLINE_VIDEO_FORMAT =
  "b[ext=mp4][protocol=https][height<=1080]/bv[ext=mp4][protocol~='^(https|http_dash_segments)$'][height<=1080]+ba[ext=m4a][protocol~='^(https|http_dash_segments)$']";
// Long DASH manifests contain thousands of signed fragment URLs. Persist only the
// fields the importer needs, keeping metadata bounded independently of video length.
export const ONLINE_VIDEO_METADATA = "%(.{title,is_live,live_status,filesize,filesize_approx})j";

export function onlineDownloadFailure(stderr: string) {
  if (
    /confirm (?:you.re|that you.re) not a bot|unusual traffic|automated (?:queries|requests)|captcha/i.test(
      stderr,
    )
  )
    return "ONLINE_PROVIDER_VERIFICATION_REQUIRED";
  if (/HTTP (?:Error )?429|too many requests|rate.limit/i.test(stderr))
    return "ONLINE_PROVIDER_RATE_LIMITED";
  if (/playlist (?:does not exist|doesn't exist|not found|has been deleted)/i.test(stderr))
    return "ONLINE_PLAYLIST_NOT_FOUND";
  if (
    /private video|members.only|sign.in|login|not available in your country|age.restrict|confirm your age/i.test(
      stderr,
    )
  )
    return "ONLINE_SOURCE_RESTRICTED";
  if (/larger than|max.filesize|file is larger|too large/i.test(stderr))
    return "ONLINE_SOURCE_TOO_LARGE";
  if (/requested format is not available|no video formats found/i.test(stderr))
    return "ONLINE_SOURCE_FORMAT_UNSUPPORTED";
  return "ONLINE_SOURCE_UNAVAILABLE";
}
async function run(
  binary: string,
  args: string[],
  directory: string,
  signal: AbortSignal,
  maxBytes: number,
) {
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: directory,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: directory, LANG: "C.UTF-8", PYTHONUNBUFFERED: "1" },
    });
    let out = "";
    let err = "";
    let reason: string | undefined;
    let checking = false;
    const stop = (code: string) => {
      reason ??= code;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const abort = () =>
      stop(
        signal.reason?.name === "TimeoutError"
          ? "ONLINE_IMPORT_TIMEOUT"
          : "ONLINE_IMPORT_INTERRUPTED",
      );
    signal.addEventListener("abort", abort, { once: true });
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void readdir(directory)
        .then(async (names) => {
          let size = 0;
          for (const name of names) {
            const file = await stat(join(directory, name));
            size += file.size;
          }
          if (size > maxBytes * 3 + 8 * 1024 * 1024) stop("ONLINE_SOURCE_TOO_LARGE");
        })
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }, 1000);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      // yt-dlp reports a size skip on stdout and may exit successfully or continue
      // downloading audio. Stop before a missing video becomes a generic merge error.
      if (/(?:^|\n)\[download\] File is larger than max-filesize\b/.test(out))
        stop("ONLINE_SOURCE_TOO_LARGE");
      if (Buffer.byteLength(out) > 8 * 1024 * 1024) stop("ONLINE_PLAYLIST_TOO_LARGE");
    });
    child.stderr.on("data", (chunk) => {
      err = (err + chunk.toString()).slice(-16000);
    });
    child.on("error", () => {
      reason = "ONLINE_IMPORT_DISABLED";
    });
    child.on("close", (code) => {
      clearInterval(timer);
      signal.removeEventListener("abort", abort);
      if (reason || code !== 0) reject(Error(reason ?? onlineDownloadFailure(err)));
      else resolve(out);
    });
  });
}
export async function downloadOnlineVideo(input: {
  source: OnlineVideoSource;
  maxBytes: number;
  signal: AbortSignal;
  binary?: string | undefined;
  browserSession?: { cookies: string; userAgent: string } | undefined;
  save?: (file: { path: string; title: string; filename: string }) => Promise<void>;
}) {
  if (input.source.kind === "bundle") throw Error("UNSUPPORTED_VIDEO_LINK");
  const source = onlineVideoSource(input.source.url, input.source.kind === "playlist");
  const directory = await mkdtemp(join(tmpdir(), "sgs-online-import-"));
  const proxy = await startOnlineVideoProxy();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30 * 60 * 1000)]);
  const common = [
    "--ignore-config",
    "--no-plugin-dirs",
    "--no-remote-components",
    "--js-runtimes",
    `node:${process.execPath}`,
    "--no-cache-dir",
    "--no-progress",
    "--no-warnings",
    "--socket-timeout",
    "25",
    "--retries",
    "2",
    "--fragment-retries",
    "2",
    "--proxy",
    proxy.url,
  ];
  try {
    if (input.browserSession) {
      const cookieFile = join(directory, "session.cookies");
      await writeFile(cookieFile, input.browserSession.cookies, { mode: 0o600, flag: "wx" });
      common.push("--cookies", cookieFile, "--user-agent", input.browserSession.userAgent);
    }
    if (source.kind === "playlist") {
      const text = await run(
        input.binary ?? "yt-dlp",
        [
          ...common,
          "--flat-playlist",
          "--dump-single-json",
          "--playlist-end",
          String(ONLINE_IMPORT_PLAYLIST_LIMIT + 1),
          source.url,
        ],
        directory,
        signal,
        input.maxBytes,
      );
      const data = JSON.parse(text);
      if (
        !Array.isArray(data.entries) ||
        data.entries.length > ONLINE_IMPORT_PLAYLIST_LIMIT ||
        Number(data.playlist_count) > ONLINE_IMPORT_PLAYLIST_LIMIT
      )
        throw Error("ONLINE_PLAYLIST_TOO_LARGE");
      // Unavailable entries remain child imports with an explicit failure, never silently skipped.
      const entries = data.entries.map((entry: { id: string; title?: string }) => ({
        ...onlineVideoSource(`https://www.youtube.com/watch?v=${entry.id}`),
        ...(entry.title ? { title: entry.title.slice(0, 200) } : {}),
      }));
      return {
        kind: "playlist" as const,
        entries,
        title: String(data.title ?? "YouTube playlist").slice(0, 200),
      };
    }
    await run(
      input.binary ?? "yt-dlp",
      [
        ...common,
        "--no-playlist",
        "--match-filter",
        "!is_live",
        "--no-simulate",
        "--print-to-file",
        `after_move:${ONLINE_VIDEO_METADATA}`,
        join(directory, "master.metadata.json"),
        "--max-filesize",
        String(input.maxBytes),
        "--format",
        ONLINE_VIDEO_FORMAT,
        "--downloader",
        "dash:native",
        "--concurrent-fragments",
        "4",
        "--abort-on-unavailable-fragments",
        "--merge-output-format",
        "mp4",
        "--postprocessor-args",
        "ffmpeg_i:-protocol_whitelist file,pipe",
        "--output",
        join(directory, "master.%(ext)s"),
        source.url,
      ],
      directory,
      signal,
      input.maxBytes,
    );
    const path = join(directory, "master.mp4");
    const metadataPath = join(directory, "master.metadata.json");
    if ((await stat(metadataPath)).size > 8 * 1024 * 1024) throw Error("ONLINE_SOURCE_UNAVAILABLE");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw Error(
        Number(metadata.filesize ?? metadata.filesize_approx) > input.maxBytes
          ? "ONLINE_SOURCE_TOO_LARGE"
          : "ONLINE_SOURCE_UNAVAILABLE",
      );
    }
    if (size > input.maxBytes) throw Error("ONLINE_SOURCE_TOO_LARGE");
    if (metadata.is_live || metadata.live_status === "is_live")
      throw Error("ONLINE_SOURCE_UNAVAILABLE");
    const file = await open(path, "r");
    const signature = Buffer.alloc(12);
    try {
      await file.read(signature, 0, 12, 0);
    } finally {
      await file.close();
    }
    if (size < 12 || signature.subarray(4, 8).toString("ascii") !== "ftyp")
      throw Error("ONLINE_SOURCE_UNAVAILABLE");
    const video = {
      path,
      title: String(metadata.title ?? `${source.provider} ${source.id}`).slice(0, 200),
      filename: `${source.provider}-${source.id}-master.mp4`,
    };
    if (!input.save) throw Error("ONLINE_IMPORT_STORAGE_UNAVAILABLE");
    await input.save(video);
    return { kind: "video" as const };
  } finally {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
}

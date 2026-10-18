import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { liveMediaUrl } from "./live-hls";
import { onlineDownloadFailure } from "./online-video-download";
import { startOnlineVideoProxy } from "./online-video-network";
export type DiscoveredLiveVideo = { id: string; title: string; manifest: string };
/** Resolve only the configured channel, and require both muxed HLS and an active broadcast. */
export async function discoverLiveVideo(
  channelId: string,
  input: { binary: string; signal: AbortSignal; videoId?: string },
): Promise<DiscoveredLiveVideo | null> {
  if (
    !/^UC[A-Za-z0-9_-]{22}$/.test(channelId) ||
    (input.videoId && !/^[A-Za-z0-9_-]{11}$/.test(input.videoId))
  )
    throw Error("INVALID_LIVE_CURATION");
  const directory = await mkdtemp(join(tmpdir(), "sgs-live-discovery-"));
  const proxy = await startOnlineVideoProxy();
  try {
    const { stdout } = await promisify(execFile)(
      input.binary,
      [
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-remote-components",
        "--js-runtimes",
        `node:${process.execPath}`,
        "--no-cache-dir",
        "--no-playlist",
        "--no-warnings",
        "--socket-timeout",
        "20",
        "--retries",
        "1",
        "--proxy",
        proxy.url,
        "--skip-download",
        "--dump-single-json",
        input.videoId
          ? `https://www.youtube.com/watch?v=${input.videoId}`
          : `https://www.youtube.com/channel/${channelId}/live`,
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, HOME: directory, LANG: "C.UTF-8" },
        timeout: 90000,
        maxBuffer: 8 * 1024 * 1024,
        signal: input.signal,
      },
    );
    const info = JSON.parse(stdout);
    if (info.channel_id !== channelId) throw Error("LIVE_CHANNEL_MISMATCH");
    if (!info.is_live || info.live_status !== "is_live") return null;
    if (!/^[A-Za-z0-9_-]{11}$/.test(info.id)) throw Error("LIVE_STREAM_UNSUPPORTED");
    const formats = (info.formats ?? [])
      .filter(
        (f: {
          protocol?: string;
          vcodec?: string;
          acodec?: string;
          height?: number;
          url?: string;
        }) =>
          f.protocol === "m3u8_native" &&
          f.vcodec?.startsWith("avc1") &&
          f.acodec &&
          f.acodec !== "none" &&
          typeof f.height === "number" &&
          f.height <= 720 &&
          f.url,
      )
      .sort((a: { height: number }, b: { height: number }) => b.height - a.height);
    if (!formats[0]) throw Error("LIVE_STREAM_UNSUPPORTED");
    return {
      id: info.id,
      title: String(info.title ?? "Live broadcast").slice(0, 200),
      manifest: liveMediaUrl(formats[0].url).href,
    };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    if (stderr) {
      if (/not currently live|live event will begin|premiere will begin/i.test(stderr)) return null;
      throw Error(onlineDownloadFailure(stderr));
    }
    throw error;
  } finally {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
}

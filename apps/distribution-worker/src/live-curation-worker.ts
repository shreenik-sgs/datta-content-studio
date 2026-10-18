import { execFile } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import type { PrivateAssetStore, createLiveFragmentStore } from "@satsang/distribution-assets";
import {
  type LiveBroadcastRecord,
  type LiveMonitorClaim,
  type createLiveCurationRepository,
  readLiveCurationChannels,
} from "@satsang/distribution-db";
import { liveCurationWindow } from "@satsang/distribution-domain";
import { type DiscoveredLiveVideo, discoverLiveVideo } from "./live-discovery";
import { fetchLiveMedia, parseLiveHls } from "./live-hls";
import { executeStudioSource, validateStudioSourceDimensions } from "./studio-process";

type Input = {
  repository: ReturnType<typeof createLiveCurationRepository>;
  store: PrivateAssetStore;
  fragments: ReturnType<typeof createLiveFragmentStore>;
  env: NodeJS.ProcessEnv;
  isTest: boolean;
  signal: AbortSignal;
  onError?: (code: string) => void;
};
export async function assembleLiveWindow(
  input: Pick<Input, "store" | "fragments" | "env" | "signal">,
  record: LiveBroadcastRecord,
  ended: boolean,
  save: (asset: Awaited<ReturnType<PrivateAssetStore["write"]>>) => Promise<void>,
) {
  const window = liveCurationWindow(record.state.buffers, ended);
  if (!window) return false;
  const directory = await mkdtemp(join(tmpdir(), "sgs-live-window-"));
  let asset: Awaited<ReturnType<PrivateAssetStore["write"]>> | undefined;
  let committing = false;
  try {
    const source = join(directory, "source.ts");
    const output = join(directory, "master.mp4");
    const file = await open(source, "wx", 0o600);
    let size = 0;
    try {
      for (const fragment of record.state.buffers.slice(0, window.count)) {
        input.signal.throwIfAborted();
        const bytes = await input.fragments.read(fragment);
        size += bytes.length;
        if (size > 2 * 1024 * 1024 * 1024) throw Error("LIVE_BUFFER_FULL");
        await file.writeFile(bytes);
      }
    } finally {
      await file.close();
    }
    await executeStudioSource({
      executable: input.env.DISTRIBUTION_FFMPEG_PATH ?? "/usr/bin/ffmpeg",
      sourcePath: source,
      mimeType: "video/mp2t",
      directory,
      timeoutMs: 180000,
      signal: input.signal,
      args: [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-fflags",
        "+genpts",
        "-i",
        "__SOURCE__",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-avoid_negative_ts",
        "make_zero",
        "-movflags",
        "+faststart",
        output,
      ],
    });
    const raw = await executeStudioSource({
      executable: input.env.DISTRIBUTION_FFPROBE_PATH ?? "/usr/bin/ffprobe",
      sourcePath: output,
      mimeType: "video/mp4",
      directory,
      timeoutMs: 30000,
      signal: input.signal,
      args: ["-v", "error", "-show_streams", "-show_format", "-of", "json", "-i", "__SOURCE__"],
    });
    const media = JSON.parse(raw);
    validateStudioSourceDimensions(media.streams);
    const durationMs = Number(media.format?.duration) * 1000;
    if (
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      !media.streams.some((s: { codec_type?: string }) => s.codec_type === "audio") ||
      !media.streams.some((s: { codec_type?: string }) => s.codec_type === "video") ||
      Math.abs(durationMs - window.durationMs) > 2000
    )
      throw Error("LIVE_CAPTURE_GAP");
    if (!input.store.writeFile) throw Error("ONLINE_IMPORT_STORAGE_UNAVAILABLE");
    asset = await input.store.writeFile({
      path: output,
      mimeType: "video/mp4",
      originalName: `youtube-${record.videoId}-live-section-${record.state.windowNumber + 1}.mp4`,
    });
    input.signal.throwIfAborted();
    committing = true;
    await save(asset);
    return true;
  } finally {
    if (asset && !committing) await input.store.removeUnreferenced(asset).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
export function createLiveCurationRunner(
  input: Input,
  dependencies: {
    discover?: typeof discoverLiveVideo;
    fetchMedia?: typeof fetchLiveMedia;
    channels?: typeof readLiveCurationChannels;
  } = {},
) {
  const cached = new Map<string, { at: number; video: DiscoveredLiveVideo | null }>();
  const discover = dependencies.discover ?? discoverLiveVideo;
  const fetchMedia = dependencies.fetchMedia ?? fetchLiveMedia;
  const channels = dependencies.channels ?? readLiveCurationChannels;
  return async () => {
    const claim = await input.repository.claim(input.isTest);
    if (!claim) return false;
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    let busy = false;
    const heartbeat = setInterval(() => {
      if (busy) return;
      busy = true;
      void input.repository
        .renew(claim)
        .catch(() => controller.abort())
        .finally(() => {
          busy = false;
        });
    }, 30000);
    heartbeat.unref();
    let record: LiveBroadcastRecord | null = null;
    let lastManifest: string | undefined;
    try {
      await input.repository.renew(claim);
      const configured = await channels(input.env, {
        userId: claim.requestedBy,
        isTest: claim.isTest,
      });
      if (!configured.some((c) => c.channelId === claim.settings.channelId && c.enabled))
        throw Error("LIVE_CHANNEL_DISABLED");
      record = await input.repository.active(claim);
      let entry = cached.get(claim.id);
      if (
        !entry ||
        Date.now() - entry.at > 120000 ||
        (record && entry.video?.id !== record.videoId)
      ) {
        lastManifest = entry?.video?.manifest;
        const video = await discover(claim.settings.channelId, {
          binary: input.env.STUDIO_YTDLP_PATH ?? "yt-dlp",
          signal,
          ...(record ? { videoId: record.videoId } : {}),
        });
        entry = { at: Date.now(), video };
        cached.set(claim.id, entry);
      }
      let ended = !entry.video;
      if (!record && entry.video)
        record = await input.repository.begin(claim, {
          id: entry.video.id,
          title: entry.video.title,
          capturedFrom: null,
        });
      if (!record || record.status !== "CAPTURING") {
        await input.repository.release(claim);
        return true;
      }
      const manifestUrl = entry.video?.manifest ?? (record ? lastManifest : undefined);
      if (manifestUrl) {
        const manifest = parseLiveHls(
          (await fetchMedia(manifestUrl, 2 * 1024 * 1024, signal)).toString("utf8"),
          manifestUrl,
        );
        ended = ended || manifest.ended;
        const next = record.state.nextSequence;
        let available = manifest.segments.filter((s) => next === null || s.sequence >= next);
        if (next === null) {
          let duration = 0;
          let start = available.length;
          while (start > 0 && duration < 600000) {
            start--;
            duration += available[start]?.durationMs ?? 0;
          }
          available = available.slice(start);
        }
        if (next !== null && available.length && available[0]?.sequence !== next)
          throw Error("LIVE_CAPTURE_GAP");
        // Persist every bounded batch before advancing the cursor; a restart resumes saved sequence numbers.
        for (let offset = 0; offset < available.length; offset += 12) {
          const selected = available.slice(offset, offset + 12);
          const saved = [];
          for (let i = 0; i < selected.length; i += 4) {
            const group = selected.slice(i, i + 4);
            saved.push(
              ...(await Promise.all(
                group.map(async (segment) => {
                  const bytes = await fetchMedia(segment.url, 32 * 1024 * 1024, signal);
                  const asset = await input.fragments.write(
                    `distribution/live/${record?.id}/${segment.sequence}.ts`,
                    bytes,
                  );
                  return { ...asset, sequence: segment.sequence, durationMs: segment.durationMs };
                }),
              )),
            );
          }
          record = await input.repository.append(
            claim,
            record.id,
            saved,
            selected[0]?.programAt ?? new Date().toISOString(),
          );
          record = await flush(input, claim, record, false, signal);
        }
      }
      if (ended) {
        record = await flush(input, claim, record, true, signal);
        await input.repository.end(claim, record.id);
        cached.delete(claim.id);
      }
      await input.repository.release(claim);
    } catch (error) {
      cached.delete(claim.id);
      const code = error instanceof Error ? error.message : "LIVE_CAPTURE_UNAVAILABLE";
      if (code !== "LIVE_LEASE_LOST" && !signal.aborted)
        await input.repository.release(claim, code, record?.id).catch(() => undefined);
      input.onError?.(/^[A-Z_]{1,80}$/.test(code) ? code : "LIVE_CAPTURE_UNAVAILABLE");
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  };
}
async function flush(
  input: Input,
  claim: LiveMonitorClaim,
  initial: LiveBroadcastRecord,
  ended: boolean,
  signal: AbortSignal,
) {
  let record = initial;
  while (liveCurationWindow(record.state.buffers, ended)) {
    await assembleLiveWindow({ ...input, signal }, record, ended, async (asset) => {
      const result = await input.repository.saveWindow(claim, record.id, {
        asset,
        ended,
        expectedNumber: record.state.windowNumber,
      });
      record = result.broadcast;
      // Durable source/master and cursor commit happened first. Only no-longer-needed raw buffers are removed.
      for (const fragment of result.consumed)
        await input.fragments.remove(fragment).catch(() => undefined);
    });
  }
  return record;
}
export async function runLiveCurationLoop(input: Input) {
  for (const [binary, arg] of [
    [input.env.STUDIO_YTDLP_PATH ?? "yt-dlp", "--version"],
    [input.env.DISTRIBUTION_FFMPEG_PATH ?? "/usr/bin/ffmpeg", "-version"],
    [input.env.DISTRIBUTION_FFPROBE_PATH ?? "/usr/bin/ffprobe", "-version"],
  ] as const) {
    try {
      await promisify(execFile)(binary, [arg], { timeout: 10000 });
    } catch {
      input.onError?.("LIVE_MONITOR_UNAVAILABLE");
      return;
    }
  }
  await input.repository.heartbeat(input.isTest);
  let beating = false;
  const heartbeat = setInterval(() => {
    if (beating) return;
    beating = true;
    void input.repository
      .heartbeat(input.isTest)
      .catch(() => undefined)
      .finally(() => {
        beating = false;
      });
  }, 30000);
  heartbeat.unref();
  const run = createLiveCurationRunner(input);
  async function capture() {
    while (!input.signal.aborted) {
      try {
        await run();
      } catch {
        input.onError?.("LIVE_CAPTURE_UNAVAILABLE");
      }
      try {
        await pause(2000, undefined, { signal: input.signal });
      } catch {
        break;
      }
    }
  }
  try {
    // A slow channel's discovery must not let the other channel's live window expire.
    await Promise.all([capture(), capture()]);
  } finally {
    clearInterval(heartbeat);
  }
}

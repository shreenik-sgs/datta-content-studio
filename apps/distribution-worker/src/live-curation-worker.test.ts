import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveFragmentStore, createPrivateAssetStore } from "@satsang/distribution-assets";
import type {
  LiveBroadcastRecord,
  LiveMonitorClaim,
  createLiveCurationRepository,
} from "@satsang/distribution-db";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assembleLiveWindow, createLiveCurationRunner } from "./live-curation-worker";
const ffmpeg = existsSync("/opt/homebrew/bin/ffmpeg")
  ? "/opt/homebrew/bin/ffmpeg"
  : "/usr/bin/ffmpeg";
const ffprobe = existsSync("/opt/homebrew/bin/ffprobe")
  ? "/opt/homebrew/bin/ffprobe"
  : "/usr/bin/ffprobe";
let root: string;
let first: Buffer;
let second: Buffer;
beforeAll(async () => {
  root = await mkdtemp(join(realpathSync(tmpdir()), "live-worker-fixture-"));
  execFileSync(
    ffmpeg,
    [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=25",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=400:sample_rate=48000",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-g",
      "50",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_playlist_type",
      "vod",
      join(root, "source.m3u8"),
    ],
    { timeout: 15000 },
  );
  first = await readFile(join(root, "source0.ts"));
  second = await readFile(join(root, "source1.ts"));
}, 20000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const initial = (): LiveBroadcastRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  videoId: "abcdefghijk",
  title: "Fixture live broadcast",
  status: "CAPTURING",
  state: {
    nextSequence: null,
    buffers: [],
    offsetMs: 0,
    capturedMs: 0,
    windowNumber: 0,
    capturedFrom: null,
  },
});
const env = { DISTRIBUTION_FFMPEG_PATH: ffmpeg, DISTRIBUTION_FFPROBE_PATH: ffprobe };
it("captures once, resumes after a worker restart, and remuxes complete original audio/video on end", async () => {
  const directory = await mkdtemp(join(root, "capture-"));
  const fragments = createLiveFragmentStore({ backend: "local", root: directory });
  const store = createPrivateAssetStore(directory);
  let record = initial();
  let finalAsset: unknown;
  let ended = false;
  const claim = {
    id: "monitor",
    isTest: true,
    revision: 1,
    requestedBy: "curator",
    settings: { channelId: `UC${"a".repeat(22)}` },
    leaseToken: "lease",
  } as LiveMonitorClaim;
  const repo = {
    claim: vi.fn(async () => claim),
    renew: vi.fn(async () => {}),
    active: vi.fn(async () => record),
    begin: vi.fn(),
    append: vi.fn(async (_claim, _id, items, at) => {
      record = {
        ...record,
        state: {
          ...record.state,
          nextSequence: items.at(-1).sequence + 1,
          buffers: [...record.state.buffers, ...items],
          capturedMs:
            record.state.capturedMs +
            items.reduce((n: number, f: { durationMs: number }) => n + f.durationMs, 0),
          capturedFrom: at,
        },
      };
      return record;
    }),
    saveWindow: vi.fn(async (_claim, _id, { asset }) => {
      finalAsset = asset;
      const consumed = record.state.buffers;
      record = {
        ...record,
        state: { ...record.state, buffers: [], offsetMs: 4000, windowNumber: 1 },
      };
      return { broadcast: record, consumed, windowId: "window" };
    }),
    end: vi.fn(async () => {
      ended = true;
    }),
    release: vi.fn(async () => {}),
  };
  const input = {
    repository: repo as unknown as ReturnType<typeof createLiveCurationRepository>,
    store,
    fragments,
    env,
    isTest: true,
    signal: new AbortController().signal,
    onError: vi.fn(),
  };
  let end = false;
  const fetched: string[] = [];
  const dependencies = {
    channels: async () => [
      { channelId: claim.settings.channelId, name: "Fixture", handle: null, enabled: true },
    ],
    discover: async () => ({
      id: record.videoId,
      title: record.title,
      manifest: "https://manifest.googlevideo.com/index.m3u8",
    }),
    fetchMedia: async (url: string) => {
      fetched.push(url);
      if (url.endsWith("m3u8"))
        return Buffer.from(
          `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n${end ? "#EXT-X-ENDLIST" : ""}`,
        );
      return url.endsWith("a.ts") ? first : second;
    },
  };
  await createLiveCurationRunner(input, dependencies)();
  expect(record.state.nextSequence).toBe(102);
  expect(repo.append).toHaveBeenCalledTimes(1);
  expect(repo.saveWindow).not.toHaveBeenCalled();
  end = true;
  await createLiveCurationRunner(input, dependencies)();
  expect(input.onError).not.toHaveBeenCalled();
  expect(repo.append).toHaveBeenCalledTimes(1);
  expect(repo.saveWindow).toHaveBeenCalledTimes(1);
  expect(ended).toBe(true);
  expect(fetched.filter((url) => url.endsWith(".ts"))).toHaveLength(2);
  const asset = finalAsset as { storageKey: string };
  const probe = JSON.parse(
    execFileSync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        join(directory, asset.storageKey),
      ],
      { encoding: "utf8" },
    ),
  );
  expect(probe.streams.map((s: { codec_type: string }) => s.codec_type).sort()).toEqual([
    "audio",
    "video",
  ]);
  expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(4);
  expect(Number(probe.format.duration)).toBeLessThan(4.2);
}, 30000);
it("never stores a master from mismatched timing or missing media", async () => {
  const directory = await mkdtemp(join(root, "invalid-"));
  const fragments = createLiveFragmentStore({ backend: "local", root: directory });
  const record = initial();
  const asset = await fragments.write(`distribution/live/${record.id}/1.ts`, first);
  record.state.buffers = [{ ...asset, sequence: 1, durationMs: 20000 }];
  const save = vi.fn();
  await expect(
    assembleLiveWindow(
      {
        store: createPrivateAssetStore(directory),
        fragments,
        env,
        signal: new AbortController().signal,
      },
      record,
      true,
      save,
    ),
  ).rejects.toThrow("LIVE_CAPTURE_GAP");
  expect(save).not.toHaveBeenCalled();
}, 30000);

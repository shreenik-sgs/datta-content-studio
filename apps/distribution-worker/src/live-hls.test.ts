import { describe, expect, it } from "vitest";
import { liveMediaUrl, parseLiveHls } from "./live-hls";
const base = "https://manifest.googlevideo.com/live/index.m3u8";
const manifest = (extra = "") =>
  `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:41\n#EXT-X-PROGRAM-DATE-TIME:2026-10-14T12:00:00Z\n${extra}#EXTINF:2.002,\nsegment41.ts\n#EXTINF:3,\nhttps://r1.googlevideo.com/segment42.ts\n#EXT-X-ENDLIST\n`;
describe("live HLS ingestion", () => {
  it("preserves sequence, timing and the final marker", () => {
    expect(parseLiveHls(manifest(), base)).toEqual({
      ended: true,
      segments: [
        {
          sequence: 41,
          durationMs: 2002,
          url: "https://manifest.googlevideo.com/live/segment41.ts",
          programAt: "2026-10-14T12:00:00.000Z",
        },
        {
          sequence: 42,
          durationMs: 3000,
          url: "https://r1.googlevideo.com/segment42.ts",
          programAt: "2026-10-14T12:00:02.002Z",
        },
      ],
    });
  });
  it.each([
    "http://r1.googlevideo.com/a",
    "https://googlevideo.com.attacker.test/a",
    "https://127.0.0.1/a",
    "file:///tmp/a",
    "https://user@r1.googlevideo.com/a",
    "https://r1.googlevideo.com:444/a",
  ])("rejects unsafe media URL %s", (url) => {
    expect(() => liveMediaUrl(url)).toThrow();
    expect(() => parseLiveHls(manifest().replace("segment41.ts", url), base)).toThrow();
  });
  it.each(["#EXT-X-DISCONTINUITY\n", "#EXT-X-GAP\n"])(
    "never concatenates a discontinuity: %s",
    (line) => expect(() => parseLiveHls(manifest(line), base)).toThrow("LIVE_CAPTURE_GAP"),
  );
  it.each([
    '#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key"\n',
    '#EXT-X-MAP:URI="init.mp4"\n',
    "#EXT-X-BYTERANGE:1024\n",
    "#EXT-X-STREAM-INF:BANDWIDTH=10000\n",
  ])("rejects unsupported playlist instructions: %s", (line) =>
    expect(() => parseLiveHls(manifest(line), base)).toThrow("LIVE_STREAM_UNSUPPORTED"),
  );
  it("rejects malformed duration and overflowing cursors", () => {
    for (const value of ["NaN", "0", "-2", "31"])
      expect(() => parseLiveHls(manifest().replace("2.002", value), base)).toThrow();
    expect(() =>
      parseLiveHls(manifest().replace("SEQUENCE:41", "SEQUENCE:9007199254740991"), base),
    ).toThrow();
    expect(() => parseLiveHls("#EXTM3U\n#EXTINF:2,", base)).toThrow();
  });
});

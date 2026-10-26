import { expect, it } from "vitest";
import {
  type ClosingSpliceMetadata,
  planClosingSplice,
  validateClosingSpliceTimeline,
} from "./studio-closing-splice";

const metadata = (): ClosingSpliceMetadata => ({
  streams: [
    {
      codec_name: "h264",
      profile: "High",
      level: 40,
      width: 1080,
      height: 1920,
      pix_fmt: "yuv420p",
      time_base: "1/15360",
      extradata_hash: `SHA256:${"a".repeat(64)}`,
    },
  ],
  packets: Array.from({ length: 900 }, (_, i) => ({
    pts: i * 512,
    dts: (i - 2) * 512,
    duration: 512,
    flags: i % 60 === 0 ? "K_" : "__",
  })),
});

it("copies the body through the preceding keyframe, encoding only the ending", () => {
  expect(planClosingSplice(metadata(), 25001)).toEqual({
    timeScale: 15360,
    splitSeconds: 24,
    copiedPackets: 720,
    encodedPackets: 180,
    totalPackets: 900,
  });
});
it("accepts reordered B-frame presentation times without changing decode order", () => {
  const data = metadata();
  const a = data.packets[1];
  const b = data.packets[2];
  if (!a || !b) throw Error("fixture missing");
  [a.pts, b.pts] = [b.pts, a.pts];
  expect(planClosingSplice(data, 25001).copiedPackets).toBe(720);
});
it.each(["codec", "timing", "size", "header", "boundary"])(
  "fails closed for unsupported %s",
  (change) => {
    const data = metadata();
    const stream = data.streams[0];
    const packet = data.packets[20];
    if (!stream || !packet) throw Error("fixture missing");
    if (change === "codec") stream.codec_name = "hevc";
    if (change === "timing") packet.duration++;
    if (change === "size") stream.width = 40000;
    if (change === "header") stream.extradata_hash = "";
    if (change === "boundary") for (const packet of data.packets) packet.flags = "__";
    expect(() => planClosingSplice(data, 25001)).toThrow(/STUDIO_CLOSING_SPLICE/);
  },
);
it("handles a short clip whose closing begins before its second keyframe", () => {
  expect(planClosingSplice(metadata(), 1000).copiedPackets).toBe(0);
});

it("accepts a new B-frame encoding order only in the ending", () => {
  const before = metadata();
  const after = metadata();
  const a = after.packets[721];
  const b = after.packets[722];
  if (!a || !b) throw Error("fixture missing");
  [a.pts, b.pts] = [b.pts, a.pts];
  expect(() => validateClosingSpliceTimeline(before, after, 720)).not.toThrow();
  expect(() => validateClosingSpliceTimeline(before, after, 740)).toThrow(
    "STUDIO_CLOSING_SPLICE_TIMING_CHANGED",
  );
});
it("rejects a lost, duplicate or shifted frame at the join", () => {
  for (const change of ["lost", "duplicate", "shift"]) {
    const before = metadata();
    const after = metadata();
    const packet = after.packets[720];
    if (!packet) throw Error("fixture missing");
    if (change === "lost") after.packets.pop();
    if (change === "duplicate") packet.pts += 512;
    if (change === "shift") for (const p of after.packets) p.pts += 512;
    expect(() => validateClosingSpliceTimeline(before, after, 720)).toThrow(
      "STUDIO_CLOSING_SPLICE_TIMING_CHANGED",
    );
  }
});

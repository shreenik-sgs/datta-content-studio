import { STUDIO_SUBTITLE_TOP } from "@satsang/distribution-domain";
import sharp from "sharp";
import { expect, it } from "vitest";
import { studioClosingCard, studioOpeningCard } from "./studio-ending";
it.each(["plum", "forest", "dawn"] as const)(
  "keeps long opening titles out of the live caption band (%s)",
  async (style) => {
    const logo = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    for (const title of [
      "Daily Practice of the Raksha Mantra | Sri Swamiji",
      "The complete teaching on daily spiritual practice, compassion, wisdom and service under the guidance of Sri Swamiji for every devotee beginning a sincere and meaningful journey toward inner peace",
    ]) {
      const card = await studioOpeningCard(logo, title, style);
      const band = await sharp(
        await sharp(card)
          .extract({ left: 64, top: STUDIO_SUBTITLE_TOP - 24, width: 884, height: 360 })
          .png()
          .toBuffer(),
      ).stats();
      // Any white/gold title pixels in this region would collide with captions.
      expect(band.channels.slice(0, 3).every((channel) => channel.max < 100)).toBe(true);
    }
  },
);
it("uses the supplied portrait and leaves the bottom subtitle band clear", async () => {
  const logo = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();
  const card = await studioClosingCard(logo);
  expect(await sharp(card).metadata()).toMatchObject({ width: 1080, height: 1920 });
  const lower = await sharp(
    await sharp(card)
      .extract({ left: 64, top: STUDIO_SUBTITLE_TOP, width: 884, height: 200 })
      .png()
      .toBuffer(),
  ).stats();
  expect(lower.channels.slice(0, 3).every((c) => c.stdev < 4)).toBe(true);
});

it("holds one opening picture then reveals the portrait with full speech and captions", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { studioOpeningCardPlan } = await import("@satsang/distribution-domain");
  const { renderStudioVideo } = await import("./studio-media");
  const { studioOpeningCard } = await import("./studio-ending");
  const ffmpeg =
    process.env.DISTRIBUTION_TEST_FFMPEG ??
    (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
  const dir = await mkdtemp(join(realpathSync(tmpdir()), "studio-opening-"));
  try {
    const source = join(dir, "source.mp4");
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x180:r=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "6",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-c:a",
      "aac",
      source,
    ]);
    const logo = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    const card = await studioOpeningCard(
      logo,
      "Every Single Verse of Bhagavad Gita Holds Divine Power",
    );
    const scenes = [{ startMs: 2000, endMs: 6000, bodyTop: 0, bodyBottom: 1 }];
    const plan = studioOpeningCardPlan(6000, scenes);
    if (!plan) throw Error("Missing opening plan");
    const backdrop = await sharp({
      create: { width: 1080, height: 1920, channels: 4, background: "#00000000" },
    })
      .png()
      .toBuffer();
    const output = await renderStudioVideo({
      ffmpeg,
      directory: dir,
      sourcePath: source,
      mimeType: "video/mp4",
      backdrop,
      hasVideo: true,
      hasAudio: true,
      sourceWidth: 320,
      sourceHeight: 180,
      scenes,
      openingCard: { bytes: card, plan },
      startMs: 0,
      endMs: 6000,
      captions: [
        { id: "one", text: "The full opening words remain audible.", startMs: 0, endMs: 6000 },
      ],
    });
    const frame = (time: string) =>
      execFileSync(
        ffmpeg,
        [
          "-v",
          "error",
          "-ss",
          time,
          "-i",
          output,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ],
        { maxBuffer: 10_000_000 },
      );
    const pixel = async (time: string) =>
      sharp(frame(time))
        .extract({ left: 15, top: 800, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer();
    const first = await pixel("0.25");
    const before = await pixel("1.75");
    const after = await pixel("2.65");
    expect(Math.abs((first[0] ?? 0) - (before[0] ?? 0))).toBeLessThan(3);
    expect(first[0]).toBeLessThan(60);
    expect(after[0]).toBeGreaterThan(220);
    const captionBand = await sharp(
      await sharp(frame("0.25"))
        .extract({ left: 64, top: STUDIO_SUBTITLE_TOP, width: 884, height: 120 })
        .png()
        .toBuffer(),
    ).stats();
    expect(captionBand.channels[0]?.max).toBeGreaterThan(200);
    for (const start of ["0", "5.7"]) {
      const audio = execFileSync(ffmpeg, [
        "-v",
        "error",
        "-ss",
        start,
        "-i",
        output,
        "-t",
        "0.25",
        "-vn",
        "-f",
        "s16le",
        "pipe:1",
      ]);
      expect(audio.length).toBeGreaterThan(20000);
      expect(audio.some((b) => b !== 0)).toBe(true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);

it.each([24, 30])(
  "keeps a caption-free closing hold after a %i fps source reaches EOF",
  async (rate) => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { existsSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { studioClosingCardPlan } = await import("@satsang/distribution-domain");
    const { renderStudioVideo } = await import("./studio-media");
    const ffmpeg =
      process.env.DISTRIBUTION_TEST_FFMPEG ??
      (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
    const ffprobe =
      process.env.DISTRIBUTION_TEST_FFPROBE ??
      (existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "/usr/bin/ffprobe");
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "studio-eof-hold-"));
    try {
      const source = join(dir, "source.mp4");
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=s=320x180:r=${rate}`,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "4",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-c:a",
        "aac",
        source,
      ]);
      const logo = await sharp({
        create: { width: 50, height: 50, channels: 3, background: "#fff" },
      })
        .png()
        .toBuffer();
      const card = await studioClosingCard(logo);
      const backdrop = await sharp({
        create: { width: 1080, height: 1920, channels: 4, background: "#00000000" },
      })
        .png()
        .toBuffer();
      const output = await renderStudioVideo({
        ffmpeg,
        directory: dir,
        sourcePath: source,
        mimeType: "video/mp4",
        backdrop,
        hasVideo: true,
        hasAudio: true,
        sourceWidth: 320,
        sourceHeight: 180,
        startMs: 0,
        endMs: 4000,
        closingCard: { bytes: card, plan: studioClosingCardPlan(4000) },
        captions: [
          { id: "last", text: "The final spoken words remain complete.", startMs: 0, endMs: 4000 },
        ],
      });
      const metadata = JSON.parse(
        execFileSync(ffprobe, ["-v", "error", "-show_streams", "-of", "json", output], {
          encoding: "utf8",
        }),
      );
      const video = metadata.streams.find((s: { codec_type: string }) => s.codec_type === "video");
      expect(Number(video.duration)).toBeCloseTo(7, 1); // Check actual video, not container/audio duration.
      const tail = execFileSync(
        ffmpeg,
        [
          "-v",
          "error",
          "-ss",
          "6.5",
          "-i",
          output,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ],
        { maxBuffer: 10_000_000 },
      );
      const actual = await sharp(tail).removeAlpha().raw().toBuffer();
      const expected = await sharp(card).removeAlpha().raw().toBuffer();
      expect(actual.length).toBe(expected.length);
      const error =
        actual.reduce((sum, value, i) => sum + Math.abs(value - (expected[i] ?? 0)), 0) /
        actual.length;
      expect(error).toBeLessThan(3); // A complete closing image with no remaining caption pixels.
      const speech = execFileSync(ffmpeg, [
        "-v",
        "error",
        "-ss",
        "3.7",
        "-i",
        output,
        "-t",
        "0.2",
        "-vn",
        "-f",
        "s16le",
        "pipe:1",
      ]);
      expect(speech.length).toBeGreaterThan(10000);
      expect(speech.some((value) => value !== 0)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);

it.each(["Gurubhavana ADPT", "A long authorized teaching channel name that wraps into two lines"])(
  "fits a custom closing name above the captions: %s",
  async (label) => {
    const logo = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    const target = { label, url: "https://www.youtube.com/@gurubhavanaadpt" };
    const card = await studioClosingCard(logo, "plum", "youtube", target);
    expect(await sharp(card).metadata()).toMatchObject({ width: 1080, height: 1920 });
    const lower = await sharp(
      await sharp(card)
        .extract({ left: 64, top: STUDIO_SUBTITLE_TOP, width: 884, height: 200 })
        .png()
        .toBuffer(),
    ).stats();
    expect(lower.channels.slice(0, 3).every((channel) => channel.stdev < 4)).toBe(true);
    const labelBand = await sharp(card)
      .extract({ left: 140, top: 1240, width: 720, height: 72 })
      .stats();
    expect(labelBand.channels[0]?.max).toBeGreaterThan(180);
  },
);

it("uses the authentic Bala portrait with the same green closing card for every prior style", async () => {
  const cards = await Promise.all(
    (["plum", "forest", "dawn"] as const).map((style) =>
      studioClosingCard(Buffer.alloc(0), style, "youtube", undefined, "bala-swamiji"),
    ),
  );
  expect(cards[0]).toEqual(cards[1]);
  expect(cards[1]).toEqual(cards[2]);
  expect(await sharp(cards[0]).metadata()).toMatchObject({ width: 1080, height: 1920 });
  await expect(
    studioClosingCard(Buffer.from("not-an-image"), "forest", "youtube", undefined, "bala-swamiji"),
  ).rejects.toThrow();
  // Four real image renders can exceed the default five seconds on a cold CI font cache.
}, 30000);

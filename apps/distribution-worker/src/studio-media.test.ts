import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  STUDIO_CAPTION_TOP,
  STUDIO_VIDEO_FRAME,
  studioArtwork,
  studioCaptionImage,
  studioCaptionLines,
  studioCaptionPages,
  studioIllustrationFrame,
  studioVideoThumbnail,
  studioVtt,
} from "./studio-media";

const graphemes = (text: string) =>
  Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (part) => part.segment,
  );

function expectWholeWords(parts: string[]) {
  for (let i = 1; i < parts.length; i++) {
    expect(/\s$/u.test(parts[i - 1] ?? "") || /^\s/u.test(parts[i] ?? "")).toBe(true);
  }
}

describe("studio caption layout", () => {
  it("wraps English captions at whole words instead of breaking every 24 graphemes", () => {
    const text =
      "Devotion invites us to examine our intentions and to practise kindness every day.";
    const lines = studioCaptionLines(text);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(text);
    expectWholeWords(lines);
    expect(lines.every((line) => graphemes(line).length <= 24)).toBe(true);
  });

  it("paginates at three complete lines without splitting an ordinary word between pages", () => {
    const text =
      "Reflect on the teaching with patience and bring kindness into everyday choices. ".repeat(18);
    const pages = studioCaptionPages([{ id: "en", startMs: 1207, endMs: 31210, text }]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.text).join("")).toBe(text);
    expectWholeWords(pages.map((page) => page.text));
    expect(pages[0]?.startMs).toBe(1207);
    expect(pages.at(-1)?.endMs).toBe(31210);
    for (const [index, page] of pages.entries()) {
      const lines = studioCaptionLines(page.text);
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(lines.every((line) => graphemes(line).length <= 24)).toBe(true);
      expectWholeWords(lines);
      expect(page.endMs).toBeGreaterThan(page.startMs);
      if (index > 0) expect(page.startMs).toBe(pages[index - 1]?.endMs);
    }
  });

  it("retains repeated whitespace and punctuation through line and page boundaries", () => {
    const text = "  Peace,  patience & kindness.\n\tA reflection <for everyone>.\r\n".repeat(20);
    const pages = studioCaptionPages([{ id: "spacing", startMs: 0, endMs: 10000, text }]);
    expect(pages.flatMap((page) => studioCaptionLines(page.text)).join("")).toBe(text);
  });

  it("keeps Indic conjuncts, combining marks and emoji clusters intact when a token is long", () => {
    const text = "క్షి".repeat(90) + "నమస్తే 👨‍👩‍👧‍👦 e\u0301 ".repeat(70);
    const pages = studioCaptionPages([{ id: "native", startMs: 500, endMs: 15000, text }]);
    const lines = pages.flatMap((page) => studioCaptionLines(page.text));
    expect(lines.flatMap(graphemes)).toEqual(graphemes(text));
    expect(lines.join("")).toBe(text);
    expect(lines.every((line) => graphemes(line).length <= 24)).toBe(true);
  });

  it("splits an oversized unbroken token at grapheme boundaries with no ellipsis or loss", () => {
    const text = "a".repeat(600);
    const pages = studioCaptionPages([{ id: "token", startMs: 0, endMs: 1000, text }]);
    expect(pages.map((page) => page.text.length)).toEqual([72, 72, 72, 72, 72, 72, 72, 72, 24]);
    expect(pages.map((page) => page.text).join("")).toBe(text);
    expect(
      pages.flatMap((page) => studioCaptionLines(page.text)).every((s) => s.length <= 24),
    ).toBe(true);
  });

  it("preserves separate cue endpoints and the silence between them", () => {
    const segments = [
      { id: "one", startMs: 321, endMs: 5000, text: "First teaching. ".repeat(100) },
      { id: "two", startMs: 7000, endMs: 12345, text: "Second teaching. ".repeat(100) },
    ];
    const pages = studioCaptionPages(segments);
    for (const segment of segments) {
      const ownPages = pages.filter((page) => page.id.startsWith(`${segment.id}-p`));
      expect(ownPages[0]?.startMs).toBe(segment.startMs);
      expect(ownPages.at(-1)?.endMs).toBe(segment.endMs);
      expect(ownPages.map((page) => page.text).join("")).toBe(segment.text);
    }
  });

  it("retains an empty cue and rejects timings too short to allocate a positive page duration", () => {
    expect(studioCaptionPages([{ id: "empty", startMs: 12, endMs: 34, text: "" }])).toEqual([
      { id: "empty-p1", startMs: 12, endMs: 34, text: "" },
    ]);
    expect(() =>
      studioCaptionPages([{ id: "short", startMs: 0, endMs: 1, text: "a".repeat(257) }]),
    ).toThrow("STUDIO_CAPTION_BOUNDARY_INVALID");
  });
});

describe("publication video artwork", () => {
  it("keeps summaries out of video pixels while retaining them on post artwork", async () => {
    const logo = await sharp({
      create: { width: 8, height: 8, channels: 4, background: "#b63358" },
    })
      .png()
      .toBuffer();
    const input = { logo, title: "Practice kindness", language: "en" };
    const video = await studioArtwork({ ...input, format: "video", body: "First reflection" });
    const otherVideo = await studioArtwork({
      ...input,
      format: "video",
      body: "Different reflection",
      title: "Different title",
    });
    expect(video.equals(otherVideo)).toBe(true);
    expect((await sharp(video).stats()).channels[3]?.max).toBe(0);
    expect(await sharp(video).metadata()).toMatchObject({ width: 1080, height: 1920 });
    const post = await studioArtwork({ ...input, format: "post", body: "First reflection" });
    const otherPost = await studioArtwork({
      ...input,
      format: "post",
      body: "Different reflection",
    });
    expect(post.equals(otherPost)).toBe(false);
    const framed = { ...input, sourceFrame: logo, format: "post" as const };
    const picturePost = await studioArtwork({ ...framed, body: "First reflection" });
    const otherPicturePost = await studioArtwork({ ...framed, body: "Different reflection" });
    expect(picturePost.equals(otherPicturePost)).toBe(true);
    // Static artwork leaves subtitle pixels to the timed layer, immediately below the picture.
    const lower = await sharp(
      await sharp(video).extract({ left: 64, top: 1671, width: 884, height: 249 }).png().toBuffer(),
    ).stats();
    expect(lower.channels.slice(0, 3).every((channel) => channel.stdev === 0)).toBe(true);
  });

  it("puts the title on a separate portrait thumbnail", async () => {
    const picture = await sharp({
      create: { width: 160, height: 90, channels: 3, background: "#835236" },
    })
      .png()
      .toBuffer();
    const first = await studioVideoThumbnail(picture, "Practice kindness");
    const second = await studioVideoThumbnail(picture, "Find peace");
    expect(await sharp(first).metadata()).toMatchObject({ width: 1080, height: 1920 });
    expect(first.equals(second)).toBe(false);
    const top = (b: Buffer) =>
      sharp(b).extract({ left: 0, top: 0, width: 1080, height: 1300 }).raw().toBuffer();
    expect((await top(first)).equals(await top(second))).toBe(true);
  });

  it("renders large subtitles during speech and no empty panel during silence", async () => {
    const spoken = await studioCaptionImage("Practice kindness.");
    const silent = await studioCaptionImage("");
    const alpha = async (
      image: Buffer,
      region: { left: number; top: number; width: number; height: number },
    ) => (await sharp(await sharp(image).extract(region).png().toBuffer()).stats()).channels[3];
    expect(
      (await alpha(spoken, { left: 68, top: STUDIO_CAPTION_TOP + 20, width: 12, height: 40 }))
        ?.mean,
    ).toBeGreaterThan(150);
    expect(
      (
        await alpha(spoken, {
          left: STUDIO_VIDEO_FRAME.x,
          top: STUDIO_VIDEO_FRAME.y,
          width: STUDIO_VIDEO_FRAME.width,
          height: STUDIO_VIDEO_FRAME.height,
        })
      )?.max,
    ).toBe(0);
    expect(STUDIO_CAPTION_TOP - (STUDIO_VIDEO_FRAME.y + STUDIO_VIDEO_FRAME.height)).toBe(12);
    // Right-hand reaction controls and bottom captions/navigation stay clear.
    expect((await alpha(spoken, { left: 960, top: 460, width: 120, height: 1460 }))?.max).toBe(0);
    const twoLines = await studioCaptionImage(
      "Practice kindness and bring care into your everyday choices.",
    );
    expect((await alpha(twoLines, { left: 0, top: 1820, width: 1080, height: 100 }))?.max).toBe(0);
    expect((await sharp(silent).stats()).channels[3]?.max).toBe(0);
    await expect(studioCaptionImage("word ".repeat(100))).rejects.toThrow(
      "STUDIO_CAPTION_PAGE_TOO_LONG",
    );
  });

  it("uses identical readable page boundaries for closed captions and burned captions", () => {
    const segment = {
      id: "native",
      startMs: 1000,
      endMs: 15000,
      text: "తెలుగు పరీక్ష నమూనా ".repeat(30),
    };
    const pages = studioCaptionPages([segment]);
    const vtt = studioVtt([segment], 500, 16000);
    expect(vtt.match(/ --> /gu)).toHaveLength(pages.length);
    expect(vtt).toContain("00:00:00.500 -->");
    expect(vtt).toContain("--> 00:00:14.500");
    for (const page of pages) expect(vtt).toContain(page.text);
  });

  it("centers larger caption glyphs within the safe caption band", async () => {
    const { data, info } = await sharp(await studioCaptionImage("Meaning and practice."))
      .raw()
      .toBuffer({ resolveWithObject: true });
    let left = info.width;
    let right = -1;
    let top = info.height;
    let bottom = -1;
    for (let y = STUDIO_CAPTION_TOP; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const offset = (y * info.width + x) * info.channels;
        if (
          (data[offset] ?? 0) > 230 &&
          (data[offset + 1] ?? 0) > 230 &&
          (data[offset + 2] ?? 0) > 230 &&
          (data[offset + 3] ?? 0) > 230
        ) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    expect(Math.abs((left + right) / 2 - 506)).toBeLessThan(3);
    expect(bottom - top).toBeGreaterThanOrEqual(55);
    expect(top).toBeGreaterThan(STUDIO_CAPTION_TOP);
    expect(bottom).toBeLessThan(1820);
  });

  it("allocates a shorter duration to a short final page without moving the source boundaries", () => {
    const pages = studioCaptionPages([
      { id: "timing", startMs: 100, endMs: 6100, text: "a".repeat(74) },
    ]);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.startMs).toBe(100);
    expect(pages.at(-1)?.endMs).toBe(6100);
    expect((pages[1]?.endMs ?? 0) - (pages[1]?.startMs ?? 0)).toBeLessThan(300);
  });
});

it("fits the complete supporting image without burning in a badge", async () => {
  const image = await sharp({
    create: { ...STUDIO_VIDEO_FRAME, channels: 3, background: "#738c56" },
  })
    .png()
    .toBuffer();
  const frame = await studioIllustrationFrame(image);
  expect(await sharp(frame).metadata()).toMatchObject({
    width: STUDIO_VIDEO_FRAME.width,
    height: STUDIO_VIDEO_FRAME.height,
  });
  // Compare all pixels, including the former lower-left badge and its dark box.
  const actual = await sharp(frame).removeAlpha().raw().toBuffer();
  const expected = await sharp(image).removeAlpha().raw().toBuffer();
  expect(actual.equals(expected)).toBe(true);
});

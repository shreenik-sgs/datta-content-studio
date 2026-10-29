import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { studioFullPictureRegion } from "@satsang/distribution-domain";
import sharp from "sharp";
import { expect, it } from "vitest";
import { STUDIO_VIDEO_FRAME, renderStudioVideo } from "./studio-media";
import { studioReviewFitFrame } from "./studio-presentation-review";

const ffmpeg =
  process.env.DISTRIBUTION_TEST_FFMPEG ??
  (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");

async function colorAt(frame: Buffer, x: number, y: number) {
  const patch = await sharp(frame)
    .extract({ left: Math.round(x) - 2, top: Math.round(y) - 2, width: 5, height: 5 })
    .removeAlpha()
    .png()
    .toBuffer();
  return (await sharp(patch).stats()).channels.map((channel) => channel.mean);
}

function closeColor(actual: number[], expected: number[]) {
  for (const [i, value] of expected.entries())
    expect(Math.abs((actual[i] ?? 0) - value)).toBeLessThan(25);
}

it("keeps both title edges and the complete head in an actual full-picture export and its review evidence", async () => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), "studio-framing-fit-"));
  try {
    const sourcePath = join(directory, "source.mp4");
    // Colored edge markers stand for the source's side title artwork, top of
    // the head and bottom attribution. A center crop loses the two side markers.
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:r=30,drawbox=x=0:y=120:w=40:h=40:c=red:t=fill,drawbox=x=600:y=120:w=40:h=40:c=lime:t=fill,drawbox=x=300:y=0:w=40:h=40:c=magenta:t=fill,drawbox=x=300:y=320:w=40:h=40:c=cyan:t=fill",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      sourcePath,
    ]);
    const renderDirectory = join(directory, "render");
    await mkdir(renderDirectory);
    const path = await renderStudioVideo({
      ffmpeg,
      directory: renderDirectory,
      sourcePath,
      mimeType: "video/mp4",
      backdrop: await sharp({
        create: { width: 1080, height: 1920, channels: 4, background: "#00000000" },
      })
        .png()
        .toBuffer(),
      hasVideo: true,
      hasAudio: false,
      sourceWidth: 640,
      sourceHeight: 360,
      startMs: 0,
      endMs: 1000,
      captions: [],
      scenes: [],
    });
    const frame = execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-ss",
        "0.5",
        "-i",
        path,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
      ],
      { maxBuffer: 12 * 1024 * 1024 },
    );
    const region = studioFullPictureRegion(640, 360);
    const isolated = await studioReviewFitFrame(frame, region);
    for (const [x, y, color] of [
      [20, 140, [255, 0, 0]],
      [620, 140, [0, 255, 0]],
      [320, 20, [255, 0, 255]],
      [320, 340, [0, 255, 255]],
    ] as const) {
      closeColor(await colorAt(isolated, (x / 640) * region.width, (y / 360) * region.height), [
        ...color,
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("never vertically crops a tall speaker's head even when a portrait scene was screened", async () => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), "studio-framing-head-"));
  try {
    const sourcePath = join(directory, "source.mp4");
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=180x640:r=30,drawbox=x=70:y=0:w=40:h=40:c=magenta:t=fill,drawbox=x=70:y=600:w=40:h=40:c=cyan:t=fill",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      sourcePath,
    ]);
    const renderDirectory = join(directory, "render");
    await mkdir(renderDirectory);
    const path = await renderStudioVideo({
      ffmpeg,
      directory: renderDirectory,
      sourcePath,
      mimeType: "video/mp4",
      backdrop: await sharp({
        create: { width: 1080, height: 1920, channels: 4, background: "#00000000" },
      })
        .png()
        .toBuffer(),
      hasVideo: true,
      hasAudio: false,
      sourceWidth: 180,
      sourceHeight: 640,
      startMs: 0,
      endMs: 1000,
      captions: [],
      scenes: [{ startMs: 0, endMs: 1000, bodyTop: 0, bodyBottom: 1 }],
    });
    const frame = execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-ss",
        "0.5",
        "-i",
        path,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
      ],
      { maxBuffer: 12 * 1024 * 1024 },
    );
    closeColor(await colorAt(frame, 540, STUDIO_VIDEO_FRAME.y + 40), [255, 0, 255]);
    closeColor(await colorAt(frame, 540, STUDIO_VIDEO_FRAME.y + 1240), [0, 255, 255]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("fills the whole frame in the immersive layout and lets a moving still cover it", async () => {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), "studio-framing-immersive-"));
  try {
    const sourcePath = join(directory, "source.mp4");
    // Markers: top of the head (magenta, top centre) and the bottom attribution band (cyan).
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:r=30,drawbox=x=0:y=120:w=40:h=40:c=red:t=fill,drawbox=x=300:y=0:w=40:h=40:c=magenta:t=fill,drawbox=x=0:y=324:w=640:h=36:c=cyan:t=fill",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      sourcePath,
    ]);
    const renderDirectory = join(directory, "render");
    await mkdir(renderDirectory);
    const still = await sharp({
      create: { width: 1080, height: 1920, channels: 3, background: "#ffa500" },
    })
      .png()
      .toBuffer();
    const path = await renderStudioVideo({
      layout: "immersive",
      ffmpeg,
      directory: renderDirectory,
      sourcePath,
      mimeType: "video/mp4",
      backdrop: await sharp({
        create: { width: 1080, height: 1920, channels: 4, background: "#00000000" },
      })
        .png()
        .toBuffer(),
      hasVideo: true,
      hasAudio: false,
      sourceWidth: 640,
      sourceHeight: 360,
      startMs: 0,
      endMs: 2000,
      captions: [],
      scenes: [{ startMs: 0, endMs: 2000, bodyTop: 0, bodyBottom: 0.9 }],
      illustrations: [{ bytes: still, startMs: 800, endMs: 1600 }],
    });
    const frameAt = (seconds: string) =>
      execFileSync(
        ffmpeg,
        [
          "-v",
          "error",
          "-ss",
          seconds,
          "-i",
          path,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ],
        { maxBuffer: 12 * 1024 * 1024 },
      );
    const speaker = frameAt("0.4");
    expect(await sharp(speaker).metadata()).toMatchObject({ width: 1080, height: 1920 });
    // The head marker reaches the very top of the frame; the band sits at the very bottom at
    // full width; the far-left red marker is outside the enlarged portrait crop.
    closeColor(await colorAt(speaker, 540, 60), [255, 0, 255]);
    closeColor(await colorAt(speaker, 540, 1900), [0, 255, 255]);
    closeColor(await colorAt(speaker, 20, 1900), [0, 255, 255]);
    closeColor(await colorAt(speaker, 20, 800), [0, 0, 0]);
    const illustrated = frameAt("1.2");
    for (const [x, y] of [
      [20, 20],
      [1060, 20],
      [540, 960],
      [20, 1900],
      [1060, 1900],
    ] as const)
      closeColor(await colorAt(illustrated, x, y), [255, 165, 0]);
    // After the still ends, the speaker is back without any frozen frame of the still.
    closeColor(await colorAt(frameAt("1.8"), 540, 60), [255, 0, 255]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90000);

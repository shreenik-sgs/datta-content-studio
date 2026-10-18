import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ContentPreviewPack,
  PREVIEW_DESTINATIONS,
  canonicalPreviewBrandProfile,
} from "../packages/distribution-domain/src/content-pack";

const run = promisify(execFile);
const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ffmpeg =
  process.env.DISTRIBUTION_TEST_FFMPEG ??
  (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
const ffprobe =
  process.env.DISTRIBUTION_TEST_FFPROBE ??
  (existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "/usr/bin/ffprobe");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const env = {
  PATH: `${dirname(ffmpeg)}:${dirname(ffprobe)}:${process.env.PATH ?? ""}`,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  NODE_ENV: "test",
};
let directory: string;
let master: string;
let logo: string;
let whisper: string;
let metadata: string;
let planPath: string;
let pack: ContentPreviewPack;

async function cli(plan: string, output: string) {
  return run(
    process.execPath,
    [
      join(repository, "node_modules/tsx/dist/cli.mjs"),
      join(repository, "ops/distribution-content-preview.ts"),
      "--test-preview",
      plan,
      master,
      logo,
      whisper,
      metadata,
      output,
    ],
    { cwd: directory, env, timeout: 60000, maxBuffer: 1024 * 1024 },
  );
}
async function probe(file: string) {
  const { stdout } = await run(
    ffprobe,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
    { timeout: 10000 },
  );
  return JSON.parse(stdout) as {
    streams: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }[];
    format: { duration: string };
  };
}
async function expectRefusedBeforeOutput(plan: ContentPreviewPack, name: string, reason: string) {
  const input = join(directory, `${name}.json`);
  const output = join(directory, name);
  await writeFile(input, JSON.stringify(plan));
  await expect(cli(input, output)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(reason),
  });
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
}
function assertColor(frame: Buffer, x: number, y: number, expected: number[]) {
  const offset = (y * 1080 + x) * 3;
  expect(frame.length).toBe(1080 * 1920 * 3);
  for (let channel = 0; channel < 3; channel++) {
    const actual = frame[offset + channel];
    const target = expected[channel];
    if (actual === undefined || target === undefined) throw new Error("MISSING_PIXEL");
    expect(Math.abs(actual - target)).toBeLessThanOrEqual(16);
  }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "sgs-content-preview-test-"));
  master = join(directory, "master.mp4");
  logo = join(directory, "logo.png");
  whisper = join(directory, "whisper.json");
  metadata = join(directory, "metadata.json");
  planPath = join(directory, "plan.json");
  // Synthetic pixels and a tone exercise rendering only; no actual discourse or credentials.
  // The one-second selection begins after the master origin to exercise timestamp reset.
  await run(
    ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-n",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x20d060:size=320x180:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      master,
    ],
    { timeout: 10000 },
  );
  await run(
    ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-n",
      "-f",
      "lavfi",
      "-i",
      "color=c=0xe030c0:size=64x64",
      "-frames:v",
      "1",
      "-update",
      "1",
      logo,
    ],
    { timeout: 10000 },
  );
  const sourceHash = sha(await readFile(master));
  const text = "పరీక్ష";
  const raw = JSON.stringify({
    sourceSha256: sourceHash,
    language: "te",
    segments: [
      {
        id: 0,
        start: 1,
        end: 2,
        text,
        words: [{ word: text, start: 1, end: 2, probability: 0.9 }],
      },
    ],
  });
  await writeFile(whisper, raw);
  const description = "Synthetic source for local preview integration tests.";
  const sourceUrl = "https://example.test/synthetic-master";
  const title = "Self-contained synthetic test clip";
  await writeFile(
    metadata,
    JSON.stringify({
      id: "synthetic-master",
      title,
      webpage_url: sourceUrl,
      description,
      channel: "Synthetic test",
      channel_url: "https://example.test",
      upload_date: "20261004",
    }),
  );
  const brand = {
    id: "synthetic-brand",
    revision: 1,
    name: "Synthetic Ashrama",
    speaker: "Synthetic narrator",
    logoSha256: sha(await readFile(logo)),
    profileSha256: "",
  };
  brand.profileSha256 = sha(canonicalPreviewBrandProfile(brand));
  const attribution = {
    narrator: brand.speaker,
    subject: "Synthetic fixture",
    kind: "discourse_summary" as const,
    quotedSpeaker: null,
  };
  pack = {
    schemaVersion: 1,
    world: "TEST",
    status: "DRAFT_REVIEW_REQUIRED",
    publishAllowed: false,
    source: {
      id: "synthetic-master",
      url: sourceUrl,
      title,
      displayTitle: "Synthetic fixture",
      sha256: sourceHash,
      durationMs: 3000,
      language: "te",
      descriptionSha256: sha(description),
      transcriptSha256: sha(raw),
    },
    brand,
    segments: [
      {
        id: "whisper-0",
        startMs: 1000,
        endMs: 2000,
        text,
        language: "te",
        provenance: "machine_transcript",
      },
    ],
    clips: [
      {
        id: "sample-clip",
        title: "One test moment",
        summary: "A test-only visual and audio fixture.",
        attribution,
        startMs: 1000,
        endMs: 2000,
        segmentIds: ["whisper-0"],
        formats: ["short", "reel"],
      },
    ],
    posts: [
      {
        id: "sample-post",
        title: "A source-linked post",
        summary: "A draft summary of the synthetic fixture.",
        attribution,
        sourceClipId: "sample-clip",
        format: "post",
      },
    ],
    blogs: [
      {
        id: "sample-blog",
        title: "A source-linked reflection",
        dek: "An explicitly unreviewed test summary.",
        paragraphs: ["This paragraph is synthetic editorial test copy."],
        attribution,
        sourceClipIds: ["sample-clip"],
        format: "blog",
      },
    ],
    platforms: PREVIEW_DESTINATIONS.map((channel) => ({
      channel,
      title: `Draft for ${channel}`,
      body: "Review this synthetic summary before publication.",
      assetIds: ["sample-clip", "sample-post", "sample-blog"],
      recommendation: "Manual review only; no upload is authorized.",
    })),
  };
  await writeFile(planPath, JSON.stringify(pack));
}, 30000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("actual offline preview CLI", () => {
  it("renders branded short/reel media, three post aspects, a blog and all five destination drafts", async () => {
    const output = join(directory, "complete");
    const result = await cli(planPath, output);
    expect(result.stdout).toContain('"status":"DRAFT_REVIEW_REQUIRED"');
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as {
      artifacts: {
        id: string;
        file: string;
        sha256: string;
        byteSize: number;
        channel: string;
        kind: string;
        language: string;
        aspect: string;
        masterId: string;
        masterSha256: string;
        sourceClipIds: string[];
        sourceRanges: unknown[];
        posterFile?: string;
      }[];
    };
    const artifactFile = (channel: string, kind: string, aspect: string, extension: string) => {
      const artifact = manifest.artifacts.find(
        (a) =>
          a.channel === channel &&
          a.kind === kind &&
          a.aspect === aspect &&
          a.file.endsWith(`.${extension}`),
      );
      if (!artifact) throw new Error("MISSING_CHANNEL_ARTIFACT");
      return artifact.file;
    };
    const videoEntries = manifest.artifacts.filter((a) => a.file.startsWith("videos/"));
    expect(videoEntries).toHaveLength(10);
    expect((await readdir(join(output, "videos"))).sort()).toEqual(
      videoEntries.map((a) => a.file.slice(7)).sort(),
    );
    for (const [file, width, height] of [
      [artifactFile("youtube", "short", "9:16", "mp4"), 1080, 1920],
      [artifactFile("x", "short", "9:16", "mp4"), 720, 1280],
    ] as const) {
      const media = await probe(join(output, file));
      expect(media.streams.find((stream) => stream.codec_type === "video")).toMatchObject({
        codec_name: "h264",
        width,
        height,
        r_frame_rate: "30/1",
      });
      expect(media.streams.find((stream) => stream.codec_type === "audio")).toMatchObject({
        codec_name: "aac",
      });
      expect(Math.abs(Number(media.format.duration) - 1)).toBeLessThanOrEqual(0.1);
    }
    const vertical = join(output, artifactFile("youtube", "short", "9:16", "mp4"));
    const { stdout: frame } = await run(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        vertical,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 10000 },
    );
    assertColor(frame, 500, 4, [72, 27, 43]); // Brand's maroon header survives encoding.
    assertColor(frame, 100, 100, [224, 48, 192]); // The supplied PNG emblem was actually composited.
    assertColor(frame, 540, 850, [32, 208, 96]); // Full source picture remains in the reserved video area.
    const { stdout: pcm } = await run(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        vertical,
        "-ss",
        "0.1",
        "-t",
        "0.8",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 65536, timeout: 10000 },
    );
    let energy = 0;
    let crossings = 0;
    let previous = 0;
    for (let offset = 0; offset < pcm.length; offset += 2) {
      const sample = pcm.readInt16LE(offset);
      energy += sample * sample;
      if (previous <= 0 && sample > 0) crossings++;
      previous = sample;
    }
    expect(Math.sqrt(energy / (pcm.length / 2))).toBeGreaterThan(1000);
    expect(Math.abs(crossings / (pcm.length / 2 / 16000) - 440)).toBeLessThan(5);
    for (const [aspect, width, height] of [
      ["4:5", 1080, 1350],
      ["1:1", 1080, 1080],
      ["16:9", 1600, 900],
    ] as const) {
      const png = await readFile(join(output, artifactFile("instagram", "post", aspect, "png")));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height]);
    }
    const blog = await readFile(
      join(output, artifactFile("facebook", "blog", "prose", "html")),
      "utf8",
    );
    expect(blog).toContain("This paragraph is synthetic editorial test copy.");
    expect(blog).toContain(pack.source.url);
    expect(blog).toContain("not a verbatim quotation or an approved translation");
    expect(
      await readFile(join(output, artifactFile("facebook", "blog", "prose", "md")), "utf8"),
    ).toContain("TEST PREVIEW — Editorial summary; review required.");
    expect((await readdir(join(output, "copy"))).sort()).toEqual(
      manifest.artifacts
        .filter((a) => a.kind === "copy")
        .map((a) => a.file.slice(5))
        .sort(),
    );
    for (const channel of PREVIEW_DESTINATIONS) {
      const copy = await readFile(
        join(output, artifactFile(channel, "copy", "prose", "txt")),
        "utf8",
      );
      expect(copy).toContain(`Draft for ${channel}`);
      expect(copy).toContain("TEST PREVIEW — Review required");
      expect(copy).toContain(`Master: ${pack.source.id}`);
      expect(copy).toContain(`Channel: ${channel}`);
      for (const artifact of manifest.artifacts.filter(
        (a) => a.channel === channel && !["copy", "poster"].includes(a.kind),
      ))
        expect(copy).toContain(artifact.file);
    }
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      world: "TEST",
      status: "DRAFT_REVIEW_REQUIRED",
      publishAllowed: false,
      source: pack.source,
      brand: pack.brand,
      validation: { humanEditorialApproval: false, productionProviderAdoption: false },
    });
    expect(manifest.artifacts).toHaveLength(40);
    expect(new Set(manifest.artifacts.map((a) => a.file.toLowerCase())).size).toBe(40);
    for (const artifact of manifest.artifacts) {
      expect(artifact.file.split("/").at(-1)?.length).toBeLessThanOrEqual(100);
      expect(artifact.file).toContain(
        `sgs-${pack.source.id.slice(0, 12)}-${pack.source.sha256.slice(0, 12)}-${artifact.channel}-${artifact.kind}-${artifact.language}-${artifact.aspect.replace(":", "x")}-`,
      );
      expect(artifact.masterId).toBe(pack.source.id);
      expect(artifact.masterSha256).toBe(pack.source.sha256);
      expect(artifact.sourceClipIds).toEqual(["sample-clip"]);
      expect(artifact.sourceRanges).toEqual([
        { clipId: "sample-clip", startMs: 1000, endMs: 2000, segmentIds: ["whisper-0"] },
      ]);
      const bytes = await readFile(join(output, artifact.file));
      expect(artifact.sha256).toBe(sha(bytes));
      expect(artifact.byteSize).toBe(bytes.length);
    }
    expect(await readFile(join(output, "evidence/transcript-raw.json"))).toEqual(
      await readFile(whisper),
    );
    const page = await readFile(join(output, "index.html"), "utf8");
    expect(page).toContain("TEST PREVIEW · EDITORIAL REVIEW REQUIRED");
    expect(page).toContain(`<title>${pack.source.displayTitle} · Ashrama content review</title>`);
    const browser = await chromium.launch({ headless: true });
    try {
      const gallery = await browser.newPage();
      await gallery.route(/^https?:/, (route) => route.abort());
      for (const width of [320, 390, 1440]) {
        await gallery.setViewportSize({ width, height: 900 });
        await gallery.goto(pathToFileURL(join(output, "index.html")).href);
        const geometry = await gallery.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      }
    } finally {
      await browser.close();
    }
    for (const channel of PREVIEW_DESTINATIONS) {
      const width = channel === "x" ? 720 : 1080;
      const height = channel === "x" ? 1280 : 1920;
      const poster = artifactFile(channel, "poster", "9:16", "png");
      expect(page).toContain(`poster="${poster}"`);
      const png = await readFile(join(output, poster));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height]);
      expect(page).toContain(`href="${artifactFile(channel, "copy", "prose", "txt")}"`);
    }
    // Channel-specific copies are byte-identical to their verified source render.
    expect(await readFile(join(output, artifactFile("facebook", "reel", "9:16", "mp4")))).toEqual(
      await readFile(vertical),
    );
    // The package seal includes posters, evidence, text, layouts and gallery as well as media.
    const integrity = JSON.parse(await readFile(join(output, "integrity.json"), "utf8")) as {
      algorithm: string;
      excludes: string[];
      files: { file: string; sha256: string; byteSize: number }[];
    };
    expect(integrity.algorithm).toBe("sha256");
    expect(integrity.excludes).toEqual(["integrity.json"]);
    const actualFiles: string[] = [];
    for (const name of await readdir(output, { recursive: true })) {
      if (name !== "integrity.json" && (await stat(join(output, name))).isFile())
        actualFiles.push(name);
    }
    expect(integrity.files.map((file) => file.file).sort()).toEqual(actualFiles.sort());
    for (const file of integrity.files) {
      const path = join(output, file.file);
      const bytes = await readFile(path);
      expect(file.sha256).toBe(sha(bytes));
      expect(file.byteSize).toBe(bytes.length);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    // An existing run is immutable, even when supplied the same valid inputs again.
    const originalManifest = await readFile(join(output, "manifest.json"));
    await expect(cli(planPath, output)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("EEXIST"),
    });
    expect(await readFile(join(output, "manifest.json"))).toEqual(originalManifest);
  }, 90000);

  it("refuses altered transcript wording before creating an output directory", async () => {
    const changed = structuredClone(pack);
    changed.segments = changed.segments.map((segment) => ({ ...segment, text: "మార్పు" }));
    await expectRefusedBeforeOutput(changed, "altered-transcript", "PREVIEW_TRANSCRIPT_MISMATCH");
  }, 15000);

  it("refuses a source hash mismatch before creating an output directory", async () => {
    const changed = structuredClone(pack);
    changed.source.sha256 = "0".repeat(64);
    await expectRefusedBeforeOutput(changed, "altered-source", "PREVIEW_INPUT_HASH_MISMATCH");
  }, 15000);
});

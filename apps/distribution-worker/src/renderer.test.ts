import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RenderRecipe,
  type VariantAspect,
  parseDerivedAssetKey,
} from "@satsang/distribution-domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLocalRenderArguments, createLocalRenderer, renderCaptions } from "./renderer";

const ffmpegPath =
  process.env.DISTRIBUTION_TEST_FFMPEG ??
  (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
const ffprobePath =
  process.env.DISTRIBUTION_TEST_FFPROBE ??
  (existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "/usr/bin/ffprobe");
const id = "11111111-1111-4111-8111-111111111111";
const transcriptId = "22222222-2222-4222-8222-222222222222";
const storageKey = `distribution/masters/${id}`;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let root: string;
let source: {
  masterId: string;
  versionId: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  mimeType: "video/mp4";
};
const sizes = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "4:5": [1080, 1350],
  "1:1": [1080, 1080],
} as const;
function recipe(aspect: VariantAspect = "16:9"): RenderRecipe {
  return {
    schemaVersion: 1,
    sourceVersionId: id,
    sourceSha256: source.sha256,
    sourceRevision: 3,
    transcriptVersionId: transcriptId,
    transcriptRevision: 2,
    quoteId: null,
    quoteRevision: null,
    translationId: null,
    translationRevision: null,
    template: { id: "contained-preview-v1", version: 1 },
    aspect,
    width: sizes[aspect][0],
    height: sizes[aspect][1],
    fit: "contain",
    language: "te",
    startMs: 400,
    endMs: 1600,
    captions: [{ startMs: 0, endMs: 1200, text: "పరీక్ష & <నమూనా> — synthetic test" }],
    channel: "manual_export",
    territory: "WORLDWIDE",
  };
}
function probe(path: string) {
  return JSON.parse(
    execFileSync(
      ffprobePath,
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
      { encoding: "utf8", timeout: 10000 },
    ),
  );
}
beforeAll(async () => {
  root = await mkdtemp(join(realpathSync(tmpdir()), "distribution-renderer-test-"));
  await mkdir(join(root, "distribution", "masters"), { recursive: true, mode: 0o700 });
  // Explicit synthetic source: no sacred recordings or external content.
  execFileSync(
    ffmpegPath,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      join(root, storageKey),
    ],
    { timeout: 15000 },
  );
  await chmod(join(root, storageKey), 0o600);
  const bytes = await readFile(join(root, storageKey));
  source = {
    masterId: "44444444-4444-4444-8444-444444444444",
    versionId: id,
    storageKey,
    sha256: sha(bytes),
    byteSize: bytes.length,
    mimeType: "video/mp4",
  };
}, 20000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("DS-DIST-R3 bounded offline renderer", () => {
  it("DS-DIST-R3-CLEANUP deletes only its verified rejected result directory", async () => {
    const renderer = createLocalRenderer({ root, ffmpegPath, ffprobePath });
    const rendered = await renderer.render({ source, recipe: recipe() });
    const before = await readFile(join(root, source.storageKey));
    await expect(
      renderer.discard({
        ...rendered,
        video: { ...rendered.video, storageKey: source.storageKey },
      }),
    ).rejects.toThrow("INVALID_RENDER_RESULT");
    const other = await renderer.render({ source, recipe: recipe() });
    await expect(renderer.discard({ ...rendered, captions: other.captions })).rejects.toThrow(
      "INVALID_RENDER_RESULT",
    );
    await renderer.discard(other);
    await renderer.discard(rendered);
    await expect(readFile(join(root, rendered.video.storageKey))).rejects.toThrow();
    expect(await readFile(join(root, source.storageKey))).toEqual(before);
    const changed = await renderer.render({ source, recipe: recipe() });
    await writeFile(join(root, changed.manifest.storageKey), "unexpected replacement");
    await expect(renderer.discard(changed)).rejects.toThrow("RENDER_RESULT_CHANGED");
    expect((await readFile(join(root, changed.video.storageKey))).length).toBeGreaterThan(0);
  }, 30000); // Three real FFmpeg renders compete with other media suites in the full gate.

  it("DS-DIST-R3-ISOLATION builds fixed descriptor-only args and refuses hostile/unbounded recipes", () => {
    const args = buildLocalRenderArguments(recipe());
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("fd");
    expect(args).toContain("fd:");
    expect(args).not.toContain("file");
    expect(args).not.toContain("http");
    expect(args[args.indexOf("-enable_drefs") + 1]).toBe("0");
    expect(args[args.indexOf("-vf") + 1]).toContain("force_original_aspect_ratio=decrease");
    expect(args[args.indexOf("-vf") + 1]).not.toContain("crop");
    for (const invalid of [
      { ...recipe(), width: 100000 },
      { ...recipe(), endMs: 130000 },
      { ...recipe(), fit: "crop" },
      { ...recipe(), filter: "movie=https://example.test/private" },
      { ...recipe(), startMs: -1 },
      { ...recipe(), template: { id: "unreviewed-logo", version: 1 } },
    ])
      expect(() => buildLocalRenderArguments(invalid as RenderRecipe)).toThrow();
  });
  it("DS-DIST-R3-CAPTIONS preserves Unicode and quotes safely without silently rewriting words", () => {
    const result = renderCaptions(recipe());
    expect(result).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nపరీక్ష &amp; &lt;నమూనా&gt; — synthetic test\n\n",
    );
    expect(() =>
      renderCaptions({ ...recipe(), captions: [{ startMs: 0, endMs: 1000, text: "one\n\ntwo" }] }),
    ).toThrow("UNSUPPORTED_CAPTION_LAYOUT");
  });
  it.each(["16:9", "9:16", "4:5", "1:1"] as const)(
    "DS-DIST-R3-RENDER creates contained %s video with exact span and retained tone",
    async (aspect) => {
      const rendered = await createLocalRenderer({ root, ffmpegPath, ffprobePath }).render({
        source,
        recipe: recipe(aspect),
      });
      const bytes = await readFile(join(root, rendered.video.storageKey));
      expect(rendered.video.sha256).toBe(sha(bytes));
      expect(rendered.video.byteSize).toBe(bytes.length);
      expect(rendered.video.mimeType).toBe("video/mp4");
      const metadata = probe(join(root, rendered.video.storageKey));
      const video = metadata.streams.find(
        (stream: { codec_type: string }) => stream.codec_type === "video",
      );
      const audio = metadata.streams.find(
        (stream: { codec_type: string }) => stream.codec_type === "audio",
      );
      expect([video.width, video.height]).toEqual([...sizes[aspect]]);
      expect(video.codec_name).toBe("h264");
      expect(audio.codec_name).toBe("aac");
      expect(Math.abs(Number(video.duration) - 1.2)).toBeLessThanOrEqual(0.04);
      expect(Math.abs(Number(audio.duration) - 1.2)).toBeLessThanOrEqual(0.05);
      expect(Number(audio.sample_rate)).toBe(48000);
      const pcm = execFileSync(
        ffmpegPath,
        [
          "-nostdin",
          "-v",
          "error",
          "-i",
          join(root, rendered.video.storageKey),
          "-map",
          "0:a:0",
          "-ss",
          "0.2",
          "-t",
          "0.8",
          "-f",
          "s16le",
          "-ac",
          "1",
          "-ar",
          "48000",
          "pipe:1",
        ],
        { timeout: 10000 },
      );
      let energy = 0;
      let crossings = 0;
      let previous = 0;
      for (let i = 0; i < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i);
        energy += sample * sample;
        if (previous < 0 && sample >= 0) crossings++;
        previous = sample;
      }
      expect(Math.sqrt(energy / (pcm.length / 2))).toBeGreaterThan(1500);
      expect(crossings / (pcm.length / 2 / 48000)).toBeGreaterThan(430);
      expect(crossings / (pcm.length / 2 / 48000)).toBeLessThan(450);
      expect(rendered.captions).not.toBeNull();
      expect(await readFile(join(root, rendered.captions?.storageKey ?? ""), "utf8")).toBe(
        renderCaptions(recipe(aspect)),
      );
      const manifest = JSON.parse(await readFile(join(root, rendered.manifest.storageKey), "utf8"));
      expect(manifest.recipe).toEqual(recipe(aspect));
      expect(manifest.recipeSha256).toBe(rendered.recipeSha256);
      expect(manifest.approved).toBe(false);
      expect(manifest.encoderVersion).toMatch(/^ffmpeg version /);
      const parsed = parseDerivedAssetKey(rendered.video.storageKey);
      expect(parsed?.naming).toMatchObject({
        masterId: source.masterId,
        sourceVersionId: source.versionId,
        destination: "manual_export",
        language: "te",
        aspect,
      });
      expect(manifest.lineage).toEqual({
        masterId: source.masterId,
        sourceVersionId: source.versionId,
        derivationId: parsed?.naming?.derivationId,
        sourceStorageKey: source.storageKey,
        channel: "manual_export",
        destination: "manual_export",
      });
    },
    30000,
  );
  it("DS-DIST-R3-DETERMINISM repeats canonical recipe and encoded hashes", async () => {
    const renderer = createLocalRenderer({ root, ffmpegPath, ffprobePath });
    const first = await renderer.render({ source, recipe: recipe("1:1") });
    const second = await renderer.render({ source, recipe: recipe("1:1") });
    expect(first.recipeSha256).toBe(second.recipeSha256);
    expect(first.video.sha256).toBe(second.video.sha256);
    expect(first.captions?.sha256).toBe(second.captions?.sha256);
    expect(first.video.storageKey).not.toBe(second.video.storageKey);
  }, 30000);
  it("DS-DIST-R3-ISOLATION refuses traversal, symlinks and changed hashes without publishing output", async () => {
    const renderer = createLocalRenderer({ root, ffmpegPath, ffprobePath });
    const before = await readdir(join(root, "distribution", "renders"));
    await expect(
      renderer.render({ source: { ...source, storageKey: "../../etc/passwd" }, recipe: recipe() }),
    ).rejects.toThrow("INVALID_RENDER_SOURCE");
    await expect(
      renderer.render({
        source: { ...source, sha256: "f".repeat(64) },
        recipe: { ...recipe(), sourceSha256: "f".repeat(64) },
      }),
    ).rejects.toThrow("SOURCE_INTEGRITY_FAILED");
    const linkKey = "distribution/masters/33333333-3333-4333-8333-333333333333";
    await symlink(join(root, storageKey), join(root, linkKey));
    await expect(
      renderer.render({ source: { ...source, storageKey: linkKey }, recipe: recipe() }),
    ).rejects.toThrow("SYMLINK_REFUSED");
    expect(await readdir(join(root, "distribution", "renders"))).toEqual(before);
  });
  it("DS-DIST-R3-BOUNDS kills timed-out jobs and cleans temporary derivatives", async () => {
    const before = await readdir(join(root, "distribution", "renders"));
    const renderer = createLocalRenderer({ root, ffmpegPath, ffprobePath, timeoutMs: 10 });
    await expect(renderer.render({ source, recipe: recipe() })).rejects.toThrow("RENDER_TIMEOUT");
    expect(await readdir(join(root, "distribution", "renders"))).toEqual(before);
  });
  it("DS-DIST-R3-SOURCE source replacement during encoding refuses the derivative", async () => {
    const renders = join(root, "distribution", "renders");
    const before = await readdir(renders);
    const original = await readFile(join(root, storageKey));
    const attempt = createLocalRenderer({ root, ffmpegPath, ffprobePath })
      .render({ source, recipe: recipe() })
      .then(
        () => null,
        (error: Error) => error,
      );
    try {
      const deadline = Date.now() + 5000;
      while (!(await readdir(renders)).some((name) => name.startsWith(".pending-"))) {
        if (Date.now() > deadline) throw new Error("TEST_RENDER_DID_NOT_START");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const changed = Buffer.from(original);
      changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
      await writeFile(join(root, storageKey), changed, { mode: 0o600 });
      expect((await attempt)?.message).toBe("SOURCE_INTEGRITY_FAILED");
      expect(await readdir(renders)).toEqual(before);
    } finally {
      await attempt;
      await writeFile(join(root, storageKey), original, { mode: 0o600 });
    }
  });
  it("DS-DIST-R3-BOUNDS a cancelled job does not publish artifacts", async () => {
    const controller = new AbortController();
    const before = await readdir(join(root, "distribution", "renders"));
    controller.abort();
    await expect(
      createLocalRenderer({ root, ffmpegPath, ffprobePath }).render({
        source,
        recipe: recipe(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("RENDER_CANCELLED");
    expect(await readdir(join(root, "distribution", "renders"))).toEqual(before);
  });
  it("DS-DIST-R3-SOURCE refuses a requested clip that extends beyond actual media", async () => {
    const before = await readdir(join(root, "distribution", "renders"));
    await expect(
      createLocalRenderer({ root, ffmpegPath, ffprobePath }).render({
        source,
        recipe: { ...recipe(), endMs: 5000 },
      }),
    ).rejects.toThrow("SOURCE_SPAN_UNAVAILABLE");
    expect(await readdir(join(root, "distribution", "renders"))).toEqual(before);
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type S3Transport,
  type StoredPrivateAsset,
  createS3AssetStore,
} from "@satsang/distribution-assets";
import type { RenderClaim } from "@satsang/distribution-db";
import { type RenderRecipe, parseDerivedAssetKey } from "@satsang/distribution-domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LocalRenderResult, RenderSource } from "./renderer";
import { runRenderJob } from "./run-render-job";
import { createStoredRenderer } from "./stored-renderer";

const ffmpegPath =
  process.env.DISTRIBUTION_TEST_FFMPEG ??
  (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "/usr/bin/ffmpeg");
const ffprobePath =
  process.env.DISTRIBUTION_TEST_FFPROBE ??
  (existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "/usr/bin/ffprobe");
let fixtureRoot: string;
let sourceBytes: Buffer;
beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(realpathSync(tmpdir()), "distribution-stored-render-test-"));
  const path = join(fixtureRoot, "synthetic.mp4");
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
      "testsrc2=size=160x90:rate=30",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      path,
    ],
    { timeout: 15000 },
  );
  sourceBytes = await readFile(path);
}, 20000);
afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(fixtureRoot, "case-"));
  const scratchRoot = join(root, "scratch");
  const objects = new Map<
    string,
    { bytes: Buffer; mimeType: string; checksum: string; etag: string }
  >();
  let sequence = 0;
  const transport: S3Transport = {
    async send(command, options) {
      expect(options.abortSignal.aborted).toBe(false);
      const input = command.input;
      expect(input.Bucket).toBe("synthetic-storage-test");
      expect(input.ExpectedBucketOwner).toBe("123456789012");
      expect(input.Key).toMatch(/^test\/distribution\/(masters|renders|derived)\//);
      const key = input.Key ?? "";
      if ("Body" in input) {
        if (!(input.Body instanceof Uint8Array) || !input.ContentType || !input.ChecksumSHA256)
          throw new Error("INVALID_TEST_PUT");
        expect(input.IfNoneMatch).toBe("*");
        expect(input.ServerSideEncryption).toBe("AES256");
        expect(input.ContentLength).toBe(input.Body.byteLength);
        if (objects.has(key)) throw new Error("PreconditionFailed");
        objects.set(key, {
          bytes: Buffer.from(input.Body),
          mimeType: input.ContentType,
          checksum: input.ChecksumSHA256,
          etag: `"object-${++sequence}"`,
        });
        return {};
      }
      const value = objects.get(key);
      if (!value) throw new Error("NoSuchKey");
      if ("ChecksumMode" in input) {
        return {
          ContentLength: value.bytes.length,
          ContentType: value.mimeType,
          ChecksumSHA256: value.checksum,
          ETag: value.etag,
          ServerSideEncryption: "AES256",
          Body: (async function* () {
            yield Buffer.from(value.bytes);
          })(),
        };
      }
      if (!("IfMatch" in input) || input.IfMatch !== value.etag)
        throw new Error("PreconditionFailed");
      objects.delete(key);
      return {};
    },
  };
  const disk = createS3AssetStore(
    {
      bucket: "synthetic-storage-test",
      region: "us-east-1",
      expectedBucketOwner: "123456789012",
      prefix: "test/",
    },
    transport,
  );
  const master = await disk.write({
    bytes: sourceBytes,
    mimeType: "video/mp4",
    originalName: "synthetic.mp4",
  });
  // The actual S3 adapter and FFmpeg run against an in-memory command transport;
  // no AWS, credential-provider, HTTP or database calls are made.
  const store = {
    ...disk,
    read: vi.fn(disk.read),
    writeDerivedDescriptor: vi.fn(disk.writeDerivedDescriptor),
    removeDerivedUnreferenced: vi.fn(disk.removeDerivedUnreferenced),
  };
  const source: RenderSource = {
    ...master,
    masterId: "44444444-4444-4444-8444-444444444444",
    mimeType: "video/mp4",
    versionId: "11111111-1111-4111-8111-111111111111",
  };
  const recipe: RenderRecipe = {
    schemaVersion: 1,
    sourceVersionId: source.versionId,
    sourceSha256: source.sha256,
    sourceRevision: 1,
    transcriptVersionId: "22222222-2222-4222-8222-222222222222",
    transcriptRevision: 1,
    quoteId: null,
    quoteRevision: null,
    translationId: null,
    translationRevision: null,
    template: { id: "contained-preview-v1", version: 1 },
    aspect: "1:1",
    width: 1080,
    height: 1080,
    fit: "contain",
    language: "en",
    startMs: 0,
    endMs: 600,
    captions: [{ startMs: 0, endMs: 600, text: "Synthetic storage test" }],
    channel: "manual_export",
    placement: "instagram",
    territory: "WORLDWIDE",
  };
  const claim: RenderClaim = {
    id: "job",
    masterId: source.masterId,
    source: { ...source, originalName: master.originalName },
    recipe,
    isTest: true,
    sourceVersionId: source.versionId,
    recipeSha256: "a".repeat(64),
    requestedBy: "renderer@example.test",
    status: "RUNNING",
    attempts: 1,
    maxAttempts: 3,
    availableAt: "2026-10-05T00:00:00.000Z",
    leaseToken: "synthetic-lease",
    leaseOwner: "test",
    leaseUntil: "2026-10-05T00:04:00.000Z",
    lastError: null,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
  const repository = {
    claim: vi.fn().mockResolvedValue(claim),
    succeed: vi.fn().mockResolvedValue({ accepted: true }),
    fail: vi.fn().mockResolvedValue({}),
  };
  const renderer = createStoredRenderer({ store, scratchRoot, ffmpegPath, ffprobePath });
  return { root, disk, master, store, scratchRoot, source, recipe, repository, renderer };
}

describe("S3 renderer staging and durable output lifecycle without network", () => {
  it("uploads verified real video, captions and manifest before committing; removes all scratch", async () => {
    const f = await fixture();
    f.repository.succeed.mockImplementation(async (_claim, output: LocalRenderResult) => {
      expect(await readdir(f.scratchRoot)).toEqual([]);
      for (const descriptor of [output.video, output.captions, output.manifest]) {
        if (!descriptor) throw new Error("MISSING_TEST_OUTPUT");
        expect((await f.disk.readDerivedDescriptor(descriptor)).byteLength).toBe(
          descriptor.byteSize,
        );
      }
      const manifest = JSON.parse((await f.disk.readDerivedDescriptor(output.manifest)).toString());
      expect(manifest.recipe.sourceVersionId).toBe(f.source.versionId);
      expect(manifest.sourceSha256).toBe(f.source.sha256);
      expect(manifest.approved).toBe(false);
      expect(manifest.lineage).toMatchObject({
        masterId: f.source.masterId,
        sourceVersionId: f.source.versionId,
        sourceStorageKey: f.master.storageKey,
        channel: "manual_export",
        destination: "instagram",
      });
      expect(parseDerivedAssetKey(output.video.storageKey)?.naming).toMatchObject({
        masterId: f.source.masterId,
        sourceVersionId: f.source.versionId,
        destination: "instagram",
      });
      return { accepted: true };
    });
    expect(
      await runRenderJob({ ...f, workerId: "test", signal: new AbortController().signal }),
    ).toEqual({ status: "rendered", jobId: "job" });
    expect(f.store.read).toHaveBeenCalledTimes(2);
    expect(f.store.writeDerivedDescriptor).toHaveBeenCalledTimes(3);
    expect(f.store.removeDerivedUnreferenced).not.toHaveBeenCalled();
    expect(await f.disk.read(f.master)).toEqual(sourceBytes);
  });

  it("deletes only the adapter's verified outputs after a definitive stale result", async () => {
    const f = await fixture();
    f.repository.succeed.mockResolvedValue({ accepted: false, reason: "WITHDRAWN" });
    expect(
      await runRenderJob({ ...f, workerId: "test", signal: new AbortController().signal }),
    ).toEqual({ status: "stale", jobId: "job", reason: "WITHDRAWN" });
    expect(f.store.removeDerivedUnreferenced).toHaveBeenCalledTimes(3);
    for (const [descriptor] of f.store.writeDerivedDescriptor.mock.calls)
      await expect(f.disk.readDerivedDescriptor(descriptor)).rejects.toThrow();
    expect(await readdir(f.scratchRoot)).toEqual([]);
    expect(await f.disk.read(f.master)).toEqual(sourceBytes);
  });

  it("preserves durable output after uncertain commit and refuses foreign or mutated cleanup", async () => {
    const f = await fixture();
    let output: LocalRenderResult | undefined;
    f.repository.succeed.mockImplementation(async (_claim, value: LocalRenderResult) => {
      output = value;
      throw new Error("Commit response lost");
    });
    expect(
      await runRenderJob({ ...f, workerId: "test", signal: new AbortController().signal }),
    ).toEqual({ status: "uncertain", jobId: "job", reason: "RESULT_COMMIT_UNCONFIRMED" });
    if (!output) throw new Error("MISSING_TEST_OUTPUT");
    expect(f.store.removeDerivedUnreferenced).not.toHaveBeenCalled();
    await expect(f.renderer.discard({ ...output })).rejects.toThrow("INVALID_RENDER_RESULT");
    const key = output.video.storageKey;
    output.video.storageKey = f.master.storageKey;
    await expect(f.renderer.discard(output)).rejects.toThrow("INVALID_RENDER_RESULT");
    output.video.storageKey = key;
    expect((await f.disk.readDerivedDescriptor(output.video)).length).toBeGreaterThan(0);
    expect(await readdir(f.scratchRoot)).toEqual([]);
    expect(await f.disk.read(f.master)).toEqual(sourceBytes);
  });

  it("rolls back acknowledged uploads but preserves the object from an uncertain failed put", async () => {
    const f = await fixture();
    f.store.writeDerivedDescriptor.mockImplementation(async (descriptor, bytes) => {
      await f.disk.writeDerivedDescriptor(descriptor, bytes);
      if (descriptor.mimeType === "application/json") throw new Error("Put response lost");
    });
    expect(
      await runRenderJob({ ...f, workerId: "test", signal: new AbortController().signal }),
    ).toEqual({ status: "failed", jobId: "job", reason: "RENDER_FAILED" });
    expect(f.repository.succeed).not.toHaveBeenCalled();
    expect(f.store.removeDerivedUnreferenced).toHaveBeenCalledTimes(2);
    const calls = f.store.writeDerivedDescriptor.mock.calls;
    for (const [descriptor] of calls.slice(0, 2))
      await expect(f.disk.readDerivedDescriptor(descriptor)).rejects.toThrow();
    const uncertain = calls[2]?.[0];
    if (!uncertain) throw new Error("MISSING_TEST_UPLOAD");
    expect((await f.disk.readDerivedDescriptor(uncertain)).length).toBeGreaterThan(0);
    expect(await readdir(f.scratchRoot)).toEqual([]);
  });

  it("cancellation during upload removes only confirmed outputs and all private staging", async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.store.writeDerivedDescriptor.mockImplementation(async (descriptor, bytes) => {
      await f.disk.writeDerivedDescriptor(descriptor, bytes);
      controller.abort();
    });
    await expect(
      f.renderer.render({ source: f.source, recipe: f.recipe, signal: controller.signal }),
    ).rejects.toThrow("RENDER_CANCELLED");
    expect(f.store.writeDerivedDescriptor).toHaveBeenCalledTimes(1);
    expect(f.store.removeDerivedUnreferenced).toHaveBeenCalledTimes(1);
    expect(await readdir(f.scratchRoot)).toEqual([]);
  });

  it("rejects corrupted remote source before upload and cleans scratch after download failures", async () => {
    const f = await fixture();
    f.store.read.mockImplementation(async (descriptor: StoredPrivateAsset) =>
      f.disk.read({ ...descriptor, sha256: "f".repeat(64) }),
    );
    await expect(f.renderer.render({ source: f.source, recipe: f.recipe })).rejects.toThrow(
      "ASSET_INTEGRITY_FAILED",
    );
    expect(f.store.writeDerivedDescriptor).not.toHaveBeenCalled();
    expect(await readdir(f.scratchRoot)).toEqual([]);
  });

  it("refuses insecure and symlink scratch roots before downloading media", async () => {
    const f = await fixture();
    await mkdir(f.scratchRoot, { mode: 0o700 });
    await chmod(f.scratchRoot, 0o755);
    await expect(f.renderer.render({ source: f.source, recipe: f.recipe })).rejects.toThrow(
      "PRIVATE_ROOT_PERMISSIONS",
    );
    await rm(f.scratchRoot, { recursive: true });
    await symlink(f.root, f.scratchRoot);
    await expect(f.renderer.render({ source: f.source, recipe: f.recipe })).rejects.toThrow(
      "SYMLINK_REFUSED",
    );
    expect(f.store.read).not.toHaveBeenCalled();
  });

  it("bounds orchestration within the queue lease and stops after an expired download", async () => {
    const f = await fixture();
    f.store.read.mockImplementation(async (descriptor) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return f.disk.read(descriptor);
    });
    const renderer = createStoredRenderer({
      store: f.store,
      scratchRoot: f.scratchRoot,
      ffmpegPath,
      ffprobePath,
      overallTimeoutMs: 20,
    });
    await expect(renderer.render({ source: f.source, recipe: f.recipe })).rejects.toThrow(
      "RENDER_TIMEOUT",
    );
    expect(f.store.read).toHaveBeenCalledTimes(1);
    expect(f.store.writeDerivedDescriptor).not.toHaveBeenCalled();
    expect(await readdir(f.scratchRoot)).toEqual([]);
  });
});

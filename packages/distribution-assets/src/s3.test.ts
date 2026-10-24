import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  buildDerivedAssetNames,
  studioAssetName,
  studioSharedAssetKey,
} from "@satsang/distribution-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetStore, parseAssetStoreConfig } from "./index";
import {
  type S3AssetCommand,
  type S3Transport,
  S3_ASSET_TIMEOUT_MS,
  createS3AssetStore,
} from "./s3";
import type { DerivedPrivateAsset } from "./validation";

const config = {
  bucket: "distribution-assets-test",
  region: "us-east-1",
  expectedBucketOwner: "123456789012",
  prefix: "test/" as const,
};
const master = Buffer.from("ID3-private-test-master");
const input = { bytes: master, mimeType: "audio/mpeg", originalName: "chant.mp3" };
const env = {
  DISTRIBUTION_ASSET_BACKEND: "s3",
  DISTRIBUTION_HUB_STAGE: "TEST",
  DISTRIBUTION_S3_BUCKET: config.bucket,
  DISTRIBUTION_S3_REGION: config.region,
  DISTRIBUTION_S3_EXPECTED_BUCKET_OWNER: config.expectedBucketOwner,
  DISTRIBUTION_S3_PREFIX: config.prefix,
};
type ObjectData = { bytes: Buffer; mime: string; checksum: string; etag: string };
class MemoryS3 implements S3Transport {
  calls: S3AssetCommand[] = [];
  objects = new Map<string, ObjectData>();
  responseOverride: Record<string, unknown> = {};
  async send(command: S3AssetCommand) {
    this.calls.push(command);
    const key = command.input.Key as string;
    if (command instanceof PutObjectCommand) {
      if (this.objects.has(key)) throw new Error("PreconditionFailed");
      this.objects.set(key, {
        bytes: Buffer.from(command.input.Body as Uint8Array),
        mime: command.input.ContentType as string,
        checksum: command.input.ChecksumSHA256 as string,
        etag: '"test-etag"',
      });
      return {};
    }
    const stored = this.objects.get(key);
    if (!stored) throw new Error("NoSuchKey");
    if (command instanceof GetObjectCommand)
      return {
        Body: Readable.from([stored.bytes]),
        ContentLength: stored.bytes.length,
        ContentType: stored.mime,
        ServerSideEncryption: "AES256",
        ChecksumSHA256: stored.checksum,
        ETag: stored.etag,
        ...this.responseOverride,
      };
    if (command.input.IfMatch !== stored.etag) throw new Error("PreconditionFailed");
    this.objects.delete(key);
    return {};
  }
}
function derived(
  name = "captions.vtt",
  bytes = Buffer.from("WEBVTT\n\n"),
  mimeType = "text/vtt",
): DerivedPrivateAsset {
  return {
    storageKey: `distribution/renders/${randomUUID()}/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    mimeType,
  };
}
afterEach(() => vi.useRealTimers());

describe("private S3 storage with no network", () => {
  it("persists descriptive channel keys under their complete master lineage", async () => {
    const transport = new MemoryS3();
    const store = createS3AssetStore(config, transport);
    const names = buildDerivedAssetNames({
      masterId: randomUUID(),
      sourceVersionId: randomUUID(),
      derivationId: randomUUID(),
      destination: "instagram",
      language: "en",
      aspect: "9:16",
    });
    const bytes = Buffer.from("WEBVTT\n\n");
    const asset = { ...derived(), storageKey: `${names.directory}/${names.captions}` };
    await store.writeDerivedDescriptor(asset, bytes);
    expect((transport.calls[0] as PutObjectCommand).input.Key).toBe(`test/${asset.storageKey}`);
    expect(await store.readDerivedDescriptor(asset)).toEqual(bytes);
    await store.removeDerivedUnreferenced(asset);
    expect(transport.objects.size).toBe(0);
  });
  it("stores opaque immutable encrypted objects with checksum and owner binding", async () => {
    const transport = new MemoryS3();
    const store = createS3AssetStore(config, transport);
    const asset = await store.write(input);
    expect(asset.storageKey).toMatch(/^distribution\/masters\/[0-9a-f-]{36}$/);
    expect(await store.read(asset)).toEqual(master);
    const request = transport.calls[0] as PutObjectCommand;
    expect(request.input).toMatchObject({
      Bucket: config.bucket,
      Key: `test/${asset.storageKey}`,
      ExpectedBucketOwner: config.expectedBucketOwner,
      IfNoneMatch: "*",
      ServerSideEncryption: "AES256",
      ContentType: "audio/mpeg",
      ContentLength: master.length,
      ChecksumSHA256: Buffer.from(asset.sha256, "hex").toString("base64"),
    });
    expect(request.input).not.toHaveProperty("ACL");
    expect(request.input).not.toHaveProperty("WebsiteRedirectLocation");
    expect(request.input.Metadata).toEqual({ sha256: asset.sha256 });
    expect(asset.storageKey).not.toContain(input.originalName);
    await store.removeUnreferenced(asset);
    expect(transport.calls.at(-1)).toBeInstanceOf(DeleteObjectCommand);
    expect(transport.calls.at(-1)?.input).toMatchObject({
      IfMatch: '"test-etag"',
      ExpectedBucketOwner: config.expectedBucketOwner,
    });
    expect(transport.objects.size).toBe(0);
  });
  it("round trips all derived types and refuses overwrite even when bytes match", async () => {
    const transport = new MemoryS3();
    const store = createS3AssetStore(config, transport);
    for (const [name, bytes, mime] of [
      [
        "preview.mp4",
        Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]),
        "video/mp4",
      ],
      ["captions.vtt", Buffer.from("WEBVTT\n\n"), "text/vtt"],
      ["manifest.json", Buffer.from('{"schemaVersion":1}'), "application/json"],
    ] as const) {
      const asset = derived(name, bytes, mime);
      await store.writeDerivedDescriptor(asset, bytes);
      expect(await store.readDerivedDescriptor(asset)).toEqual(bytes);
      await expect(store.writeDerivedDescriptor(asset, bytes)).rejects.toThrow(
        "PreconditionFailed",
      );
      expect(await store.readDerivedDescriptor(asset)).toEqual(bytes);
      await store.removeDerivedUnreferenced(asset);
    }
    expect(transport.objects.size).toBe(0);
  });
  it("reads migrated multipart masters and previews with full byte verification", async () => {
    const transport = new MemoryS3();
    const store = createS3AssetStore(config, transport);
    const original = await store.write(input);
    const video = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
    const preview = derived("preview.mp4", video, "video/mp4");
    await store.writeDerivedDescriptor(preview, video);
    for (const [asset, expected, read, remove] of [
      [original, master, () => store.read(original), () => store.removeUnreferenced(original)],
      [
        preview,
        video,
        () => store.readDerivedDescriptor(preview),
        () => store.removeDerivedUnreferenced(preview),
      ],
    ] as const) {
      transport.responseOverride = {
        ChecksumType: "COMPOSITE",
        ChecksumSHA256: `${createHash("sha256").update("part hashes").digest("base64")}-5`,
        Metadata: { sha256: asset.sha256 },
      };
      expect(await read()).toEqual(expected);
      transport.responseOverride.Body = Readable.from([Buffer.alloc(expected.length, 65)]);
      await expect(remove()).rejects.toThrow("ASSET_INTEGRITY_FAILED");
      expect(transport.calls.some((command) => command instanceof DeleteObjectCommand)).toBe(false);
    }
  });
  it.each([
    { Metadata: undefined },
    { Metadata: { sha256: "0".repeat(64) } },
    { ChecksumSHA256: "wrong-5" },
    { ChecksumSHA256: `${"A".repeat(43)}=-0` },
    { ChecksumSHA256: `${"A".repeat(43)}=-10001` },
    { ChecksumType: "FULL_OBJECT" },
    { ChecksumType: undefined },
    { ChecksumType: "unknown" },
  ])("rejects unbound or malformed multipart checksums: %j", async (change) => {
    const transport = new MemoryS3();
    const store = createS3AssetStore(config, transport);
    const asset = await store.write(input);
    transport.responseOverride = {
      ChecksumType: "COMPOSITE",
      ChecksumSHA256: `${"A".repeat(43)}=-5`,
      Metadata: { sha256: asset.sha256 },
      ...change,
    };
    await expect(store.read(asset)).rejects.toThrow("ASSET_INTEGRITY_FAILED");
  });
  it("rejects foreign keys, invalid metadata and unbounded sizes before any request", async () => {
    const transport = new MemoryS3();
    const store = createS3AssetStore(config, transport);
    for (const change of [
      { storageKey: "../production/secret" },
      { storageKey: "distribution/renders/00000000-0000-0000-0000-000000000000/private.txt" },
      { storageKey: `${derived().storageKey}\n` },
      { byteSize: 1024 * 1024 + 1 },
      { mimeType: "text/html" },
      { sha256: "bad" },
      { sha256: `${"0".repeat(64)}\n` },
    ]) {
      const asset = { ...derived(), ...change };
      await expect(store.readDerivedDescriptor(asset)).rejects.toThrow("INVALID_DERIVED_ASSET");
      await expect(store.writeDerivedDescriptor(asset, Buffer.from("WEBVTT\n\n"))).rejects.toThrow(
        "INVALID_DERIVED_ASSET",
      );
      await expect(store.removeDerivedUnreferenced(asset)).rejects.toThrow("INVALID_DERIVED_ASSET");
    }
    await expect(store.write({ ...input, originalName: "../chant.mp3" })).rejects.toThrow(
      "INVALID_FILENAME",
    );
    await expect(store.write({ ...input, mimeType: "image/png" })).rejects.toThrow("INVALID_MEDIA");
    const invalidMedia = Buffer.from("bad vtt!");
    await expect(
      store.writeDerivedDescriptor(derived("captions.vtt", invalidMedia), invalidMedia),
    ).rejects.toThrow("INVALID_DERIVED_MEDIA");
    expect(transport.calls).toHaveLength(0);
  });
  it.each([
    ["length", { ContentLength: 1 }],
    ["MIME", { ContentType: "text/html" }],
    ["encryption", { ServerSideEncryption: undefined }],
    ["checksum", { ChecksumSHA256: "wrong" }],
    ["encoding", { ContentEncoding: "gzip" }],
    ["ETag", { ETag: "*" }],
  ])("refuses bad %s before streaming or deleting", async (_, change) => {
    const transport = new MemoryS3();
    const store = createS3AssetStore(config, transport);
    const asset = await store.write(input);
    const body = Readable.from([master]);
    transport.responseOverride = { ...change, Body: body };
    await expect(store.removeUnreferenced(asset)).rejects.toThrow("ASSET_INTEGRITY_FAILED");
    expect(body.destroyed).toBe(true);
    expect(transport.calls.some((command) => command instanceof DeleteObjectCommand)).toBe(false);
  });
  it.each(["truncated", "overflow", "tampered", "string"])(
    'bounds and verifies a "%s" response body despite advertised size',
    async (kind) => {
      const transport = new MemoryS3();
      const store = createS3AssetStore(config, transport);
      const asset = await store.write(input);
      const value =
        kind === "truncated"
          ? master.subarray(0, 4)
          : kind === "overflow"
            ? Buffer.concat([master, Buffer.from("x")])
            : kind === "tampered"
              ? Buffer.alloc(master.length, 65)
              : "string body";
      transport.responseOverride = { Body: Readable.from([value]) };
      await expect(store.read(asset)).rejects.toThrow("ASSET_INTEGRITY_FAILED");
    },
  );
  it("revalidates media signatures even if a malicious object and descriptor agree on the hash", async () => {
    const transport = new MemoryS3();
    const store = createS3AssetStore(config, transport);
    const asset = await store.write(input);
    const bad = Buffer.alloc(master.length, 65);
    const sha256 = createHash("sha256").update(bad).digest("hex");
    const entry = transport.objects.get(`test/${asset.storageKey}`) as ObjectData;
    entry.bytes = bad;
    entry.checksum = Buffer.from(sha256, "hex").toString("base64");
    await expect(store.read({ ...asset, sha256 })).rejects.toThrow("INVALID_MEDIA");
  });
  it("aborts a stalled command after the common deadline without fallback or cleanup writes", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const send = vi.fn((_command: S3AssetCommand, options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise<never>(() => {});
    });
    const store = createAssetStore(
      { ...env, DISTRIBUTION_ASSET_ROOT: "/never/use/local" },
      { send },
    );
    const failure = expect(store.write(input)).rejects.toThrow("ASSET_STORAGE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(S3_ASSET_TIMEOUT_MS + 1);
    await failure;
    expect(signal?.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("bounds a stalled response stream and destroys it on timeout", async () => {
    vi.useFakeTimers();
    const transport = new MemoryS3();
    const store = createS3AssetStore(config, transport);
    const asset = await store.write(input);
    const body = new Readable({ read() {} });
    transport.responseOverride = { Body: body };
    const failure = expect(store.read(asset)).rejects.toThrow("ASSET_STORAGE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(S3_ASSET_TIMEOUT_MS + 1);
    await failure;
    expect(body.destroyed).toBe(true);
  });
  it("conditionally refuses rollback if the object changed after its verified read", async () => {
    const transport = new MemoryS3();
    const store = createS3AssetStore(config, transport);
    const asset = await store.write(input);
    const originalSend = transport.send.bind(transport);
    transport.send = async (command) => {
      if (command instanceof DeleteObjectCommand)
        (transport.objects.get(`test/${asset.storageKey}`) as ObjectData).etag = '"new-etag"';
      return originalSend(command);
    };
    await expect(store.removeUnreferenced(asset)).rejects.toThrow("PreconditionFailed");
    expect(transport.objects.size).toBe(1);
  });
});

describe("asset backend configuration", () => {
  it("retains local defaults and strictly validates explicit S3 stage, world and owner", () => {
    expect(parseAssetStoreConfig({ DISTRIBUTION_ASSET_ROOT: "/private/tmp/assets" })).toEqual({
      backend: "local",
      root: "/private/tmp/assets",
    });
    expect(parseAssetStoreConfig(env)).toEqual({ backend: "s3", ...config });
    for (const stage of ["LIMITED", "ON"])
      expect(
        parseAssetStoreConfig({
          ...env,
          DISTRIBUTION_HUB_STAGE: stage,
          DISTRIBUTION_S3_PREFIX: "production/",
        }),
      ).toMatchObject({ prefix: "production/" });
    for (const stage of [undefined, "OFF", "PRODUCTION", "test", "invalid"])
      expect(() => parseAssetStoreConfig({ ...env, DISTRIBUTION_HUB_STAGE: stage })).toThrow(
        "INVALID_S3_ASSET_WORLD",
      );
    for (const prefix of [
      undefined,
      "",
      "production/",
      "test/../production/",
      "/test/",
      "test/custom/",
    ])
      expect(() => parseAssetStoreConfig({ ...env, DISTRIBUTION_S3_PREFIX: prefix })).toThrow(
        "INVALID_S3_ASSET_WORLD",
      );
    expect(() => parseAssetStoreConfig({ ...env, DISTRIBUTION_HUB_STAGE: "ON" })).toThrow(
      "INVALID_S3_ASSET_WORLD",
    );
    for (const change of [
      { DISTRIBUTION_S3_BUCKET: undefined },
      { DISTRIBUTION_S3_BUCKET: "https://bucket" },
      { DISTRIBUTION_S3_BUCKET: "unsafe--x-s3" },
      { DISTRIBUTION_S3_BUCKET: `${config.bucket}\n` },
      { DISTRIBUTION_S3_REGION: "" },
      { DISTRIBUTION_S3_REGION: `${config.region}\n` },
      { DISTRIBUTION_S3_EXPECTED_BUCKET_OWNER: "" },
      { DISTRIBUTION_S3_EXPECTED_BUCKET_OWNER: "12345678901" },
      { DISTRIBUTION_S3_EXPECTED_BUCKET_OWNER: `${config.expectedBucketOwner}\n` },
    ])
      expect(() =>
        createAssetStore(
          { ...env, ...change, DISTRIBUTION_ASSET_ROOT: "/private/tmp/fallback" },
          new MemoryS3(),
        ),
      ).toThrow("INVALID_S3_ASSET_CONFIG");
    expect(() => parseAssetStoreConfig({ DISTRIBUTION_ASSET_BACKEND: "unknown" })).toThrow(
      "INVALID_ASSET_BACKEND",
    );
    expect(() => parseAssetStoreConfig({})).toThrow("ASSETS_NOT_CONFIGURED");
  });
  it("copies configuration so external mutation cannot redirect requests", async () => {
    const transport = new MemoryS3();
    const mutable = { ...config };
    const store = createS3AssetStore(mutable, transport);
    mutable.bucket = "foreign-bucket";
    await store.write(input);
    expect(transport.calls[0]?.input.Bucket).toBe(config.bucket);
  });
});

describe("actual AWS SDK request serialization through an in-memory handler", () => {
  it("signs private encrypted conditional writes and owner-bound verified reads/deletes without network", async () => {
    type Request = {
      method: string;
      hostname: string;
      path: string;
      headers: Record<string, string>;
      body?: unknown;
    };
    const requests: Request[] = [];
    let bytes = Buffer.alloc(0);
    let mime = "";
    let sum = "";
    const client = new S3Client({
      region: config.region,
      maxAttempts: 1,
      credentials: {
        accessKeyId: "AKIDEXAMPLETESTONLY",
        secretAccessKey: "fixture-secret-not-an-aws-credential",
      },
      requestHandler: {
        async handle(request: Request) {
          requests.push(request);
          if (request.method === "PUT") {
            bytes = Buffer.from(request.body as Uint8Array);
            mime = request.headers["content-type"] as string;
            sum = request.headers["x-amz-checksum-sha256"] as string;
          }
          return {
            response: {
              statusCode: request.method === "DELETE" ? 204 : 200,
              headers:
                request.method === "GET"
                  ? {
                      "content-type": mime,
                      "content-length": String(bytes.length),
                      "x-amz-server-side-encryption": "AES256",
                      "x-amz-checksum-sha256": sum,
                      etag: '"wire-etag"',
                    }
                  : {},
              body: Readable.from(request.method === "GET" ? [bytes] : []),
            },
          };
        },
      },
    });
    try {
      const store = createS3AssetStore(config, client);
      const asset = await store.write(input);
      expect(await store.read(asset)).toEqual(master);
      await store.removeUnreferenced(asset);
      expect(requests.map((request) => request.method)).toEqual(["PUT", "GET", "GET", "DELETE"]);
      for (const request of requests) {
        expect(request.hostname).toBe("distribution-assets-test.s3.us-east-1.amazonaws.com");
        expect(request.path).toBe(`/test/${asset.storageKey}`);
        expect(request.headers["x-amz-expected-bucket-owner"]).toBe(config.expectedBucketOwner);
        expect(request.headers.authorization).toMatch(
          /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLETESTONLY\//,
        );
        expect(request.headers["x-amz-acl"]).toBeUndefined();
      }
      expect(requests[0]?.headers).toMatchObject({
        "if-none-match": "*",
        "x-amz-server-side-encryption": "AES256",
        "x-amz-checksum-sha256": Buffer.from(asset.sha256, "hex").toString("base64"),
      });
      expect(requests.at(-1)?.headers["if-match"]).toBe('"wire-etag"');
    } finally {
      client.destroy();
    }
  });
});

it("reads and removes an immutable shared media object with checksum and package binding", async () => {
  const transport = new MemoryS3();
  const store = createS3AssetStore(config, transport);
  const bytes = Buffer.from("0000ftyp0000shared-video");
  const name = studioAssetName(
    {
      masterId: randomUUID(),
      sourceVersionId: randomUUID(),
      packageId: randomUUID(),
      outputId: randomUUID(),
      channel: "youtube",
      format: "short",
      language: "en",
      aspect: "9:16",
    },
    "mp4",
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  const asset = {
    storageKey: studioSharedAssetKey(name.storageKey, hash),
    sha256: hash,
    byteSize: bytes.length,
    mimeType: "video/mp4",
  };
  await store.writeDerivedDescriptor(asset, bytes);
  expect(await store.readDerivedDescriptor(asset)).toEqual(bytes);
  await expect(store.readDerivedDescriptor({ ...asset, sha256: "b".repeat(64) })).rejects.toThrow(
    "INVALID_DERIVED_ASSET",
  );
  expect(transport.objects.size).toBe(1);
  await store.removeDerivedUnreferenced(asset);
  expect(transport.objects.size).toBe(0);
});

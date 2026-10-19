import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { MAX_ONLINE_MASTER_BYTES, validateMasterUpload } from "@satsang/distribution-domain";
import { copyVerifiedMaster, inspectMasterFile } from "./master-files";
import {
  type DerivedPrivateAsset,
  type PrivateAssetStore,
  type StoredPrivateAsset,
  checksum,
  validateAsset,
  validateDerived,
  validateDerivedBytes,
  validateFilename,
  verifyBytes,
} from "./validation";

export type S3AssetConfig = {
  bucket: string;
  region: string;
  expectedBucketOwner: string;
  prefix: "test/" | "production/";
};
export type S3AssetCommand = GetObjectCommand | PutObjectCommand | DeleteObjectCommand;
/** The production implementation is the AWS SDK; test transports must never call AWS. */
export type S3Transport = {
  send(command: S3AssetCommand, options: { abortSignal: AbortSignal }): Promise<unknown>;
};
export const S3_ASSET_TIMEOUT_MS = 30_000;
const sdkClients = new Map<string, S3Client>();

function sharedClient(region: string, large = false): S3Client {
  const key = `${region}:${large}`;
  const existing = sdkClients.get(key);
  if (existing) return existing;
  // One pool per configured region, never one pool per HTTP request. Configuration is
  // deployment-owned; a hard bound prevents accidental unlimited runtime reconfiguration.
  if (sdkClients.size >= 8) throw new Error("S3_ASSET_CLIENT_LIMIT");
  const client = new S3Client({
    region,
    maxAttempts: 3,
    followRegionRedirects: false,
    ignoreConfiguredEndpointUrls: true,
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: large ? 30 * 60 * 1000 : S3_ASSET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
  sdkClients.set(key, client);
  return client;
}

export function validateS3AssetConfig(config: S3AssetConfig): void {
  if (
    typeof config.bucket !== "string" ||
    config.bucket.trim() !== config.bucket ||
    typeof config.region !== "string" ||
    config.region.trim() !== config.region ||
    typeof config.expectedBucketOwner !== "string" ||
    config.expectedBucketOwner.length !== 12 ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    /^(?:xn--|sthree-|amzn-s3-demo-)/.test(config.bucket) ||
    /(?:-s3alias|--ol-s3|--x-s3|--table-s3)$/.test(config.bucket) ||
    !/^[a-z]{2}(?:-[a-z]+){1,3}-[1-9][0-9]?$/.test(config.region) ||
    !/^[0-9]{12}$/.test(config.expectedBucketOwner) ||
    !["test/", "production/"].includes(config.prefix)
  )
    throw new Error("INVALID_S3_ASSET_CONFIG");
}

function aborted(): Error {
  return new Error("ASSET_STORAGE_TIMEOUT");
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw aborted();
  let listener: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    listener = () => reject(aborted());
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([work, cancellation]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeout = S3_ASSET_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await abortable(work(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
function destroyBody(body: unknown): void {
  if (body && typeof body === "object" && "destroy" in body && typeof body.destroy === "function") {
    body.destroy();
  }
}
async function readBody(body: unknown, byteSize: number, signal: AbortSignal): Promise<Buffer> {
  if (
    !body ||
    typeof body !== "object" ||
    !(Symbol.asyncIterator in body) ||
    typeof body[Symbol.asyncIterator] !== "function"
  ) {
    throw new Error("ASSET_INTEGRITY_FAILED");
  }
  const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const bytes = Buffer.alloc(byteSize);
  let offset = 0;
  try {
    while (true) {
      const part = await abortable(iterator.next(), signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > byteSize - offset) {
        throw new Error("ASSET_INTEGRITY_FAILED");
      }
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
    if (offset !== byteSize) throw new Error("ASSET_INTEGRITY_FAILED");
    return bytes;
  } finally {
    destroyBody(body);
    // Never await a stalled iterator's cleanup: the same deadline bounds stream consumption.
    if (iterator.return) void iterator.return().catch(() => undefined);
  }
}

/** Private, immutable objects only. Descriptor keys are independent of deployment storage. */
export function createS3AssetStore(
  input: S3AssetConfig,
  injected?: S3Transport,
): PrivateAssetStore {
  const config = { ...input };
  validateS3AssetConfig(config);
  const client: S3Transport = injected ?? sharedClient(config.region);
  const target = (asset: DerivedPrivateAsset) => ({
    Bucket: config.bucket,
    Key: `${config.prefix}${asset.storageKey}`,
    ExpectedBucketOwner: config.expectedBucketOwner,
  });
  async function send(command: S3AssetCommand, signal: AbortSignal) {
    const response = client.send(command, { abortSignal: signal }).then((value) => {
      // A transport that resolves after cancellation must still release its response stream.
      if (signal.aborted && value && typeof value === "object" && "Body" in value)
        destroyBody(value.Body);
      return value;
    });
    return abortable(response, signal);
  }
  async function writeVerified(asset: DerivedPrivateAsset, bytes: Buffer) {
    await bounded((signal) =>
      send(
        new PutObjectCommand({
          ...target(asset),
          Body: bytes,
          ContentType: asset.mimeType,
          ContentLength: bytes.length,
          ServerSideEncryption: "AES256",
          ChecksumSHA256: Buffer.from(asset.sha256, "hex").toString("base64"),
          IfNoneMatch: "*",
          Metadata: { sha256: asset.sha256 },
        }),
        signal,
      ),
    );
  }
  function validateResponse(response: GetObjectCommandOutput, asset: DerivedPrivateAsset) {
    // Multipart SHA-256 is a checksum of part checksums, not the whole-file digest.
    // Bind migrated multipart objects to the descriptor via protected metadata; both
    // readVerified and streamMaster still hash every byte before returning or deleting.
    const composite = response.ChecksumType === "COMPOSITE";
    const validChecksum = composite
      ? /^[A-Za-z0-9+/]{43}=-(?:[1-9][0-9]{0,3}|10000)$/.test(response.ChecksumSHA256 ?? "") &&
        response.Metadata?.sha256 === asset.sha256
      : (response.ChecksumType === undefined || response.ChecksumType === "FULL_OBJECT") &&
        response.ChecksumSHA256 === Buffer.from(asset.sha256, "hex").toString("base64");
    if (
      response.ContentLength !== asset.byteSize ||
      response.ContentType !== asset.mimeType ||
      (response.ContentEncoding !== undefined && response.ContentEncoding !== "identity") ||
      response.ServerSideEncryption !== "AES256" ||
      !validChecksum ||
      !response.ETag ||
      response.ETag !== response.ETag.trim() ||
      !/^"[A-Za-z0-9-]+"$/.test(response.ETag) ||
      response.ETag.length > 256
    )
      throw new Error("ASSET_INTEGRITY_FAILED");
  }
  async function streamMaster(asset: StoredPrivateAsset, destination?: string) {
    return bounded(
      async (signal) => {
        const largeClient = injected ?? sharedClient(config.region, true);
        const response = (await abortable(
          largeClient.send(new GetObjectCommand({ ...target(asset), ChecksumMode: "ENABLED" }), {
            abortSignal: signal,
          }),
          signal,
        )) as GetObjectCommandOutput;
        try {
          validateResponse(response, asset);
          if (!response.Body || !(Symbol.asyncIterator in response.Body))
            throw Error("ASSET_INTEGRITY_FAILED");
          await abortable(
            copyVerifiedMaster(response.Body as AsyncIterable<unknown>, asset, destination),
            signal,
          );
          return response.ETag;
        } finally {
          destroyBody(response.Body);
        }
      },
      30 * 60 * 1000,
    );
  }
  async function readVerified(asset: DerivedPrivateAsset, derived: boolean, signal: AbortSignal) {
    const response = (await send(
      new GetObjectCommand({ ...target(asset), ChecksumMode: "ENABLED" }),
      signal,
    )) as GetObjectCommandOutput;
    try {
      validateResponse(response, asset);
      const bytes = await readBody(response.Body, asset.byteSize, signal);
      verifyBytes(bytes, asset);
      if (derived) validateDerivedBytes(bytes, asset.mimeType);
      else
        validateMasterUpload(
          {
            byteSize: bytes.length,
            mimeType: asset.mimeType,
            signature: bytes.subarray(0, 32),
          },
          MAX_ONLINE_MASTER_BYTES,
        );
      return { bytes, etag: response.ETag };
    } finally {
      destroyBody(response.Body);
    }
  }
  async function removeVerified(asset: DerivedPrivateAsset, derived: boolean) {
    await bounded(async (signal) => {
      const { etag } = await readVerified(asset, derived, signal);
      await send(new DeleteObjectCommand({ ...target(asset), IfMatch: etag }), signal);
    });
  }
  return {
    async writeFile(input) {
      validateFilename(input.originalName);
      const info = await inspectMasterFile(input.path, input.mimeType);
      const asset = {
        ...info,
        storageKey: `distribution/masters/${randomUUID()}`,
        mimeType: input.mimeType,
        originalName: input.originalName,
      };
      validateAsset(asset);
      const file = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const body = file.createReadStream({ autoClose: false });
      try {
        await bounded(
          (signal) =>
            abortable(
              (injected ?? sharedClient(config.region, true)).send(
                new PutObjectCommand({
                  ...target(asset),
                  Body: body,
                  ContentType: asset.mimeType,
                  ContentLength: asset.byteSize,
                  ServerSideEncryption: "AES256",
                  ChecksumSHA256: Buffer.from(asset.sha256, "hex").toString("base64"),
                  IfNoneMatch: "*",
                  Metadata: { sha256: asset.sha256 },
                }),
                { abortSignal: signal },
              ),
              signal,
            ),
          30 * 60 * 1000,
        );
      } finally {
        body.destroy();
        await file.close();
      }
      return asset;
    },
    async readRange(asset, start, end) {
      validateAsset(asset);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end >= asset.byteSize ||
        end - start >= 8 * 1024 * 1024
      )
        throw Error("INVALID_ASSET_RANGE");
      return bounded(async (signal) => {
        const response = (await send(
          new GetObjectCommand({ ...target(asset), Range: `bytes=${start}-${end}` }),
          signal,
        )) as GetObjectCommandOutput;
        try {
          // S3 validates the full SHA-256 on our immutable conditional PUT. A range cannot
          // carry that full checksum, so bind it to the object's protected SHA metadata.
          if (
            response.ContentLength !== end - start + 1 ||
            response.ContentRange !== `bytes ${start}-${end}/${asset.byteSize}` ||
            response.ContentType !== asset.mimeType ||
            response.ServerSideEncryption !== "AES256" ||
            response.Metadata?.sha256 !== asset.sha256 ||
            (response.ContentEncoding !== undefined && response.ContentEncoding !== "identity")
          )
            throw Error("ASSET_INTEGRITY_FAILED");
          return await readBody(response.Body, end - start + 1, signal);
        } finally {
          destroyBody(response.Body);
        }
      });
    },
    async materialize(asset, destination) {
      validateAsset(asset);
      await streamMaster(asset, destination);
    },
    async write(input): Promise<StoredPrivateAsset> {
      validateFilename(input.originalName);
      if (!(input.bytes instanceof Uint8Array)) throw new Error("INVALID_MEDIA");
      const mimeType = validateMasterUpload({
        byteSize: input.bytes.byteLength,
        mimeType: input.mimeType,
        signature: input.bytes.subarray(0, 32),
      });
      const bytes = Buffer.from(input.bytes);
      const asset = {
        storageKey: `distribution/masters/${randomUUID()}`,
        sha256: checksum(bytes),
        byteSize: bytes.length,
        mimeType,
        originalName: input.originalName,
      };
      await writeVerified(asset, bytes);
      return asset;
    },
    async read(descriptor) {
      const asset = { ...descriptor };
      validateAsset(asset);
      return bounded(async (signal) => (await readVerified(asset, false, signal)).bytes);
    },
    async readDerivedDescriptor(descriptor) {
      const asset = { ...descriptor };
      validateDerived(asset);
      return bounded(async (signal) => (await readVerified(asset, true, signal)).bytes);
    },
    async writeDerivedDescriptor(descriptor, input) {
      const asset = { ...descriptor };
      validateDerived(asset);
      if (!(input instanceof Uint8Array) || input.byteLength !== asset.byteSize)
        throw new Error("ASSET_INTEGRITY_FAILED");
      const bytes = Buffer.from(input);
      verifyBytes(bytes, asset);
      validateDerivedBytes(bytes, asset.mimeType);
      await writeVerified(asset, bytes);
    },
    /** Internal rollback only; caller must prove the metadata transaction did not commit. */
    async removeUnreferenced(descriptor) {
      const asset = { ...descriptor };
      validateAsset(asset);
      const etag = await streamMaster(asset);
      await bounded((signal) =>
        send(new DeleteObjectCommand({ ...target(asset), IfMatch: etag }), signal),
      );
    },
    async removeDerivedUnreferenced(descriptor) {
      const asset = { ...descriptor };
      validateDerived(asset);
      await removeVerified(asset, true);
    },
  };
}

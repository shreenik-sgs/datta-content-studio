import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { AssetStoreConfig } from "./index";
import { validateS3AssetConfig } from "./s3";
import { checksum } from "./validation";
const LIMIT = 32 * 1024 * 1024;
export type LiveFragmentDescriptor = { key: string; sha256: string; byteSize: number };
function key(value: string) {
  if (!/^distribution\/live\/[a-f0-9-]{36}\/[0-9]{1,15}\.ts$/.test(value))
    throw Error("INVALID_LIVE_FRAGMENT");
  return value;
}
function verify(bytes: Buffer, asset: LiveFragmentDescriptor) {
  if (bytes.length !== asset.byteSize || checksum(bytes) !== asset.sha256)
    throw Error("LIVE_FRAGMENT_CHANGED");
  return bytes;
}
/** Private short-lived capture bytes. They are never exposed as curator-visible master versions. */
export function createLiveFragmentStore(config: AssetStoreConfig) {
  if (config.backend === "s3") validateS3AssetConfig(config);
  const client =
    config.backend === "s3"
      ? new S3Client({
          region: config.region,
          maxAttempts: 2,
          followRegionRedirects: false,
          ignoreConfiguredEndpointUrls: true,
        })
      : null;
  if (
    config.backend === "local" &&
    (!isAbsolute(config.root) || resolve(config.root) !== config.root)
  )
    throw Error("INVALID_ASSET_ROOT");
  async function folder(path: string) {
    if (config.backend !== "local") throw Error("INVALID_ASSET_BACKEND");
    let current = config.root;
    for (const part of ["", ...path.split("/").slice(0, -1)]) {
      if (part) current = join(current, part);
      await mkdir(current, { mode: 0o700 }).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("INVALID_ASSET_ROOT");
    }
  }
  async function read(asset: LiveFragmentDescriptor) {
    key(asset.key);
    if (
      !Number.isSafeInteger(asset.byteSize) ||
      asset.byteSize < 1 ||
      asset.byteSize > LIMIT ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    )
      throw Error("INVALID_LIVE_FRAGMENT");
    if (config.backend === "s3" && client) {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: config.prefix + asset.key,
          ExpectedBucketOwner: config.expectedBucketOwner,
        }),
        { abortSignal: AbortSignal.timeout(30000) },
      );
      if (result.ContentLength !== asset.byteSize || !result.Body)
        throw Error("LIVE_FRAGMENT_CHANGED");
      return verify(Buffer.from(await result.Body.transformToByteArray()), asset);
    }
    if (config.backend !== "local") throw Error("INVALID_ASSET_BACKEND");
    await folder(asset.key);
    const file = await open(
      join(config.root, asset.key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if ((await file.stat()).size !== asset.byteSize) throw Error("LIVE_FRAGMENT_CHANGED");
      return verify(await file.readFile(), asset);
    } finally {
      await file.close();
    }
  }
  return {
    read,
    write: async (path: string, bytes: Buffer): Promise<LiveFragmentDescriptor> => {
      key(path);
      if (!bytes.length || bytes.length > LIMIT || bytes[0] !== 0x47)
        throw Error("INVALID_LIVE_FRAGMENT");
      const asset = { key: path, byteSize: bytes.length, sha256: checksum(bytes) };
      try {
        if (config.backend === "s3" && client)
          await client.send(
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: config.prefix + path,
              ExpectedBucketOwner: config.expectedBucketOwner,
              Body: bytes,
              ContentLength: bytes.length,
              ContentType: "video/mp2t",
              ServerSideEncryption: "AES256",
              IfNoneMatch: "*",
            }),
            { abortSignal: AbortSignal.timeout(30000) },
          );
        else if (config.backend === "local") {
          const target = join(config.root, path);
          await folder(path);
          const temporary = join(dirname(target), `.capture-${randomUUID()}.tmp`);
          const file = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await file.writeFile(bytes);
            await file.sync();
            // Publish only complete bytes. link is atomic and never overwrites an existing sequence.
            await link(temporary, target);
          } finally {
            await file.close();
            await unlink(temporary).catch(() => undefined);
          }
        }
      } catch (error) {
        const e = error as { code?: string; name?: string };
        if (e.code !== "EEXIST" && e.name !== "PreconditionFailed") throw error;
        await read(asset);
      }
      return asset;
    },
    remove: async (asset: LiveFragmentDescriptor) => {
      key(asset.key);
      if (config.backend === "s3" && client)
        await client.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: config.prefix + asset.key,
            ExpectedBucketOwner: config.expectedBucketOwner,
          }),
          { abortSignal: AbortSignal.timeout(30000) },
        );
      else if (config.backend === "local") {
        await folder(asset.key);
        await unlink(join(config.root, asset.key)).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      }
    },
    close: () => client?.destroy(),
  };
}

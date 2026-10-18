import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { MAX_MASTER_BYTES, MAX_ONLINE_MASTER_BYTES } from "@satsang/distribution-domain";
import { expect, it } from "vitest";
import { createPrivateAssetStore } from "./local";
import { inspectMasterFile } from "./master-files";
import { type S3Transport, createS3AssetStore } from "./s3";

it("stores and materializes a complete 300 MB online recording without the browser upload cap", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hub-large-master-")));
  try {
    const path = join(root, "source.mp4");
    const file = await open(path, "wx", 0o600);
    await file.write(Buffer.from("0000ftypisom0000"));
    await file.truncate(300 * 1024 * 1024);
    await file.close();
    const store = createPrivateAssetStore(join(root, "private"));
    const descriptor = await store.writeFile?.({
      path,
      mimeType: "video/mp4",
      originalName: "complete.mp4",
    });
    if (!descriptor) throw Error("missing streaming writer");
    expect(descriptor.byteSize).toBeGreaterThan(MAX_MASTER_BYTES);
    expect((await store.readRange?.(descriptor, 0, 15))?.toString()).toBe("0000ftypisom0000");
    expect(
      (await store.readRange?.(descriptor, descriptor.byteSize - 8, descriptor.byteSize - 1))
        ?.length,
    ).toBe(8);
    await expect(store.readRange?.(descriptor, 0, 9 * 1024 * 1024)).rejects.toThrow(
      "INVALID_ASSET_RANGE",
    );
    const destination = join(root, "staged.mp4");
    await store.materialize?.(descriptor, destination);
    expect(await inspectMasterFile(destination, "video/mp4")).toEqual({
      byteSize: descriptor.byteSize,
      sha256: descriptor.sha256,
    });
    expect((await stat(destination)).mode & 0o077).toBe(0);
    const corrupt = join(root, "corrupt.mp4");
    await expect(
      store.materialize?.({ ...descriptor, sha256: "a".repeat(64) }, corrupt),
    ).rejects.toThrow("ASSET_INTEGRITY_FAILED");
    await expect(stat(corrupt)).rejects.toMatchObject({ code: "ENOENT" });
    await store.removeUnreferenced(descriptor);
    await expect(stat(join(root, "private", descriptor.storageKey))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const oversized = await open(path, "r+");
    await oversized.truncate(MAX_ONLINE_MASTER_BYTES + 1);
    await oversized.close();
    await expect(
      store.writeFile?.({ path, mimeType: "video/mp4", originalName: "too-big.mp4" }),
    ).rejects.toThrow("UPLOAD_TOO_LARGE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("streams private S3 masters with integrity and conditional writes, and removes partial materializations", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hub-s3-stream-")));
  let stored: { bytes: Buffer; checksum: string; type: string } | undefined;
  const transport: S3Transport = {
    send: async (command) => {
      if (command instanceof PutObjectCommand) {
        expect(command.input.Body).toBeInstanceOf(Readable);
        expect(command.input.IfNoneMatch).toBe("*");
        expect(command.input.ServerSideEncryption).toBe("AES256");
        const parts: Buffer[] = [];
        for await (const part of command.input.Body as Readable) parts.push(part);
        stored = {
          bytes: Buffer.concat(parts),
          checksum: command.input.ChecksumSHA256 as string,
          type: command.input.ContentType as string,
        };
        return {};
      }
      if (!(command instanceof GetObjectCommand) || !stored) throw Error("unexpected command");
      const range = command.input.Range ? /^bytes=(\d+)-(\d+)$/.exec(command.input.Range) : null;
      const rangeBytes = range
        ? stored.bytes.subarray(Number(range[1]), Number(range[2]) + 1)
        : stored.bytes;
      return {
        Body: Readable.from([rangeBytes]),
        Metadata: { sha256: Buffer.from(stored.checksum, "base64").toString("hex") },
        ...(range ? { ContentRange: `bytes ${range[1]}-${range[2]}/${stored.bytes.length}` } : {}),
        ContentLength: rangeBytes.length,
        ContentType: stored.type,
        ChecksumSHA256: stored.checksum,
        ServerSideEncryption: "AES256",
        ETag: '"stream-test"',
      };
    },
  };
  try {
    const store = createS3AssetStore(
      {
        bucket: "private-test-assets",
        region: "ap-south-1",
        expectedBucketOwner: "123456789012",
        prefix: "test/",
      },
      transport,
    );
    const path = join(root, "source.mp4");
    const bytes = Buffer.from(`0000ftypisom${randomUUID()}`);
    await writeFile(path, bytes);
    const asset = await store.writeFile?.({
      path,
      mimeType: "video/mp4",
      originalName: "source.mp4",
    });
    if (!asset || !stored) throw Error("missing asset");
    expect(await store.readRange?.(asset, 0, 15)).toEqual(bytes.subarray(0, 16));
    await expect(store.readRange?.({ ...asset, sha256: "a".repeat(64) }, 0, 15)).rejects.toThrow(
      "ASSET_INTEGRITY_FAILED",
    );
    const destination = join(root, "verified.mp4");
    await store.materialize?.(asset, destination);
    expect(await readFile(destination)).toEqual(bytes);
    stored.bytes[stored.bytes.length - 1] = (stored.bytes[stored.bytes.length - 1] ?? 0) ^ 1;
    const corrupt = join(root, "corrupt.mp4");
    await expect(store.materialize?.(asset, corrupt)).rejects.toThrow("ASSET_INTEGRITY_FAILED");
    await expect(stat(corrupt)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

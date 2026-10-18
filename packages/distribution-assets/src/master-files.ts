import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { MAX_ONLINE_MASTER_BYTES, validateMasterUpload } from "@satsang/distribution-domain";
import type { StoredPrivateAsset } from "./validation";

/** Bounded-memory master verification; source paths are worker-owned temporary files. */
export async function inspectMasterFile(path: string, mimeType: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_ONLINE_MASTER_BYTES) throw Error("UPLOAD_TOO_LARGE");
    const signature = Buffer.alloc(32);
    const head = await file.read(signature, 0, 32, 0);
    validateMasterUpload(
      { byteSize: info.size, mimeType, signature: signature.subarray(0, head.bytesRead) },
      MAX_ONLINE_MASTER_BYTES,
    );
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
      size += chunk.length;
      if (size > info.size) throw Error("ASSET_INTEGRITY_FAILED");
      hash.update(chunk);
    }
    if (size !== info.size) throw Error("ASSET_INTEGRITY_FAILED");
    return { byteSize: size, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

export async function copyVerifiedMaster(
  source: AsyncIterable<unknown>,
  asset: StoredPrivateAsset,
  destination?: string,
) {
  const file = destination
    ? await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
    : null;
  let complete = false;
  try {
    const hash = createHash("sha256");
    let size = 0;
    let signature = Buffer.alloc(0);
    for await (const part of source) {
      if (!(part instanceof Uint8Array) || part.byteLength > asset.byteSize - size)
        throw Error("ASSET_INTEGRITY_FAILED");
      if (signature.length < 32)
        signature = Buffer.concat([signature, part.subarray(0, 32 - signature.length)]);
      hash.update(part);
      size += part.byteLength;
      if (file) {
        let offset = 0;
        while (offset < part.byteLength) {
          const written = await file.write(part, offset, part.byteLength - offset);
          if (!written.bytesWritten) throw Error("ASSET_INTEGRITY_FAILED");
          offset += written.bytesWritten;
        }
      }
    }
    if (
      size !== asset.byteSize ||
      !timingSafeEqual(hash.digest(), Buffer.from(asset.sha256, "hex"))
    )
      throw Error("ASSET_INTEGRITY_FAILED");
    validateMasterUpload(
      { byteSize: size, mimeType: asset.mimeType, signature },
      MAX_ONLINE_MASTER_BYTES,
    );
    if (file) await file.sync();
    complete = true;
  } finally {
    await file?.close();
    if (destination && !complete) await unlink(destination).catch(() => undefined);
  }
}

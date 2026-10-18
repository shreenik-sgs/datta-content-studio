import type { ExportManifest } from "@satsang/distribution-contracts";
import {
  type DerivedAssetNamingInput,
  type MasterMimeType,
  buildDerivedAssetNames,
  buildMasterAssetNames,
} from "@satsang/distribution-domain";

const mediaExtension: Record<MasterMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
};

/** POSIX ustar, bounded safe entry names; no shell, archive dependency or input path. */
function entryHeader(name: string, size: number): Buffer {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)) throw new Error("INVALID_DERIVED_ASSET");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  header.write("0000600\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}
function entry(name: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    entryHeader(name, bytes.length),
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512),
  ]);
}
export function exportArchive(bytes: Buffer, manifest: ExportManifest): Buffer {
  const names = buildMasterAssetNames({
    masterId: manifest.content.id,
    versionNumber: manifest.content.currentVersion.number,
  });
  return Buffer.concat([
    entry(`${names.stem}.${mediaExtension[manifest.content.currentVersion.mimeType]}`, bytes),
    entry(names.manifest, Buffer.from(JSON.stringify(manifest, null, 2))),
    Buffer.alloc(1024),
  ]);
}

/** Stream large masters in the same archive format with bounded memory. */
export function exportMasterArchiveStream(
  read: (start: number, end: number) => Promise<Uint8Array>,
  manifest: ExportManifest,
) {
  const version = manifest.content.currentVersion;
  const names = buildMasterAssetNames({
    masterId: manifest.content.id,
    versionNumber: version.number,
  });
  async function* chunks() {
    yield entryHeader(`${names.stem}.${mediaExtension[version.mimeType]}`, version.byteSize);
    for (let start = 0; start < version.byteSize; start += 8 * 1024 * 1024)
      yield await read(start, Math.min(version.byteSize - 1, start + 8 * 1024 * 1024 - 1));
    yield Buffer.alloc((512 - (version.byteSize % 512)) % 512);
    yield entry(names.manifest, Buffer.from(JSON.stringify(manifest, null, 2)));
    yield Buffer.alloc(1024);
  }
  const iterator = chunks();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await iterator.next();
        if (part.done) controller.close();
        else controller.enqueue(part.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return();
    },
  });
}

/** Explicit derivative allow-list; filenames cannot be supplied by a caller. */
export function derivativeArchive(input: {
  naming: DerivedAssetNamingInput;
  video: Buffer;
  captions: Buffer | null;
  manifest: Buffer;
}): Buffer {
  const names = buildDerivedAssetNames(input.naming);
  if (
    !Buffer.isBuffer(input.video) ||
    input.video.length < 1 ||
    input.video.length > 100 * 1024 * 1024 ||
    !Buffer.isBuffer(input.manifest) ||
    input.manifest.length < 1 ||
    input.manifest.length > 2 * 1024 * 1024 ||
    (input.captions !== null &&
      (!Buffer.isBuffer(input.captions) ||
        input.captions.length < 1 ||
        input.captions.length > 1024 * 1024))
  )
    throw new Error("INVALID_DERIVED_ASSET");
  return Buffer.concat([
    entry(names.video, input.video),
    ...(input.captions ? [entry(names.captions, input.captions)] : []),
    entry(names.manifest, input.manifest),
    Buffer.alloc(1024),
  ]);
}

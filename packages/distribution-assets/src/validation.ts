import { createHash, timingSafeEqual } from "node:crypto";
import {
  MASTER_MIME_TYPES,
  MAX_ONLINE_MASTER_BYTES,
  MAX_STUDIO_VIDEO_BYTES,
  parseDerivedAssetKey,
  parseStudioAssetKey,
} from "@satsang/distribution-domain";
export type StoredPrivateAsset = {
  storageKey: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  originalName: string;
};
export type DerivedPrivateAsset = Omit<StoredPrivateAsset, "originalName">;
const DERIVED_FILES = {
  video: { mime: "video/mp4", maximum: 100 * 1024 * 1024 },
  captions: { mime: "text/vtt", maximum: 1024 * 1024 },
  manifest: { mime: "application/json", maximum: 2 * 1024 * 1024 },
} as const;
export function validateDerived(asset: DerivedPrivateAsset): number {
  if (typeof asset.storageKey !== "string" || asset.storageKey !== asset.storageKey.trim()) {
    throw new Error("INVALID_DERIVED_ASSET");
  }
  const parsed = parseDerivedAssetKey(asset.storageKey);
  const studio = parseStudioAssetKey(asset.storageKey);
  const studioSpecs = {
    mp4: { mime: "video/mp4", maximum: MAX_STUDIO_VIDEO_BYTES },
    png: { mime: "image/png", maximum: 10 * 1024 * 1024 },
    md: { mime: "text/markdown", maximum: 2 * 1024 * 1024 },
    vtt: { mime: "text/vtt", maximum: 1024 * 1024 },
    json: { mime: "application/json", maximum: 2 * 1024 * 1024 },
  } as const;
  const spec = parsed
    ? DERIVED_FILES[parsed.kind]
    : studio
      ? studioSpecs[studio.extension]
      : undefined;
  if (
    !spec ||
    asset.mimeType !== spec.mime ||
    typeof asset.sha256 !== "string" ||
    asset.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.byteSize) ||
    asset.byteSize < 1 ||
    asset.byteSize > spec.maximum
  )
    throw new Error("INVALID_DERIVED_ASSET");
  return spec.maximum;
}
export function validateDerivedBytes(bytes: Buffer, mime: string): void {
  try {
    if (mime === "video/mp4") {
      if (bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") throw new Error();
    } else if (mime === "image/png") {
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error();
    } else {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (mime === "text/vtt") {
        if (!/^WEBVTT(?:[ \t][^\r\n]*)?(?:\r?\n|$)/.test(text)) throw new Error();
      } else if (mime === "text/markdown") {
        if (!text.trim() || text.includes("\u0000")) throw new Error();
      } else {
        const value = JSON.parse(text);
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
      }
    }
  } catch {
    throw new Error("INVALID_DERIVED_MEDIA");
  }
}
export function validateFilename(name: string): void {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    [...name].some(
      (letter) =>
        letter === "/" ||
        letter === "\\" ||
        letter.charCodeAt(0) < 32 ||
        letter.charCodeAt(0) === 127,
    )
  )
    throw new Error("INVALID_FILENAME");
}
export function validateAsset(asset: StoredPrivateAsset): void {
  if (
    typeof asset.storageKey !== "string" ||
    asset.storageKey !== asset.storageKey.trim() ||
    !/^distribution\/masters\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      asset.storageKey,
    ) ||
    typeof asset.sha256 !== "string" ||
    asset.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.byteSize) ||
    asset.byteSize < 1 ||
    asset.byteSize > MAX_ONLINE_MASTER_BYTES ||
    !MASTER_MIME_TYPES.includes(asset.mimeType as (typeof MASTER_MIME_TYPES)[number])
  )
    throw new Error("INVALID_ASSET");
  validateFilename(asset.originalName);
}

export type PrivateAssetStore = {
  write(input: {
    bytes: Uint8Array;
    mimeType: string;
    originalName: string;
  }): Promise<StoredPrivateAsset>;
  /** Worker path for large online masters; never buffers an entire recording. */
  writeFile?(input: {
    path: string;
    mimeType: string;
    originalName: string;
  }): Promise<StoredPrivateAsset>;
  materialize?(asset: StoredPrivateAsset, destination: string): Promise<void>;
  readRange?(asset: StoredPrivateAsset, start: number, end: number): Promise<Buffer>;
  read(asset: StoredPrivateAsset): Promise<Buffer>;
  readDerivedDescriptor(asset: DerivedPrivateAsset): Promise<Buffer>;
  writeDerivedDescriptor(asset: DerivedPrivateAsset, bytes: Uint8Array): Promise<void>;
  removeUnreferenced(asset: StoredPrivateAsset): Promise<void>;
  removeDerivedUnreferenced(asset: DerivedPrivateAsset): Promise<void>;
};
export const checksum = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export function verifyBytes(bytes: Uint8Array, asset: DerivedPrivateAsset): void {
  if (
    bytes.byteLength !== asset.byteSize ||
    !timingSafeEqual(Buffer.from(checksum(bytes), "hex"), Buffer.from(asset.sha256, "hex"))
  ) {
    throw new Error("ASSET_INTEGRITY_FAILED");
  }
}

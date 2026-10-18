export const MAX_MASTER_BYTES = 250 * 1024 * 1024;
export const MAX_ONLINE_MASTER_BYTES = 2 * 1024 * 1024 * 1024;
export const MASTER_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "video/mp4",
  "application/pdf",
] as const;
export type MasterMimeType = (typeof MASTER_MIME_TYPES)[number];
const bytesMatch = (bytes: Uint8Array, expected: readonly number[], offset = 0) =>
  expected.every((value, index) => bytes[offset + index] === value);
const ascii = (bytes: Uint8Array, text: string, offset = 0) =>
  bytesMatch(
    bytes,
    [...text].map((letter) => letter.charCodeAt(0)),
    offset,
  );
/** Only inspects a small header. Active HTML/SVG and arbitrary URL ingest are unsupported. */
export function validateMasterUpload(
  input: {
    byteSize: number;
    mimeType: string;
    signature: Uint8Array;
  },
  maximumBytes = MAX_MASTER_BYTES,
): MasterMimeType {
  const { byteSize, mimeType, signature } = input;
  if (byteSize > maximumBytes) throw new Error("UPLOAD_TOO_LARGE");
  if (
    !Number.isSafeInteger(byteSize) ||
    byteSize < 1 ||
    signature.length > byteSize ||
    !MASTER_MIME_TYPES.includes(mimeType as MasterMimeType)
  )
    throw new Error("INVALID_MEDIA");
  const mp4 =
    signature.length >= 12 &&
    ascii(signature, "ftyp", 4) &&
    ["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "M4A ", "M4B ", "qt  "].some((brand) =>
      ascii(signature, brand, 8),
    );
  const valid =
    mimeType === "image/jpeg"
      ? bytesMatch(signature, [255, 216, 255])
      : mimeType === "image/png"
        ? bytesMatch(signature, [137, 80, 78, 71, 13, 10, 26, 10])
        : mimeType === "image/webp"
          ? ascii(signature, "RIFF") && ascii(signature, "WEBP", 8)
          : mimeType === "audio/wav"
            ? ascii(signature, "RIFF") && ascii(signature, "WAVE", 8)
            : mimeType === "audio/mpeg"
              ? ascii(signature, "ID3") ||
                (signature.length >= 4 &&
                  signature[0] === 255 &&
                  ((signature[1] ?? 0) & 224) === 224 &&
                  ((signature[1] ?? 0) & 6) !== 0 &&
                  ((signature[2] ?? 0) & 240) !== 240)
              : mimeType === "application/pdf"
                ? ascii(signature, "%PDF-")
                : mp4;
  if (!valid) throw new Error("INVALID_MEDIA");
  return mimeType as MasterMimeType;
}

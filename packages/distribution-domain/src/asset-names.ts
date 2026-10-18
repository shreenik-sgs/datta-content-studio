import { SOCIAL_PLACEMENTS, type SocialPlacement } from "./activation-package";
import type { VariantAspect } from "./variants";

/** Intended placement is metadata, never proof of approval or successful publication. */
export const ASSET_DESTINATIONS = [...SOCIAL_PLACEMENTS, "manual_export"] as const;
export type AssetDestination = SocialPlacement | "manual_export";
export type DerivedAssetNamingInput = {
  masterId: string;
  sourceVersionId: string;
  derivationId: string;
  destination: AssetDestination;
  language: string;
  aspect: VariantAspect;
  format?: "video" | "short" | "reel";
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const languages = ["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"];
const aspects = ["16:9", "9:16", "4:5", "1:1"];
const validId = (value: string) =>
  typeof value === "string" && value.length === 36 && uuid.test(value);

export function buildMasterAssetNames(input: { masterId: string; versionNumber: number }) {
  if (
    !validId(input.masterId) ||
    !Number.isSafeInteger(input.versionNumber) ||
    input.versionNumber < 1
  )
    throw new Error("INVALID_ASSET_NAMING");
  const stem = `SGS_m${input.masterId}_source-v${input.versionNumber}`;
  return { stem, manifest: `${stem}_manifest.json`, archive: `${stem}.tar` };
}

/** Opaque IDs keep titles/private prose out of object names. Full lineage lives in the path. */
export function buildDerivedAssetNames(input: DerivedAssetNamingInput) {
  const format = input.format ?? (input.destination === "youtube_shorts" ? "short" : "video");
  if (
    ![input.masterId, input.sourceVersionId, input.derivationId].every(validId) ||
    !ASSET_DESTINATIONS.includes(input.destination) ||
    !languages.includes(input.language) ||
    !aspects.includes(input.aspect) ||
    !["video", "short", "reel"].includes(format)
  )
    throw new Error("INVALID_ASSET_NAMING");
  const channel = input.destination.replaceAll("_", "-");
  const aspect = input.aspect.replace(":", "x");
  const reference = input.derivationId.replaceAll("-", "").slice(0, 12);
  const stem = `SGS_m${input.masterId}_${channel}_${format}_${input.language}_${aspect}_d${reference}`;
  const names = {
    directory: `distribution/derived/${input.masterId}/${input.sourceVersionId}/${input.derivationId}`,
    stem,
    video: `${stem}.mp4`,
    captions: `${stem}_captions.vtt`,
    manifest: `${stem}_manifest.json`,
    archive: `${stem}.tar`,
  };
  // Fits the POSIX ustar name field exactly; no truncation or arbitrary paths in archives.
  if (
    [names.video, names.captions, names.manifest, names.archive].some((name) => name.length > 100)
  )
    throw new Error("INVALID_ASSET_NAMING");
  return names;
}

export type ParsedDerivedAssetKey = {
  directory: string;
  kind: "video" | "captions" | "manifest";
  filename: string;
  naming: DerivedAssetNamingInput | null;
};
/** Legacy descriptors remain readable. New names must agree with every full path ID. */
export function parseDerivedAssetKey(key: string): ParsedDerivedAssetKey | null {
  if (typeof key !== "string" || key !== key.trim() || key.length > 512) return null;
  const parts = key.split("/");
  if (parts[0] !== "distribution") return null;
  if (parts[1] === "renders" && parts.length === 4 && validId(parts[2] ?? "")) {
    const filename = parts[3] ?? "";
    const kind =
      filename === "preview.mp4"
        ? "video"
        : filename === "captions.vtt"
          ? "captions"
          : filename === "manifest.json"
            ? "manifest"
            : null;
    return kind ? { directory: parts.slice(0, 3).join("/"), kind, filename, naming: null } : null;
  }
  if (parts[1] !== "derived" || parts.length !== 6) return null;
  const [masterId, sourceVersionId, derivationId] = parts.slice(2, 5);
  if (!masterId || !sourceVersionId || !derivationId) return null;
  const filename = parts[5] ?? "";
  const match =
    /^SGS_m([a-f0-9-]{36})_([a-z-]+)_(video|short|reel)_([a-z]{2})_(16x9|9x16|4x5|1x1)_d([a-f0-9]{12})(\.mp4|_captions\.vtt|_manifest\.json)$/.exec(
      filename,
    );
  if (!match || match[1] !== masterId) return null;
  const destination = ASSET_DESTINATIONS.find((value) => value.replaceAll("_", "-") === match[2]);
  if (!destination) return null;
  const naming: DerivedAssetNamingInput = {
    masterId,
    sourceVersionId,
    derivationId,
    destination,
    format: match[3] as "video" | "short" | "reel",
    language: match[4] ?? "",
    aspect: match[5]?.replace("x", ":") as VariantAspect,
  };
  try {
    const names = buildDerivedAssetNames(naming);
    const kind =
      filename === names.video
        ? "video"
        : filename === names.captions
          ? "captions"
          : filename === names.manifest
            ? "manifest"
            : null;
    return kind && `${names.directory}/${filename}` === key
      ? { directory: names.directory, kind, filename, naming }
      : null;
  } catch {
    return null;
  }
}

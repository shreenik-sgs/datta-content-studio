import {
  STUDIO_CHANNELS,
  STUDIO_LANGUAGES,
  type StudioChannel,
  type StudioFormat,
  type StudioLanguage,
  type StudioOutput,
} from "./intelligent-content";

/** High-fidelity 1080p, three-minute exports can exceed the old 100 MiB preview ceiling. */
export const MAX_STUDIO_VIDEO_BYTES = 512 * 1024 * 1024;

export type StudioAssetIdentity = {
  fileVersion?: number;
  renderId?: string;
  masterId: string;
  sourceVersionId: string;
  packageId: string;
  outputId: string;
  channel: StudioChannel;
  format: StudioFormat;
  language: StudioLanguage;
  aspect: StudioOutput["aspect"];
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function studioAssetName(
  identity: StudioAssetIdentity,
  extension: "mp4" | "png" | "md" | "json" | "vtt",
  captionLanguage?: StudioLanguage,
) {
  if (
    ![identity.masterId, identity.sourceVersionId, identity.packageId, identity.outputId].every(
      (v) => uuid.test(v),
    ) ||
    (identity.fileVersion !== undefined &&
      (!Number.isSafeInteger(identity.fileVersion) ||
        identity.fileVersion < 1 ||
        !/^[a-f0-9]{8}$/.test(identity.renderId ?? ""))) ||
    (identity.renderId !== undefined && identity.fileVersion === undefined) ||
    !STUDIO_CHANNELS.includes(identity.channel) ||
    !STUDIO_LANGUAGES.includes(identity.language) ||
    !["short", "reel", "post", "blog"].includes(identity.format) ||
    !["9:16", "4:5", "1:1", "16:9", "prose"].includes(identity.aspect) ||
    !["mp4", "png", "md", "json", "vtt"].includes(extension) ||
    (extension === "vtt" && (!captionLanguage || !STUDIO_LANGUAGES.includes(captionLanguage))) ||
    (extension !== "vtt" && captionLanguage !== undefined)
  )
    throw new Error("INVALID_STUDIO_ASSET");
  const filename = `SGS_m${identity.masterId}_${identity.channel}_${identity.format}_${identity.language}_${identity.aspect.replace(":", "x")}_${identity.outputId.slice(0, 8)}${identity.fileVersion ? `_v${identity.fileVersion}_r${identity.renderId}` : ""}${captionLanguage ? `_cc-${captionLanguage}` : ""}.${extension}`;
  return {
    filename,
    storageKey: `distribution/studio/${identity.masterId}/${identity.sourceVersionId}/${identity.packageId}/${identity.outputId}/${filename}`,
  };
}
export function parseStudioAssetKey(key: string): {
  identity: StudioAssetIdentity;
  extension: "mp4" | "png" | "md" | "json" | "vtt";
  filename: string;
  captionLanguage?: StudioLanguage;
} | null {
  if (typeof key !== "string" || key.length > 512) return null;
  const p = key.split("/");
  if (p.length !== 7 || p[0] !== "distribution" || p[1] !== "studio") return null;
  const match =
    /^SGS_m([a-f0-9-]{36})_([a-z]+)_(short|reel|post|blog)_([a-z]{2})_(9x16|4x5|1x1|16x9|prose)_([a-f0-9]{8})(?:_v([1-9][0-9]*)_r([a-f0-9]{8}))?(?:_cc-([a-z]{2}))?\.(mp4|png|md|json|vtt)$/.exec(
      p[6] ?? "",
    );
  if (!match || match[1] !== p[2] || match[6] !== p[5]?.slice(0, 8)) return null;
  const identity: StudioAssetIdentity = {
    ...(match[7] ? { fileVersion: Number(match[7]), renderId: match[8] ?? "" } : {}),
    masterId: p[2] ?? "",
    sourceVersionId: p[3] ?? "",
    packageId: p[4] ?? "",
    outputId: p[5] ?? "",
    channel: match[2] as StudioChannel,
    format: match[3] as StudioFormat,
    language: match[4] as StudioLanguage,
    aspect: match[5]?.replace("x", ":") as StudioOutput["aspect"],
  };
  const extension = match[10] as "mp4" | "png" | "md" | "json" | "vtt";
  const captionLanguage = match[9] as StudioLanguage | undefined;
  try {
    const result = studioAssetName(identity, extension, captionLanguage);
    return result.storageKey === key
      ? {
          identity,
          extension,
          filename: result.filename,
          ...(captionLanguage ? { captionLanguage } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

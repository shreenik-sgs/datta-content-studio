import type { StudioAsset } from "./intelligent-content";
import { parseStudioAssetKey } from "./studio-assets";

/** Shared bytes stay inside one master version and curation package. Channel-specific
 * filenames and output identity remain on each descriptor, never on the shared blob. */
export function studioSharedAssetKey(identityKey: string, sha256: string): string {
  const parsed = parseStudioAssetKey(identityKey);
  if (!parsed || !/^[a-f0-9]{64}$/.test(sha256)) throw Error("INVALID_STUDIO_ASSET");
  const i = parsed.identity;
  return `distribution/studio/${i.masterId}/${i.sourceVersionId}/${i.packageId}/shared/${sha256}.${parsed.extension}`;
}
export function parseStudioSharedAssetKey(key: string) {
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  const match = new RegExp(
    `^distribution/studio/(${uuid})/(${uuid})/(${uuid})/shared/([a-f0-9]{64})\\.(mp4|png|md|json|vtt)$`,
  ).exec(key);
  return match
    ? {
        masterId: match[1],
        sourceVersionId: match[2],
        packageId: match[3],
        sha256: match[4],
        extension: match[5] as "mp4" | "png" | "md" | "json" | "vtt",
      }
    : null;
}
export function parseStudioAssetDescriptor(
  asset: Pick<StudioAsset, "storageKey" | "identityKey" | "sha256">,
) {
  if (asset.identityKey === undefined) return parseStudioAssetKey(asset.storageKey);
  const parsed = parseStudioAssetKey(asset.identityKey);
  if (!parsed) return null;
  return studioSharedAssetKey(asset.identityKey, asset.sha256) === asset.storageKey ? parsed : null;
}

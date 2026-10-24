import type { PrivateAssetStore } from "@satsang/distribution-assets";
import { type StudioAsset, studioSharedAssetKey } from "@satsang/distribution-domain";

/** Immutable content-addressed storage. Existing bytes must verify before reuse;
 * failed writes are reconciled by reading, never overwritten. */
export async function saveSharedStudioAsset(
  store: PrivateAssetStore,
  logical: StudioAsset,
  bytes: Uint8Array,
): Promise<StudioAsset> {
  const asset = {
    ...logical,
    identityKey: logical.storageKey,
    storageKey: studioSharedAssetKey(logical.storageKey, logical.sha256),
  };
  try {
    await store.readDerivedDescriptor(asset);
    return asset;
  } catch (error) {
    const e = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.code !== "ENOENT" && e.name !== "NoSuchKey" && e.$metadata?.httpStatusCode !== 404)
      throw error;
  }
  try {
    await store.writeDerivedDescriptor(asset, bytes);
  } catch (error) {
    // Covers a concurrent same-content write or a successful S3 write with a lost response.
    try {
      await store.readDerivedDescriptor(asset);
    } catch {
      throw error;
    }
  }
  return asset;
}

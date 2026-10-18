import { normalizeDistributionStage } from "@satsang/distribution-domain";
import { createPrivateAssetStore } from "./local";
import {
  type S3AssetConfig,
  type S3Transport,
  createS3AssetStore,
  validateS3AssetConfig,
} from "./s3";
import type { PrivateAssetStore } from "./validation";

export { createPrivateAssetStore } from "./local";
export {
  createS3AssetStore,
  type S3AssetConfig,
  type S3AssetCommand,
  type S3Transport,
} from "./s3";
export type { StoredPrivateAsset, DerivedPrivateAsset, PrivateAssetStore } from "./validation";
export * from "./studio-media-access";

export type AssetStoreConfig =
  | { backend: "local"; root: string }
  | ({ backend: "s3" } & S3AssetConfig);

/** S3 opt-in is explicit and never falls back to a local disk after an error. */
export function parseAssetStoreConfig(
  env: Record<string, string | undefined> = process.env,
): AssetStoreConfig {
  if (env.DISTRIBUTION_ASSET_BACKEND === undefined || env.DISTRIBUTION_ASSET_BACKEND === "local") {
    if (!env.DISTRIBUTION_ASSET_ROOT) throw new Error("ASSETS_NOT_CONFIGURED");
    return { backend: "local", root: env.DISTRIBUTION_ASSET_ROOT };
  }
  if (env.DISTRIBUTION_ASSET_BACKEND !== "s3") throw new Error("INVALID_ASSET_BACKEND");
  const stage = normalizeDistributionStage(env.DISTRIBUTION_HUB_STAGE);
  const expectedPrefix =
    stage === "TEST" ? "test/" : stage === "LIMITED" || stage === "ON" ? "production/" : null;
  if (!expectedPrefix || env.DISTRIBUTION_S3_PREFIX !== expectedPrefix)
    throw new Error("INVALID_S3_ASSET_WORLD");
  const config: AssetStoreConfig = {
    backend: "s3",
    bucket: env.DISTRIBUTION_S3_BUCKET ?? "",
    region: env.DISTRIBUTION_S3_REGION ?? "",
    expectedBucketOwner: env.DISTRIBUTION_S3_EXPECTED_BUCKET_OWNER ?? "",
    prefix: expectedPrefix,
  };
  validateS3AssetConfig(config);
  return config;
}

export function createAssetStore(
  env: Record<string, string | undefined> = process.env,
  transport?: S3Transport,
): PrivateAssetStore {
  const config = parseAssetStoreConfig(env);
  return config.backend === "local"
    ? createPrivateAssetStore(config.root)
    : createS3AssetStore(config, transport);
}

export * from "./live-fragments";

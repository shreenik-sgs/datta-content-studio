import { loadStudioProviderConfig, studioSettingsPath } from "@satsang/distribution-db";
import { MAX_MASTER_BYTES } from "@satsang/distribution-domain";
export async function masterUploadLimit(isTest: boolean): Promise<number> {
  const config = await loadStudioProviderConfig(studioSettingsPath(process.env, isTest));
  return config.maxMasterUploadMb === undefined
    ? MAX_MASTER_BYTES
    : config.maxMasterUploadMb * 1024 * 1024;
}

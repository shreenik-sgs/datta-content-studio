import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type StudioProviderConfig,
  loadStudioProviderConfig,
  sealStudioProviderConfig,
} from "./studio-provider-config";

export function studioSettingsPath(env: NodeJS.ProcessEnv, isTest: boolean) {
  if (env.STUDIO_CHANNEL_CONFIG_BACKEND === "database")
    return isTest ? "database:test" : "database:production";
  return isTest ? env.STUDIO_CHANNEL_CONFIG_TEST_FILE : env.STUDIO_CHANNEL_CONFIG_FILE;
}
export function studioSettingsRevision(config: StudioProviderConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
/** Atomic, encrypted storage. The host must mount a private shared directory for web and worker. */
export async function saveStudioSettings(input: {
  path: string | undefined;
  key: string | undefined;
  expectedRevision: string;
  config: StudioProviderConfig;
}) {
  const { path, key } = input;
  if (path === "database:test" || path === "database:production") {
    const { saveDatabaseStudioSettings } = await import("./studio-settings-database");
    return saveDatabaseStudioSettings({
      ...input,
      key,
      isTest: path === "database:test",
      env: process.env,
    });
  }
  if (!path || !isAbsolute(path) || !key || !/^[a-f0-9]{64}$/i.test(key))
    throw Error("SETTINGS_STORAGE_NOT_CONFIGURED");
  const lock = `${path}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw Error("SETTINGS_BUSY");
  }
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const current = await loadStudioProviderConfig(path, key);
    if (studioSettingsRevision(current) !== input.expectedRevision) throw Error("SETTINGS_CHANGED");
    await writeFile(temporary, sealStudioProviderConfig(input.config, key), {
      mode: 0o600,
      flag: "wx",
    });
    await loadStudioProviderConfig(temporary, key);
    await rename(temporary, path);
    return studioSettingsRevision(input.config);
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

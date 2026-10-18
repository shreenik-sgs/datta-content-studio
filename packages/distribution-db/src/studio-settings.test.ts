import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type StudioProviderConfig, loadStudioProviderConfig } from "./studio-provider-config";
import { saveStudioSettings, studioSettingsPath, studioSettingsRevision } from "./studio-settings";
const roots: string[] = [];
const empty: StudioProviderConfig = { version: 1, accounts: [], trustedMediaOrigins: [] };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
it("encrypts credentials, rejects wrong keys and stale edits, and preserves prior settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-settings-"));
  roots.push(root);
  const path = join(root, "settings.json");
  await writeFile(path, JSON.stringify(empty), { mode: 0o600 });
  const config: StudioProviderConfig = {
    ...empty,
    accounts: [
      {
        id: "x-account",
        platform: "x",
        transport: "buffer",
        providerAccountId: "channel-1",
        enabled: false,
        eligibilityVerified: false,
        world: "PRODUCTION",
        accessToken: "synthetic-confidential-token",
      },
    ],
  };
  const key = "ab".repeat(32);
  await saveStudioSettings({ path, key, expectedRevision: studioSettingsRevision(empty), config });
  expect(await readFile(path, "utf8")).not.toContain("synthetic-confidential-token");
  expect(await loadStudioProviderConfig(path, key)).toEqual(config);
  await expect(loadStudioProviderConfig(path, "cd".repeat(32))).rejects.toThrow(
    "STUDIO_PROVIDER_CONFIG_INVALID",
  );
  await expect(
    saveStudioSettings({
      path,
      key,
      expectedRevision: studioSettingsRevision(empty),
      config: empty,
    }),
  ).rejects.toThrow("SETTINGS_CHANGED");
  expect(await loadStudioProviderConfig(path, key)).toEqual(config);
  await expect(
    saveStudioSettings({
      path,
      key: undefined,
      expectedRevision: studioSettingsRevision(config),
      config: empty,
    }),
  ).rejects.toThrow("SETTINGS_STORAGE_NOT_CONFIGURED");
});
it("never falls back to production credentials in a test workspace", () => {
  expect(
    studioSettingsPath({ STUDIO_CHANNEL_CONFIG_FILE: "/private/prod.json" }, true),
  ).toBeUndefined();
  expect(
    studioSettingsPath(
      {
        STUDIO_CHANNEL_CONFIG_FILE: "/private/prod.json",
        STUDIO_CHANNEL_CONFIG_TEST_FILE: "/private/test.json",
      },
      true,
    ),
  ).toBe("/private/test.json");
});

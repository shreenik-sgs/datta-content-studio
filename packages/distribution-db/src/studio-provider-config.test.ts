import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStudioProviderConfig, studioProviderReadiness } from "./studio-provider-config";
const roots: string[] = [];
const config = {
  version: 1,
  trustedMediaOrigins: ["https://media.ashrama.test"],
  accounts: [
    {
      id: "account-1",
      platform: "threads",
      transport: "buffer",
      providerAccountId: "buffer-channel",
      world: "PRODUCTION",
      enabled: true,
      eligibilityVerified: true,
      accessToken: "synthetic-private-token",
    },
  ],
};
async function file(value: unknown = config) {
  const root = await mkdtemp(join(tmpdir(), "studio-config-"));
  roots.push(root);
  const path = join(root, "private.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe("private studio provider config", () => {
  it("defaults truthfully to disconnected and excludes internal website publishing", async () => {
    const readiness = studioProviderReadiness(await loadStudioProviderConfig(), false);
    expect(readiness).toHaveLength(12);
    expect(
      readiness.every((entry) => !entry.ready && entry.reason === "CHANNEL_NOT_CONNECTED"),
    ).toBe(true);
  });
  it("projects readiness without tokens, destination IDs, or private settings", async () => {
    const loaded = await loadStudioProviderConfig(await file());
    expect(loaded.accounts[0]?.accessToken).toBe("synthetic-private-token");
    const ready = studioProviderReadiness(loaded, false);
    expect(ready.find((entry) => entry.channel === "threads")).toMatchObject({
      ready: true,
      reason: null,
      accountId: "account-1",
      transport: "buffer",
    });
    expect(JSON.stringify(ready)).not.toContain("synthetic-private-token");
    expect(JSON.stringify(ready)).not.toContain("buffer-channel");
    expect(
      studioProviderReadiness(loaded, true).every(
        (entry) => !entry.ready && entry.reason === "TEST_NETWORK_DISABLED",
      ),
    ).toBe(true);
  });
  it("refuses readable-by-others files and symlinks without revealing paths", async () => {
    const path = await file();
    await chmod(path, 0o644);
    await expect(loadStudioProviderConfig(path)).rejects.toThrow("STUDIO_PROVIDER_CONFIG_INVALID");
    await chmod(path, 0o600);
    await symlink(path, `${path}.link`);
    await expect(loadStudioProviderConfig(`${path}.link`)).rejects.toThrow(
      "STUDIO_PROVIDER_CONFIG_INVALID",
    );
  });
  it.each([
    { ...config, accounts: [...config.accounts, ...config.accounts] },
    { ...config, accounts: [{ ...config.accounts[0], world: "TEST" }] },
    { ...config, accounts: [{ ...config.accounts[0], accessToken: "secret\nheader" }] },
    { ...config, accounts: [{ ...config.accounts[0], id: "account\n" }] },
    { ...config, trustedMediaOrigins: ["https://127.0.0.1"] },
    { ...config, trustedMediaOrigins: ["http://media.ashrama.test"] },
    { ...config, trustedMediaOrigins: ["https://media.ashrama.test/path"] },
  ])("refuses invalid configuration", async (value) => {
    await expect(loadStudioProviderConfig(await file(value))).rejects.toThrow(
      "STUDIO_PROVIDER_CONFIG_INVALID",
    );
  });
  it("marks missing account-specific publishing settings as blocked", async () => {
    for (const platform of ["youtube", "tiktok", "pinterest"]) {
      const loaded = await loadStudioProviderConfig(
        await file({ ...config, accounts: [{ ...config.accounts[0], platform }] }),
      );
      expect(
        studioProviderReadiness(loaded, false).find((entry) => entry.channel === platform)?.ready,
      ).toBe(false);
    }
  });
});

it("supports several accounts per platform with one explicit default and safe labels", async () => {
  const first = { ...config.accounts[0], isDefault: true, label: "First" };
  const second = {
    ...first,
    id: "second",
    providerAccountId: "second-channel",
    isDefault: false,
    label: "Second",
  };
  const loaded = await loadStudioProviderConfig(
    await file({ ...config, accounts: [first, second] }),
  );
  const projected = studioProviderReadiness(loaded, false).find((c) => c.channel === "threads");
  expect(projected?.accountId).toBe("account-1");
  expect(projected?.accounts?.map((a) => [a.id, a.label, a.isDefault])).toEqual([
    ["account-1", "First", true],
    ["second", "Second", false],
  ]);
  for (const accounts of [
    [first, { ...second, isDefault: true }],
    [{ ...first, isDefault: false }, second],
    [first, { ...second, providerAccountId: first.providerAccountId }],
  ])
    await expect(loadStudioProviderConfig(await file({ ...config, accounts }))).rejects.toThrow(
      "STUDIO_PROVIDER_CONFIG_INVALID",
    );
});

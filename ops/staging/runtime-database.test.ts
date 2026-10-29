import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const runtime = {
  STUDIO_IDENTITY: "gbadpt",
  DISTRIBUTION_APP_ORIGIN: "https://gbadpt.sgsdattasannidhi.org",
  DISTRIBUTION_HUB_STAGE: "ON",
  STUDIO_PUBLISHING_ENABLED: "true",
  DISTRIBUTION_DATABASE_URL:
    "postgres://user:synthetic@127.0.0.1:5432/datta_content_studio_gbadpt_live",
  DISTRIBUTION_S3_BUCKET: "datta-content-studio-staging-510724490093-ap-south-1",
  DISTRIBUTION_S3_PREFIX: "production/",
};
it("backs up the correct isolated database for both TEST and explicitly enabled GBADPT live", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-runtime-"));
  try {
    const run = async (env: Record<string, string>) => {
      const file = join(dir, "runtime.env");
      await writeFile(
        file,
        Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
        { mode: 0o600 },
      );
      return execFileSync(
        "python3",
        [fileURLToPath(new URL("./runtime-database.py", import.meta.url)), file],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    };
    expect(await run(runtime)).toBe("datta_content_studio_gbadpt_live");
    expect(
      await run({
        ...runtime,
        DISTRIBUTION_HUB_STAGE: "TEST",
        STUDIO_PUBLISHING_ENABLED: "false",
        DISTRIBUTION_S3_PREFIX: "test/",
        DISTRIBUTION_DATABASE_URL: runtime.DISTRIBUTION_DATABASE_URL.replace(
          "gbadpt_live",
          "staging",
        ),
      }),
    ).toBe("datta_content_studio_staging");
    const dp = {
      STUDIO_IDENTITY: "dp",
      DISTRIBUTION_APP_ORIGIN: "https://dp.sgsdattasannidhi.org",
      DISTRIBUTION_HUB_STAGE: "TEST",
      STUDIO_PUBLISHING_ENABLED: "false",
      DISTRIBUTION_DATABASE_URL: "postgres://user:synthetic@127.0.0.1:5432/datta_content_studio_dp",
      DISTRIBUTION_S3_BUCKET: "datta-content-studio-dp-510724490093-ap-south-1",
      DISTRIBUTION_S3_PREFIX: "test/",
    };
    expect(await run(dp)).toBe("datta_content_studio_dp");
    // DP may never point at GBADPT's bucket or database, nor GBADPT at DP's.
    for (const override of [
      { DISTRIBUTION_S3_BUCKET: runtime.DISTRIBUTION_S3_BUCKET },
      { DISTRIBUTION_DATABASE_URL: runtime.DISTRIBUTION_DATABASE_URL },
      { STUDIO_IDENTITY: "gbadpt" },
      { DISTRIBUTION_APP_ORIGIN: runtime.DISTRIBUTION_APP_ORIGIN },
    ])
      await expect(run({ ...dp, ...override })).rejects.toThrow("Studio runtime validation failed");
    for (const override of [
      { STUDIO_IDENTITY: "dp" },
      { DISTRIBUTION_S3_BUCKET: dp.DISTRIBUTION_S3_BUCKET },
      { DISTRIBUTION_APP_ORIGIN: "https://sgsdattasannidhi.org" },
      {
        DISTRIBUTION_DATABASE_URL: runtime.DISTRIBUTION_DATABASE_URL.replace(
          "gbadpt_live",
          "staging",
        ),
      },
      { DISTRIBUTION_S3_PREFIX: "test/" },
      { STUDIO_PUBLISHING_ENABLED: "false" },
      { DISTRIBUTION_S3_BUCKET: "sannidhi-production" },
    ])
      await expect(run({ ...runtime, ...override })).rejects.toThrow(
        "Studio runtime validation failed",
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

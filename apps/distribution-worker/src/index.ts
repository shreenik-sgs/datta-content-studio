import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createAssetStore } from "@satsang/distribution-assets";
import {
  createDistributionActivationRepository,
  createDistributionRenderRepository,
  createDistributionRoleAuthority,
} from "@satsang/distribution-db";
import { createSignedLinkCachePublisher } from "@satsang/distribution-links/cache";
import { Pool } from "pg";
import { createLocalDestinationChecker, linkJobConfig, runLinkJobs } from "./link-jobs.js";
import { createLocalRenderer } from "./renderer.js";
import { localWorkerConfig, runRenderLoop } from "./run-render-job.js";
import { createStoredRenderer } from "./stored-renderer.js";

async function main() {
  const config = localWorkerConfig(process.env);
  if (!config) {
    console.info("Distribution worker is OFF; no queues or providers were opened.");
    return;
  }
  const renderOptions = {
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
  };
  const renderer =
    config.assetBackend === "s3"
      ? createStoredRenderer({
          ...renderOptions,
          store: createAssetStore(process.env),
          scratchRoot: config.assetRoot,
        })
      : createLocalRenderer({ ...renderOptions, root: config.assetRoot });
  const links = linkJobConfig(process.env);
  let publisher: ReturnType<typeof createSignedLinkCachePublisher> | undefined;
  let checkDestinations: ReturnType<typeof createLocalDestinationChecker> | undefined;
  if (links) {
    checkDestinations = createLocalDestinationChecker({ origin: links.origin, key: links.key });
    const file = await open(links.privateKeyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > 8192 || (info.mode & 0o077) !== 0)
        throw new Error("PRIVATE_SIGNING_KEY_REQUIRED");
      publisher = createSignedLinkCachePublisher({
        root: links.root,
        keyId: links.keyId,
        privateKeyPem: await file.readFile("utf8"),
      });
    } finally {
      await file.close();
    }
  }
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  pool.on("error", () => console.error("Distribution render database connection unavailable."));
  let unavailable = false;
  try {
    console.info(
      `Distribution render worker TEST started; ${config.assetBackend} storage, local authority, one render at a time.`,
    );
    await Promise.all([
      runRenderLoop({
        // localWorkerConfig above already refuses all non-TEST/remote-database runs.
        // The authority is loopback-only, OFF without its dedicated key, and rechecks revocation.
        repository: createDistributionRenderRepository(pool, {
          authorize: createDistributionRoleAuthority(process.env),
        }),
        renderer,
        workerId: `local-${randomUUID()}`,
        signal: controller.signal,
        onResult(result) {
          unavailable = false;
          if (
            result.status === "failed" ||
            result.status === "uncertain" ||
            (result.status === "stale" && result.reason === "STALE_OUTPUT_CLEANUP_PENDING")
          )
            console.error(JSON.stringify({ event: "distribution.render.failure", ...result }));
        },
        onUnavailable() {
          if (!unavailable)
            console.error("Distribution render queue unavailable; retrying locally.");
          unavailable = true;
        },
      }),
      ...(publisher && checkDestinations
        ? [
            runLinkJobs({
              // main's localWorkerConfig rejects non-TEST before pool creation.
              repository: createDistributionActivationRepository(pool, {
                authorize: createDistributionRoleAuthority(process.env),
              }),
              publisher,
              checkDestinations,
              signal: controller.signal,
              onUnavailable(part) {
                console.error(JSON.stringify({ event: "distribution.links.unavailable", part }));
              },
            }),
          ]
        : []),
    ]);
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await pool.end();
  }
}
main().catch(() => {
  console.error("Distribution worker could not start; verify local TEST configuration.");
  process.exitCode = 1;
});

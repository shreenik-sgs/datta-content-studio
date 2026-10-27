import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import {
  createAssetStore,
  createLiveFragmentStore,
  parseAssetStoreConfig,
} from "@satsang/distribution-assets";
import {
  createIntelligentContentRepository,
  createLiveCurationRepository,
  createOnlineImportRepository,
  createStorageCleanupRepository,
  createStudioRoleAuthority,
} from "@satsang/distribution-db";
import { Pool } from "pg";
import { runLiveCurationLoop } from "./live-curation-worker.js";
import { runStorageCleanupLoop } from "./storage-cleanup-worker.js";
import { studioCapacity } from "./studio-capacity.js";
import { studioMediaCapacity } from "./studio-media-capacity.js";
import { runStudioLoop } from "./studio-worker.js";
import { runVerifiedOnlineImports } from "./verified-online-imports.js";

async function main() {
  const env = process.env;
  const capacity = studioCapacity(env);
  studioMediaCapacity(env);
  const mode = env.STUDIO_WORKER_MODE ?? "all";
  if (!["all", "imports", "generation"].includes(mode)) throw Error("INVALID_WORKER_MODE");
  if (
    env.STUDIO_WORKER_ENABLED !== "true" ||
    env.DISTRIBUTION_HUB_ENABLED !== "true" ||
    !["TEST", "LIMITED", "ON"].includes(env.DISTRIBUTION_HUB_STAGE ?? "")
  ) {
    console.info("Intelligent content worker is OFF.");
    return;
  }
  if (!env.DISTRIBUTION_DATABASE_URL) throw new Error("DB_NOT_CONFIGURED");
  const isTest = env.DISTRIBUTION_HUB_STAGE === "TEST";
  const url = new URL(env.DISTRIBUTION_DATABASE_URL);
  if (isTest && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("LOCAL_TEST_DATABASE_REQUIRED");
  const pool = new Pool({
    connectionString: env.DISTRIBUTION_DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  const health = env.STUDIO_HEALTH_PORT
    ? createServer(async (_request, response) => {
        try {
          await pool.query("SELECT 1");
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end('{"ok":true}');
        } catch {
          response.writeHead(503);
          response.end('{"ok":false}');
        }
      })
    : undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    if (health) {
      const port = Number(env.STUDIO_HEALTH_PORT);
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw Error("INVALID_HEALTH_PORT");
      await new Promise<void>((resolve, reject) => {
        health.once("error", reject);
        health.listen(port, "127.0.0.1", resolve);
      });
    }
    console.info(
      `Intelligent content worker ${isTest ? "TEST (no external publication)" : "PRODUCTION"} started.`,
    );
    const fragments = createLiveFragmentStore(parseAssetStoreConfig(env));
    try {
      await Promise.all([
        mode !== "generation" &&
          runStorageCleanupLoop({
            repository: createStorageCleanupRepository(pool, createStudioRoleAuthority(env)),
            store: createAssetStore(env),
            isTest,
            signal: controller.signal,
          }),
        mode !== "generation" &&
          env.STUDIO_LIVE_MONITOR_ENABLED === "true" &&
          runLiveCurationLoop({
            repository: createLiveCurationRepository(pool, createStudioRoleAuthority(env)),
            store: createAssetStore(env),
            fragments,
            env,
            isTest,
            signal: controller.signal,
            onError: (code) => console.error(JSON.stringify({ event: "studio.live.error", code })),
          }),
        mode !== "imports" &&
          (async () => {
            const repository = createIntelligentContentRepository(pool, {
              authorize: createStudioRoleAuthority(env),
            });
            while (!controller.signal.aborted) {
              try {
                if (
                  env.STUDIO_LIVE_MONITOR_ENABLED === "true" &&
                  (await repository.queueLiveWindow(isTest))
                )
                  continue;
                if (await repository.queuePlaylistMember(isTest, capacity.queue)) continue;
                if (await repository.advanceSeriesWorkflow(isTest)) continue;
              } catch {
                console.error(
                  JSON.stringify({
                    event: "studio.playlist.error",
                    code: "PLAYLIST_QUEUE_UNAVAILABLE",
                  }),
                );
              }
              try {
                await pause(2000, undefined, { signal: controller.signal });
              } catch {
                break;
              }
            }
          })(),
        mode !== "generation" &&
          runVerifiedOnlineImports(pool, {
            repository: createOnlineImportRepository(pool, createStudioRoleAuthority(env), {
              prefetch: capacity.prefetch,
            }),
            store: createAssetStore(env),
            env,
            isTest,
            signal: controller.signal,
            onError: (code) =>
              console.error(JSON.stringify({ event: "studio.import.error", code })),
          }),
        mode !== "imports" &&
          runStudioLoop({
            repository: createIntelligentContentRepository(pool, {
              authorize: createStudioRoleAuthority(env),
            }),
            store: createAssetStore(env),
            env,
            isTest,
            workerId: `studio-${randomUUID()}`,
            signal: controller.signal,
            onFailureDiagnostic: (diagnostic) =>
              console.error(
                JSON.stringify({ event: "studio.generation.diagnostic", ...diagnostic }),
              ),
            onError: (code) =>
              console.error(JSON.stringify({ event: "studio.worker.error", code })),
          }),
      ]);
    } finally {
      fragments.close();
    }
  } finally {
    health?.closeAllConnections();
    health?.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await pool.end();
  }
}
main().catch(() => {
  console.error("Intelligent content worker could not start; verify its configuration.");
  process.exitCode = 1;
});

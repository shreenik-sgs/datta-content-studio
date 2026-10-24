import { setTimeout as pause } from "node:timers/promises";
import type { Pool } from "pg";
import { createImportVerificationManager } from "./import-verification-browser.js";
import { startImportVerificationServer } from "./import-verification-server.js";
import { type OnlineImportWorkerInput, runOnlineImportLoop } from "./online-import-worker.js";

/** One active importer per world, including rolling replacements. The browser and downloader
 * stay in this same process/network namespace; a restart expires its private verification. */
export async function runVerifiedOnlineImports(pool: Pool, input: OnlineImportWorkerInput) {
  while (!input.signal.aborted) {
    const client = await pool.connect();
    const stopped = new AbortController();
    const onLostConnection = () => stopped.abort();
    client.on("error", onLostConnection);
    let locked = false;
    let manager: ReturnType<typeof createImportVerificationManager> | undefined;
    let server: Awaited<ReturnType<typeof startImportVerificationServer>> | undefined;
    try {
      locked = Boolean(
        (
          await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [
            `online-import-leader:${input.isTest}`,
          ])
        ).rows[0]?.locked,
      );
      if (locked) {
        const signal = AbortSignal.any([input.signal, stopped.signal]);
        if (input.env.STUDIO_IMPORT_VERIFICATION_ENABLED === "true") {
          manager = createImportVerificationManager({ ...input, signal });
          server = await startImportVerificationServer(manager, input.env);
        }
        await runOnlineImportLoop({
          ...input,
          signal,
          ...(manager ? { download: manager.download, paused: manager.paused } : {}),
        });
        // A failed runtime preflight is an operator problem, not a reason to
        // relaunch Chromium every two seconds. Repair dependencies and restart.
        // A lost leader connection still needs the normal reacquisition path.
        if (!stopped.signal.aborted || input.signal.aborted) break;
      }
    } finally {
      stopped.abort();
      await server?.close();
      await manager?.close();
      if (locked)
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            `online-import-leader:${input.isTest}`,
          ])
          .catch(() => undefined);
      client.removeListener("error", onLostConnection);
      client.release();
    }
    try {
      await pause(2000, undefined, { signal: input.signal });
    } catch {
      break;
    }
  }
}

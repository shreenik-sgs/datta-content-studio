import { execFile } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import type { PrivateAssetStore, StoredPrivateAsset } from "@satsang/distribution-assets";
import type { OnlineImportClaim, createOnlineImportRepository } from "@satsang/distribution-db";
import { MAX_ONLINE_MASTER_BYTES } from "@satsang/distribution-domain";
import { downloadOnlineVideo } from "./online-video-download.js";

export type OnlineImportWorkerInput = {
  repository: ReturnType<typeof createOnlineImportRepository>;
  store: PrivateAssetStore;
  isTest: boolean;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onError?: (code: string) => void;
  download?: typeof downloadOnlineVideo;
  paused?: () => boolean;
};
export async function runOnlineImportOnce(
  input: OnlineImportWorkerInput,
  download = input.download ?? downloadOnlineVideo,
  explicitClaim?: OnlineImportClaim,
) {
  const claim = explicitClaim ?? (await input.repository.claim(input.isTest));
  if (!claim) return false;
  const stop = new AbortController();
  const signal = AbortSignal.any([input.signal, stop.signal]);
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void input.repository
      .renew(claim)
      .catch(() => stop.abort())
      .finally(() => {
        renewing = false;
      });
  }, 30000);
  heartbeat.unref();
  let asset: StoredPrivateAsset | undefined;
  let committing = false;
  try {
    const writeFile = input.store.writeFile;
    if (!writeFile) throw Error("ONLINE_IMPORT_STORAGE_UNAVAILABLE");
    const result = await download({
      source: claim.source,
      maxBytes: MAX_ONLINE_MASTER_BYTES,
      signal,
      binary: input.env.STUDIO_YTDLP_PATH,
      save: async (video) => {
        signal.throwIfAborted();
        await input.repository.renew(claim);
        asset = await writeFile({
          path: video.path,
          mimeType: "video/mp4",
          originalName: video.filename,
        });
        signal.throwIfAborted();
        committing = true;
        const saved = await input.repository.complete(claim, { asset, title: video.title });
        if (saved.duplicate) await input.store.removeUnreferenced(asset);
      },
    });
    signal.throwIfAborted();
    if (result.kind === "playlist") {
      await input.repository.renew(claim);
      await input.repository.expand(claim, result.entries, result.title);
    }
  } catch (error) {
    // Never delete bytes after an uncertain COMMIT acknowledgement.
    if (asset && !committing) await input.store.removeUnreferenced(asset).catch(() => undefined);
    const code = error instanceof Error ? error.message : "ONLINE_SOURCE_UNAVAILABLE";
    if (code !== "ONLINE_IMPORT_LEASE_LOST" && !signal.aborted)
      await input.repository.fail(claim, code);
    input.onError?.(
      code in
        {
          ONLINE_IMPORT_DISABLED: 1,
          ONLINE_SOURCE_RESTRICTED: 1,
          ONLINE_SOURCE_TOO_LARGE: 1,
          ONLINE_PROVIDER_VERIFICATION_REQUIRED: 1,
          ONLINE_PROVIDER_RATE_LIMITED: 1,
        }
        ? code
        : "ONLINE_IMPORT_FAILED",
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
export async function runOnlineImportLoop(input: OnlineImportWorkerInput) {
  try {
    await promisify(execFile)(
      input.env.STUDIO_YTDLP_PATH ?? "yt-dlp",
      ["--ignore-config", "--version"],
      { timeout: 10000 },
    );
  } catch {
    input.onError?.("ONLINE_IMPORT_DISABLED");
    return;
  }
  await input.repository.heartbeat(input.isTest);
  let beating = false;
  const heartbeat = setInterval(() => {
    if (beating) return;
    beating = true;
    void input.repository
      .heartbeat(input.isTest)
      .catch(() => undefined)
      .finally(() => {
        beating = false;
      });
  }, 30000);
  heartbeat.unref();
  try {
    while (!input.signal.aborted) {
      try {
        if (!input.paused?.() && (await runOnlineImportOnce(input))) continue;
      } catch {
        input.onError?.("ONLINE_IMPORT_QUEUE_UNAVAILABLE");
      }
      try {
        await pause(2000, undefined, { signal: input.signal });
      } catch {
        break;
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}

import { setTimeout as pause } from "node:timers/promises";
import type { PrivateAssetStore } from "@satsang/distribution-assets";
import type { createStorageCleanupRepository } from "@satsang/distribution-db";
import type { CleanupFile } from "@satsang/distribution-domain";
export async function removeCleanupFile(store: PrivateAssetStore, file: CleanupFile) {
  try {
    if (file.storageKey.startsWith("distribution/masters/")) {
      if (!file.originalName) throw Error("INVALID_CLEANUP_ASSET");
      await store.removeUnreferenced({ ...file, originalName: file.originalName });
    } else await store.removeDerivedUnreferenced(file);
  } catch (error) {
    // A restart after deletion but before its checkpoint must be safe to retry.
    const e = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      e.code !== "ENOENT" &&
      e.name !== "NoSuchKey" &&
      e.name !== "NotFound" &&
      e.$metadata?.httpStatusCode !== 404
    )
      throw error;
  }
}
export async function runStorageCleanupLoop(input: {
  repository: ReturnType<typeof createStorageCleanupRepository>;
  store: PrivateAssetStore;
  isTest: boolean;
  signal: AbortSignal;
}) {
  while (!input.signal.aborted) {
    try {
      if (
        await input.repository.processOne(input.isTest, (file) =>
          removeCleanupFile(input.store, file),
        )
      )
        continue;
    } catch {
      console.error(
        JSON.stringify({ event: "studio.cleanup.error", code: "STORAGE_CLEANUP_UNAVAILABLE" }),
      );
    }
    try {
      await pause(2000, undefined, { signal: input.signal });
    } catch {
      break;
    }
  }
}

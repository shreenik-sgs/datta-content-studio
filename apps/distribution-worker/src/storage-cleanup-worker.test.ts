import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateAssetStore } from "@satsang/distribution-assets";
import { afterEach, expect, it, vi } from "vitest";
import { removeCleanupFile } from "./storage-cleanup-worker";
let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it("removes actual master bytes and tolerates a crash before checkpointing without reading arbitrary paths", async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "cleanup-test-"));
  const store = createPrivateAssetStore(root);
  const asset = await store.write({
    bytes: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]),
    mimeType: "video/mp4",
    originalName: "test.mp4",
  });
  await removeCleanupFile(store, asset);
  await expect(stat(join(root, asset.storageKey))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(removeCleanupFile(store, asset)).resolves.toBeUndefined();
  await expect(
    removeCleanupFile(store, {
      ...asset,
      storageKey: `distribution/masters/../../${randomUUID()}`,
    }),
  ).rejects.toThrow("INVALID_ASSET");
});
it("does not turn permission/storage failures into successful deletion", async () => {
  const store = {
    removeDerivedUnreferenced: vi.fn(async () => {
      throw Object.assign(Error("denied"), { name: "AccessDenied" });
    }),
  };
  await expect(
    removeCleanupFile(store as never, {
      storageKey: "distribution/studio/test",
      sha256: "a".repeat(64),
      byteSize: 12,
      mimeType: "video/mp4",
    }),
  ).rejects.toThrow("denied");
});

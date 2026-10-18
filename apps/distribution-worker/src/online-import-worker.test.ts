import type { PrivateAssetStore } from "@satsang/distribution-assets";
import type { createOnlineImportRepository } from "@satsang/distribution-db";
import { MAX_ONLINE_MASTER_BYTES } from "@satsang/distribution-domain";
import { expect, it, vi } from "vitest";
import { runOnlineImportOnce } from "./online-import-worker";

it("uses the online ceiling and streams to storage before marking the import complete", async () => {
  const asset = {
    storageKey: "private",
    byteSize: 600 * 1048576,
    sha256: "a".repeat(64),
    mimeType: "video/mp4",
    originalName: "complete.mp4",
  };
  const repo = {
    claim: vi
      .fn()
      .mockResolvedValue({ id: "test", source: { url: "https://youtu.be/g0zlErdfXlg" } }),
    renew: vi.fn(),
    complete: vi.fn().mockResolvedValue({ duplicate: false }),
    fail: vi.fn(),
  };
  const store = {
    writeFile: vi.fn().mockResolvedValue(asset),
    write: vi.fn(),
    removeUnreferenced: vi.fn(),
  };
  const download = vi.fn(
    async (input: Parameters<NonNullable<Parameters<typeof runOnlineImportOnce>[1]>>[0]) => {
      expect(input.maxBytes).toBe(MAX_ONLINE_MASTER_BYTES);
      await input.save?.({
        path: "/private/worker-owned/master.mp4",
        filename: "complete.mp4",
        title: "Complete teaching",
      });
      return { kind: "video" as const };
    },
  );
  await runOnlineImportOnce(
    {
      repository: repo as unknown as ReturnType<typeof createOnlineImportRepository>,
      store: store as unknown as PrivateAssetStore,
      isTest: true,
      env: {},
      signal: new AbortController().signal,
    },
    download,
  );
  expect(store.write).not.toHaveBeenCalled();
  expect(store.writeFile).toHaveBeenCalledOnce();
  expect(repo.complete).toHaveBeenCalledWith(expect.anything(), {
    asset,
    title: "Complete teaching",
  });
  expect(repo.fail).not.toHaveBeenCalled();
});

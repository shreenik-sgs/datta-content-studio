import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateAssetStore } from "@satsang/distribution-assets";
import { studioAssetName } from "@satsang/distribution-domain";
import { expect, it, vi } from "vitest";
import { saveSharedStudioAsset } from "./studio-shared-assets";
const id = "00000000-0000-0000-0000-000000000001";
const otherId = "00000000-0000-0000-0000-000000000002";
const bytes = Buffer.from("0000ftyp0000test media");
function descriptor(channel: "youtube" | "facebook") {
  return {
    ...studioAssetName(
      {
        masterId: id,
        sourceVersionId: id,
        packageId: id,
        outputId: channel === "youtube" ? id : otherId,
        channel,
        format: channel === "youtube" ? "short" : "reel",
        language: "en",
        aspect: "9:16",
      },
      "mp4",
    ),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    mimeType: "video/mp4",
  };
}
it("stores one actual MP4 for both channels and retries, while keeping their download names distinct", async () => {
  const folder = await mkdtemp(join(realpathSync(tmpdir()), "studio-reuse-"));
  try {
    const store = createPrivateAssetStore(folder);
    const write = vi.spyOn(store, "writeDerivedDescriptor");
    const a = await saveSharedStudioAsset(store, descriptor("youtube"), bytes);
    const b = await saveSharedStudioAsset(store, descriptor("facebook"), bytes);
    await saveSharedStudioAsset(store, descriptor("youtube"), bytes);
    expect(write).toHaveBeenCalledTimes(1);
    expect(a.storageKey).toBe(b.storageKey);
    expect(a.filename).not.toBe(b.filename);
    expect(await store.readDerivedDescriptor(b)).toEqual(bytes);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
it("fails closed on corrupt stored media instead of overwriting an existing shared file", async () => {
  const store = {
    readDerivedDescriptor: vi.fn().mockRejectedValue(Error("ASSET_INTEGRITY_FAILED")),
    writeDerivedDescriptor: vi.fn(),
  };
  await expect(saveSharedStudioAsset(store as never, descriptor("youtube"), bytes)).rejects.toThrow(
    "ASSET_INTEGRITY_FAILED",
  );
  expect(store.writeDerivedDescriptor).not.toHaveBeenCalled();
});

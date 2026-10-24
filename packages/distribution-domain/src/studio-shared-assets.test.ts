import { expect, it } from "vitest";
import { cleanupFiles } from "./storage-cleanup";
import { studioAssetName } from "./studio-assets";
import {
  parseStudioAssetDescriptor,
  parseStudioSharedAssetKey,
  studioSharedAssetKey,
} from "./studio-shared-assets";
import { validateStudioAsset } from "./studio-validation";
const masterId = "00000000-0000-0000-0000-000000000001";
const versionId = "00000000-0000-0000-0000-000000000002";
const packageId = "00000000-0000-0000-0000-000000000003";
function asset(channel: "youtube" | "facebook", outputId: string, hash = "a".repeat(64)) {
  const name = studioAssetName(
    {
      masterId,
      sourceVersionId: versionId,
      packageId,
      outputId,
      channel,
      format: channel === "youtube" ? "short" : "reel",
      language: "en",
      aspect: "9:16",
    },
    "mp4",
  );
  return {
    ...name,
    identityKey: name.storageKey,
    storageKey: studioSharedAssetKey(name.storageKey, hash),
    sha256: hash,
    byteSize: 40,
    mimeType: "video/mp4",
  };
}
it("shares bytes across channels while validating each output's separate binding and filename", () => {
  const a = asset("youtube", masterId);
  const b = asset("facebook", versionId);
  expect(a.storageKey).toBe(b.storageKey);
  expect(a.filename).not.toBe(b.filename);
  validateStudioAsset(a, { masterId, versionId, packageId, outputId: masterId });
  validateStudioAsset(b, { masterId, versionId, packageId, outputId: versionId });
  expect(parseStudioAssetDescriptor(b)?.identity.channel).toBe("facebook");
  expect(cleanupFiles([a, b])).toHaveLength(1);
  expect(() =>
    validateStudioAsset(b, { masterId, versionId, packageId, outputId: masterId }),
  ).toThrow();
});
it("rejects cross-package aliases, incorrect checksums, names and arbitrary storage paths", () => {
  const a = asset("youtube", masterId);
  for (const change of [
    { sha256: "b".repeat(64) },
    { storageKey: a.storageKey.replace(packageId, masterId) },
    { filename: "anything.mp4" },
    { identityKey: undefined },
    { identityKey: "../../wrong.mp4" },
  ])
    expect(() => validateStudioAsset({ ...a, ...change } as never)).toThrow();
  expect(parseStudioSharedAssetKey("../../arbitrary")).toBeNull();
});
it("makes a changed render a new blob, keeping the shared original immutable", () => {
  const old = asset("youtube", masterId);
  const other = asset("facebook", versionId);
  const edited = asset("youtube", masterId, "b".repeat(64));
  expect(edited.storageKey).not.toBe(other.storageKey);
  expect(old.storageKey).toBe(other.storageKey);
  expect(cleanupFiles([edited, other, old])).toHaveLength(2);
});

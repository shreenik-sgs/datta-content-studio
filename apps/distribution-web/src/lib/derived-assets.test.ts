import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrivateAssetStore } from "./private-assets";

describe("DS-DIST-R3 private derived descriptors", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "distribution-derived-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const mp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  async function fixture(name = "preview.mp4", bytes = mp4, mimeType = "video/mp4") {
    const storageKey = `distribution/renders/${randomUUID()}/${name}`;
    await mkdir(join(root, storageKey, ".."), { recursive: true, mode: 0o700 });
    await writeFile(join(root, storageKey), bytes, { mode: 0o600 });
    return {
      storageKey,
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType,
    };
  }
  it("reads exact private video, caption and manifest bytes", async () => {
    const store = createPrivateAssetStore(root);
    for (const [name, bytes, mime] of [
      ["preview.mp4", mp4, "video/mp4"],
      ["captions.vtt", Buffer.from("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nTest\n"), "text/vtt"],
      ["manifest.json", Buffer.from('{"schemaVersion":1}'), "application/json"],
    ] as const) {
      const descriptor = await fixture(name, bytes, mime);
      expect(await store.readDerivedDescriptor(descriptor)).toEqual(bytes);
    }
  });
  it("refuses traversal, alternate filenames, MIME mismatch and unbounded allocation before IO", async () => {
    const store = createPrivateAssetStore(root);
    const good = await fixture();
    for (const changed of [
      { storageKey: "../../outside" },
      { storageKey: good.storageKey.replace("preview.mp4", "secret.txt") },
      { mimeType: "text/html" },
      { sha256: "not-a-checksum" },
      { byteSize: 100 * 1024 * 1024 + 1 },
    ])
      await expect(store.readDerivedDescriptor({ ...good, ...changed })).rejects.toThrow(
        "INVALID_DERIVED_ASSET",
      );
  });
  it("detects tampering, public permissions, bad media signatures and malformed text", async () => {
    const store = createPrivateAssetStore(root);
    const good = await fixture();
    await writeFile(join(root, good.storageKey), Buffer.alloc(mp4.length));
    await expect(store.readDerivedDescriptor(good)).rejects.toThrow("ASSET_INTEGRITY_FAILED");
    const publicFile = await fixture();
    await chmod(join(root, publicFile.storageKey), 0o644);
    await expect(store.readDerivedDescriptor(publicFile)).rejects.toThrow("ASSET_INTEGRITY_FAILED");
    for (const [name, bytes, mime] of [
      ["preview.mp4", Buffer.from("not video"), "video/mp4"],
      ["captions.vtt", Buffer.from("<script>bad</script>"), "text/vtt"],
      ["manifest.json", Buffer.from("not-json"), "application/json"],
    ] as const)
      await expect(store.readDerivedDescriptor(await fixture(name, bytes, mime))).rejects.toThrow(
        "INVALID_DERIVED_MEDIA",
      );
  });
  it("refuses a symlinked derived file or directory", async () => {
    const store = createPrivateAssetStore(root);
    const good = await fixture();
    const target = join(root, "outside");
    await writeFile(target, mp4, { mode: 0o600 });
    await rm(join(root, good.storageKey));
    await symlink(target, join(root, good.storageKey));
    await expect(store.readDerivedDescriptor(good)).rejects.toThrow("SYMLINK_REFUSED");
    const other = await fixture();
    const directory = join(root, other.storageKey, "..");
    await rm(directory, { recursive: true });
    const alternate = join(root, "alternate");
    await mkdir(alternate, { mode: 0o700 });
    await writeFile(join(alternate, "preview.mp4"), mp4, { mode: 0o600 });
    await symlink(alternate, directory);
    await expect(store.readDerivedDescriptor(other)).rejects.toThrow("SYMLINK_REFUSED");
  });
});

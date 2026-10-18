import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_MASTER_BYTES } from "@satsang/distribution-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrivateAssetStore } from "./private-assets";

describe("DS-DIST-R1-ASSET private immutable filesystem storage", () => {
  let root: string;
  const bytes = Buffer.from("ID3-test-private-audio");
  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), "distribution-assets-test-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("DS-DIST-R1-ASSET writes opaque immutable masters privately and validates round-trip", async () => {
    const store = createPrivateAssetStore(join(root, "private"));
    const asset = await store.write({ bytes, mimeType: "audio/mpeg", originalName: "chant.mp3" });
    expect(asset.storageKey).toMatch(/^distribution\/masters\/[a-f0-9-]{36}$/);
    expect(asset.sha256).toHaveLength(64);
    expect(asset.byteSize).toBe(bytes.byteLength);
    expect(await store.read(asset)).toEqual(bytes);
    expect((await stat(join(root, "private", asset.storageKey))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
    const another = await store.write({ bytes, mimeType: "audio/mpeg", originalName: "chant.mp3" });
    expect(another.storageKey).not.toBe(asset.storageKey);
  });
  it("DS-DIST-R1-ASSET refuses relative public and repository storage roots", () => {
    expect(() => createPrivateAssetStore("./uploads")).toThrow("INVALID_PRIVATE_ROOT");
    expect(() => createPrivateAssetStore(resolve("public", "masters"))).toThrow(
      "INVALID_PRIVATE_ROOT",
    );
    expect(() => createPrivateAssetStore(resolve("src", "masters"))).toThrow(
      "INVALID_PRIVATE_ROOT",
    );
    expect(() => createPrivateAssetStore(join(root, "static", "masters"))).toThrow(
      "INVALID_PRIVATE_ROOT",
    );
  });
  it("DS-DIST-R1-ASSET rejects mismatched signatures malformed metadata and traversal", async () => {
    const store = createPrivateAssetStore(join(root, "private"));
    await expect(
      store.write({ bytes, mimeType: "image/png", originalName: "fake.png" }),
    ).rejects.toThrow("INVALID_MEDIA");
    await expect(
      store.write({ bytes, mimeType: "audio/mpeg", originalName: "../chant.mp3" }),
    ).rejects.toThrow("INVALID_FILENAME");
    await expect(
      store.write({ bytes, mimeType: "audio/mpeg", originalName: "bad\u0000.mp3" }),
    ).rejects.toThrow("INVALID_FILENAME");
    const asset = await store.write({ bytes, mimeType: "audio/mpeg", originalName: "chant.mp3" });
    await expect(store.read({ ...asset, storageKey: "../../secret" })).rejects.toThrow(
      "INVALID_ASSET",
    );
    await expect(
      store.removeUnreferenced({ ...asset, storageKey: "../../secret" }),
    ).rejects.toThrow("INVALID_ASSET");
    await expect(store.read({ ...asset, sha256: "incorrect" })).rejects.toThrow("INVALID_ASSET");
  });
  it("DS-DIST-R1-ASSET detects byte and size tampering on every read", async () => {
    const store = createPrivateAssetStore(join(root, "private"));
    const asset = await store.write({ bytes, mimeType: "audio/mpeg", originalName: "chant.mp3" });
    await writeFile(join(root, "private", asset.storageKey), Buffer.from("ID3-altered"));
    await expect(store.read(asset)).rejects.toThrow("ASSET_INTEGRITY_FAILED");
  });
  it("DS-DIST-R1-ASSET refuses root and asset symlinks", async () => {
    const target = join(root, "target");
    await writeFile(target, bytes);
    const alias = join(root, "alias");
    await symlink(root, alias);
    await expect(
      createPrivateAssetStore(alias).write({
        bytes,
        mimeType: "audio/mpeg",
        originalName: "chant.mp3",
      }),
    ).rejects.toThrow("SYMLINK_REFUSED");
    const store = createPrivateAssetStore(join(root, "private"));
    const asset = await store.write({ bytes, mimeType: "audio/mpeg", originalName: "chant.mp3" });
    const path = join(root, "private", asset.storageKey);
    await rm(path);
    await symlink(target, path);
    await expect(store.read(asset)).rejects.toThrow("SYMLINK_REFUSED");
    await expect(store.removeUnreferenced(asset)).rejects.toThrow("SYMLINK_REFUSED");
    expect(await readFile(target)).toEqual(bytes);
  });
  it("DS-DIST-R1-ASSET cleans only the just-created unreferenced file", async () => {
    const store = createPrivateAssetStore(join(root, "private"));
    const asset = await store.write({ bytes, mimeType: "audio/mpeg", originalName: "chant.mp3" });
    await store.removeUnreferenced(asset);
    await expect(store.read(asset)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("DS-DIST-R1-ASSET rejects oversized input before writing any master", async () => {
    const store = createPrivateAssetStore(join(root, "private"));
    const oversized = new Uint8Array(MAX_MASTER_BYTES + 1);
    oversized.set(Buffer.from("ID3"));
    await expect(
      store.write({ bytes: oversized, mimeType: "audio/mpeg", originalName: "large.mp3" }),
    ).rejects.toThrow("UPLOAD_TOO_LARGE");
    await expect(stat(join(root, "private"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("DS-DIST-R1-ASSET checks checksum even when altered media has unchanged length", async () => {
    const store = createPrivateAssetStore(join(root, "private"));
    const asset = await store.write({ bytes, mimeType: "audio/mpeg", originalName: "chant.mp3" });
    const altered = Buffer.from(bytes);
    altered[altered.length - 1] = 33;
    await writeFile(join(root, "private", asset.storageKey), altered);
    await expect(store.read(asset)).rejects.toThrow("ASSET_INTEGRITY_FAILED");
  });
});

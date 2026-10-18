import { describe, expect, it } from "vitest";
import { distributionWorld, validatePrivateAsset } from "./repository.js";

describe("DS-DIST-R1-CONTENT repository trust boundary", () => {
  it("DS-DIST-R1-CONTENT requires an explicit world for every operation", () => {
    expect(distributionWorld({ userId: "operator", isTest: true })).toBe(true);
    expect(distributionWorld({ userId: "operator", isTest: false })).toBe(false);
    expect(() => distributionWorld({ userId: "operator" } as never)).toThrow("INVALID_WORLD");
  });
  it("DS-DIST-R1-ASSET rejects caller paths and invalid checksums", () => {
    const asset = {
      storageKey: "distribution/masters/019434f0-0ce2-4859-bdb5-d40d44387099",
      sha256: "a".repeat(64),
      byteSize: 100,
      mimeType: "audio/mpeg",
      originalName: "chant.mp3",
    };
    expect(() => validatePrivateAsset(asset)).not.toThrow();
    expect(() => validatePrivateAsset({ ...asset, storageKey: "../../private" })).toThrow(
      "INVALID_ASSET",
    );
    expect(() => validatePrivateAsset({ ...asset, sha256: "abc" })).toThrow("INVALID_ASSET");
    expect(() => validatePrivateAsset({ ...asset, byteSize: 0 })).toThrow("INVALID_ASSET");
  });
});

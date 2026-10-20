import { randomUUID } from "node:crypto";
import {
  MAX_STUDIO_VIDEO_BYTES,
  studioAssetName,
  validateStudioAsset,
} from "@satsang/distribution-domain";
import { expect, it } from "vitest";
import { validateDerived } from "./validation";

it("accepts high-fidelity Studio exports consistently while bounding allocation before IO", () => {
  const asset = {
    ...studioAssetName(
      {
        masterId: randomUUID(),
        sourceVersionId: randomUUID(),
        packageId: randomUUID(),
        outputId: randomUUID(),
        channel: "youtube",
        format: "short",
        language: "en",
        aspect: "9:16",
        fileVersion: 2,
        renderId: "abcdef12",
      },
      "mp4",
    ),
    sha256: "a".repeat(64),
    mimeType: "video/mp4",
    byteSize: 160 * 1024 * 1024,
  };
  expect(() => validateStudioAsset(asset)).not.toThrow();
  expect(validateDerived(asset)).toBe(MAX_STUDIO_VIDEO_BYTES);
  for (const byteSize of [MAX_STUDIO_VIDEO_BYTES + 1, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    expect(() => validateStudioAsset({ ...asset, byteSize })).toThrow();
    expect(() => validateDerived({ ...asset, byteSize })).toThrow("INVALID_DERIVED_ASSET");
  }
});

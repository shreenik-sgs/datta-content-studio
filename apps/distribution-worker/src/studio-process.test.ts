import { describe, expect, it } from "vitest";
import { validateStudioSourceDimensions } from "./studio-process";

describe("untrusted Studio video decode dimensions", () => {
  it("admits bounded video dimensions and audio-only sources", () => {
    expect(() =>
      validateStudioSourceDimensions([
        { codec_type: "video", width: 4096, height: 4096 },
        { codec_type: "audio" },
      ]),
    ).not.toThrow();
    expect(() => validateStudioSourceDimensions([{ codec_type: "audio" }])).not.toThrow();
  });
  it.each([
    { width: 4096, height: 4097 },
    { width: 100_000, height: 100_000 },
    { width: 0, height: 1080 },
    { width: -1, height: 1080 },
    { width: 1920.5, height: 1080 },
    { width: Number.NaN, height: 1080 },
    { width: 1920, height: Number.POSITIVE_INFINITY },
    { width: 1920 },
  ])("rejects invalid or excessive dimensions before transcription or encoding", (dimensions) => {
    expect(() => validateStudioSourceDimensions([{ codec_type: "video", ...dimensions }])).toThrow(
      "STUDIO_MEDIA_DIMENSIONS_INVALID",
    );
  });
});

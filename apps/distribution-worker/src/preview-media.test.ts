import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type PreviewClipRequest, previewClipArguments } from "./preview-media";
const fixture: PreviewClipRequest = {
  world: "TEST",
  publishAllowed: false,
  sourcePath: join(realpathSync(tmpdir()), "master.mp4"),
  sourceSha256: "a".repeat(64),
  backdropPath: join(realpathSync(tmpdir()), "backdrop.png"),
  backdropSha256: "b".repeat(64),
  outputPath: join(realpathSync(tmpdir()), "clip.mp4"),
  startMs: 10000,
  endMs: 55000,
  durationMs: 100000,
  size: "vertical",
};
describe("branded local media preview", () => {
  it("preserves contained source framing, original audio, and exact source duration", () => {
    const args = previewClipArguments(fixture);
    expect(args[args.indexOf("-ss") + 1]).toBe("10.000");
    expect(args[args.indexOf("-t") + 1]).toBe("45.000");
    expect(args).toContain("1:a:0");
    expect(args.join(" ")).toContain("force_original_aspect_ratio=decrease");
    expect(args.join(" ")).toContain("overlay=0:570");
    expect(args).toContain("-n");
  });
  it("refuses production and invalid or truncated source boundaries", () => {
    expect(() => previewClipArguments({ ...fixture, world: "PROD" as "TEST" })).toThrow(
      "PREVIEW_ONLY",
    );
    expect(() => previewClipArguments({ ...fixture, publishAllowed: true as false })).toThrow(
      "PREVIEW_ONLY",
    );
    for (const update of [{ startMs: -1 }, { endMs: 100001 }, { endMs: 9000 }, { startMs: 1.5 }])
      expect(() => previewClipArguments({ ...fixture, ...update })).toThrow(
        "INVALID_PREVIEW_BOUNDARY",
      );
    expect(() =>
      previewClipArguments({ ...fixture, sourcePath: "https://example.test/v.mp4" }),
    ).toThrow("LOCAL_FILE_REQUIRED");
  });
  it("enforces the standard X duration ceiling and creates its separate resolution", () => {
    expect(previewClipArguments({ ...fixture, size: "x" }).join(" ")).toContain("scale=720:1280");
    expect(() =>
      previewClipArguments({
        ...fixture,
        size: "x",
        startMs: 0,
        endMs: 140001,
        durationMs: 200000,
      }),
    ).toThrow("INVALID_PREVIEW_BOUNDARY");
  });
});

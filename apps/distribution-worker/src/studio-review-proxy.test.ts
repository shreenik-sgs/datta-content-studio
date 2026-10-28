import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { studioReviewProxy } from "./studio-presentation-review";
import { executeStudioSource } from "./studio-process";
vi.mock("./studio-process", () => ({ executeStudioSource: vi.fn() }));

it("accepts a complete long-story proxy above the old 16 MiB cap without reducing review fidelity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-proxy-synthetic-"));
  const path = join(directory, "review.mp4");
  try {
    vi.mocked(executeStudioSource).mockImplementation(async () => {
      await writeFile(path, "synthetic proxy bytes");
      await truncate(path, 17 * 1024 * 1024);
      return { stdout: "", stderr: "" } as never;
    });
    const result = await studioReviewProxy({
      ffmpeg: "synthetic-ffmpeg",
      directory,
      filename: "review.mp4",
      sourcePath: "/synthetic/source.mp4",
      startMs: 10000,
      endMs: 1810000,
    });
    expect(result.equals(await readFile(path))).toBe(true);
    const invocation = vi.mocked(executeStudioSource).mock.calls.at(-1)?.[0];
    expect(invocation?.args).toEqual(
      expect.arrayContaining([
        "-ss",
        "10",
        "-t",
        "1800",
        "-r",
        "12",
        "-b:v",
        "350k",
        "-b:a",
        "64k",
        "scale=720:720:force_original_aspect_ratio=decrease:force_divisible_by=2",
      ]),
    );
    expect(invocation?.timeoutMs).toBe(1800000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("bounds oversized proxy files before reading them into memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-proxy-synthetic-"));
  const path = join(directory, "review.mp4");
  try {
    vi.mocked(executeStudioSource).mockImplementation(async () => {
      await writeFile(path, "synthetic");
      await truncate(path, 129 * 1024 * 1024);
      return { stdout: "", stderr: "" } as never;
    });
    await expect(
      studioReviewProxy({
        ffmpeg: "synthetic-ffmpeg",
        directory,
        filename: "review.mp4",
        sourcePath: "/synthetic/source.mp4",
        startMs: 0,
        endMs: 1800000,
      }),
    ).rejects.toThrow("STUDIO_PRESENTATION_REVIEW_MEDIA_TOO_LARGE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_STUDIO_VIDEO_BYTES } from "@satsang/distribution-domain";
import { afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("./studio-process.js", () => ({ executeStudioSource: mocked.execute }));
import { renderStudioVideo } from "./studio-media";

afterEach(() => vi.clearAllMocks());

it("accepts a Studio render above the old preview limit and rejects bytes above the asset contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-render-limit-"));
  let bytes = MAX_STUDIO_VIDEO_BYTES;
  mocked.execute.mockImplementation(async (input: { args: string[] }) => {
    // Sparse synthetic output exercises the real post-render size guard without
    // encoding series media or allocating a full-size video in the test process.
    const file = await open(input.args.at(-1) ?? "", "w");
    try {
      await file.truncate(bytes);
    } finally {
      await file.close();
    }
  });
  const input = {
    ffmpeg: "/synthetic/ffmpeg",
    directory,
    sourcePath: join(directory, "synthetic-source.mp4"),
    mimeType: "video/mp4",
    backdrop: new Uint8Array(),
    hasVideo: false,
    hasAudio: false,
    startMs: 0,
    endMs: 923000,
    captions: [],
  };
  try {
    const path = await renderStudioVideo(input);
    expect((await stat(path)).size).toBe(MAX_STUDIO_VIDEO_BYTES);
    bytes++;
    await expect(renderStudioVideo(input)).rejects.toThrow("RENDER_OUTPUT_TOO_LARGE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

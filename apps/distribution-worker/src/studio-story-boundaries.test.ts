import { expect, it, vi } from "vitest";
import { reviewStudioClipBoundaries } from "./studio-boundary-review";
import { executeStudioSource } from "./studio-process";
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from("synthetic-audio")),
}));
vi.mock("./studio-process.js", () => ({ executeStudioSource: vi.fn(async () => {}) }));
it("reviews a ten-minute story's complete audio and both cut edges without truncating it to a Short", async () => {
  const finding = {
    verdict: "complete",
    audibleWords: "Complete native words",
    meaning: "The full setup or conclusion.",
    reason: "The audible sentence is complete.",
    needsOutsideSpeech: false,
    cutDuringWord: false,
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      candidates: [
        {
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: JSON.stringify(finding) }] },
        },
      ],
    }),
  );
  const input = {
    apiKey: "synthetic",
    model: "synthetic",
    fetcher,
    sourcePath: "/synthetic.mp4",
    mimeType: "video/mp4",
    directory: "/synthetic",
    ffmpeg: "ffmpeg",
    language: "te",
    startMs: 5000,
    endMs: 605000,
    included: [],
    outside: [],
  };
  const result = await reviewStudioClipBoundaries(input);
  expect(result.startMs).toBe(5000);
  expect(result.endMs).toBe(605000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const args = vi.mocked(executeStudioSource).mock.calls.map(([v]) => v.args);
  expect(args.map((a) => a[a.indexOf("-t") + 1])).toEqual(["600", "30", "30"]);
  expect(args.map((a) => a[a.indexOf("-ss") + 1])).toEqual(["5", "5", "575"]);
  await expect(reviewStudioClipBoundaries({ ...input, endMs: 1805001 })).rejects.toThrow(
    "STUDIO_VIDEO_REVIEW_INVALID",
  );
});

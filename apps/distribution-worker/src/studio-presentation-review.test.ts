import { expect, it, vi } from "vitest";
import { reviewStudioPresentation, screenStudioSource } from "./studio-presentation-review";
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: JSON.stringify(value) }] },
        },
      ],
    }),
  );
const screen = {
  openingComplete: true,
  endingComplete: true,
  naturalStart: true,
  naturalEnd: true,
  reason: "Complete meaning and settled ending.",
  scenes: [],
  illustrations: [],
};
const input = {
  apiKey: "synthetic-key",
  model: "gemini-test",
  video: Buffer.from("synthetic-media"),
  durationMs: 20000,
  segments: [{ id: "one", startMs: 100000, endMs: 110000, text: "Relevant scripture study." }],
  clipStartMs: 100000,
  context: { humanFeedback: ["Preserve the Telugu name"] },
};
it("screens the actual audiovisual excerpt and includes human feedback without treating it as instructions", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(screen));
  expect(await screenStudioSource({ ...input, fetcher })).toEqual({
    ...screen,
    illustrationPolicy: "context-rich-v2",
  });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.contents[0].parts[1].inlineData).toEqual({
    mimeType: "video/mp4",
    data: input.video.toString("base64"),
  });
  expect(body.systemInstruction.parts[0].text).toContain("untrusted");
  expect(body.systemInstruction.parts[0].text).toContain("fade cannot repair");
  expect(body.systemInstruction.parts[0].text).toContain("bodyTop must be 0");
  expect(body.systemInstruction.parts[0].text).toContain(
    "Background artwork and a lower-third banner alone do not justify a full-picture fallback",
  );
  expect(body.systemInstruction.parts[0].text).toContain(
    "Retain the full picture when the actual crop would cut meaningful text",
  );
  expect(body.systemInstruction.parts[0].text).toContain("Original speaker footage is the default");
  expect(body.systemInstruction.parts[0].text).toContain("Return zero illustrations");
  expect(body.contents[0].parts[0].text).toContain("Preserve the Telugu name");
});
it("rejects an unchecked opening, malformed scenes and a guessed top crop", async () => {
  for (const value of [
    { ...screen, naturalEnd: undefined },
    { ...screen, scenes: [{ startMs: 0, endMs: 20000, bodyTop: 0.12, bodyBottom: 0.9 }] },
  ]) {
    await expect(
      screenStudioSource({
        ...input,
        fetcher: vi.fn<typeof fetch>().mockImplementation(async () => response(value)),
      }),
    ).rejects.toThrow("STUDIO_PRESENTATION_REVIEW_INVALID");
  }
});
it("compares the full original excerpt and actual render, rejecting incomplete review evidence", async () => {
  const checks = {
    illustrationsRelevant: true,
    textIntact: true,
    subjectIntact: true,
    captionsClear: false,
    naturalBoundaries: true,
    reason: "Subtitle crosses the visible frame edge at 00:07.",
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(checks));
  expect(
    await reviewStudioPresentation({
      ...input,
      source: input.video,
      rendered: Buffer.from("rendered-fixture"),
      fetcher,
    }),
  ).toEqual(checks);
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.contents[0].parts).toHaveLength(3);
  expect(body.systemInstruction.parts[0].text).toContain("following page is not truncated");
  expect(body.systemInstruction.parts[0].text).toContain("SHARP foreground picture");
  await expect(
    reviewStudioPresentation({
      ...input,
      source: input.video,
      rendered: Buffer.from("rendered-fixture"),
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ ...checks, illustrationsRelevant: undefined })),
    }),
  ).rejects.toThrow("STUDIO_PRESENTATION_REVIEW_INVALID");
});
it("never sends media without a valid configured visual reviewer", async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(screenStudioSource({ ...input, apiKey: "", fetcher })).rejects.toThrow(
    "STUDIO_PRESENTATION_NOT_CONFIGURED",
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("repairs an out-of-citation storyboard once using explicit relative timings before image generation", async () => {
  const shot = {
    assetId: "generated-one",
    startMs: 10000,
    endMs: 13000,
    sourceSegmentIds: ["one"],
    reason: "Reading the cited teaching.",
    prompt: "Relevant unlettered scripture book in a tranquil garden.",
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ ...screen, illustrations: [shot] }))
    .mockResolvedValueOnce(
      response({ ...screen, illustrations: [{ ...shot, startMs: 6000, endMs: 10000 }] }),
    );
  const result = await screenStudioSource({ ...input, fetcher });
  expect(result.illustrations?.[0]).toMatchObject({ startMs: 6000, endMs: 10000 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
  const context = JSON.parse(body.contents[0].parts[0].text);
  expect(context.selectedSegmentsRelativeToExcerpt).toEqual([
    { ...input.segments[0], startMs: 0, endMs: 10000 },
  ]);
  expect(context.correction.validation).toBe("STUDIO_ILLUSTRATION_INVALID");
  expect(body.systemInstruction.parts[0].text).toContain("Books or manuscripts are appropriate");
  const invalid = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => response({ ...screen, illustrations: [shot] }));
  await expect(screenStudioSource({ ...input, fetcher: invalid })).rejects.toThrow(
    "STUDIO_ILLUSTRATION_INVALID",
  );
  expect(invalid).toHaveBeenCalledTimes(2);
});

it("compares delivered foreground pixels without the blurred background and preserves a failed verdict", async () => {
  const { default: sharp } = await import("sharp");
  const { studioReviewFitFrame } = await import("./studio-presentation-review");
  const foreground = await sharp({
    create: { width: 12, height: 6, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const rendered = await sharp({
    create: { width: 12, height: 20, channels: 3, background: "blue" },
  })
    .composite([{ input: foreground, left: 0, top: 7 }])
    .png()
    .toBuffer();
  const isolated = await studioReviewFitFrame(rendered, { x: 0, y: 7, width: 12, height: 6 });
  expect(await sharp(isolated).raw().toBuffer()).toEqual(
    await sharp(foreground).ensureAlpha().raw().toBuffer(),
  );
  const checks = {
    illustrationsRelevant: true,
    textIntact: false,
    subjectIntact: true,
    captionsClear: true,
    naturalBoundaries: true,
    reason: "A genuine foreground loss still fails.",
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(checks));
  expect(
    await reviewStudioPresentation({
      ...input,
      source: input.video,
      rendered: Buffer.from("rendered-video"),
      frames: [{ atMs: 1000, source: foreground, rendered, foreground: isolated }],
      fetcher,
    }),
  ).toEqual(checks);
  const parts = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).contents[0].parts;
  expect(parts.at(-2).text).toContain("actual sharp foreground pixels");
  expect(parts.at(-1).inlineData.data).toBe(isolated.toString("base64"));
});

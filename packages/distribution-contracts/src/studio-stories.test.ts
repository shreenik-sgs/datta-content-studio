import { expect, it } from "vitest";
import { studioGenerationRequestSchema, studioRegenerateSchema } from "./intelligent-content";
const request = {
  channels: ["youtube"],
  languages: ["en"],
  instructions: "Complete stories",
  captions: true,
  allCompleteMessages: true,
};
it("accepts append-only story discovery and retains the existing default for Shorts", () => {
  expect(studioGenerationRequestSchema.parse(request).youtubeFormat).toBeUndefined();
  expect(
    studioRegenerateSchema.parse({
      expectedRevision: 2,
      mode: "discover",
      request: { ...request, youtubeFormat: "video" },
    }).request?.youtubeFormat,
  ).toBe("video");
  expect(
    studioRegenerateSchema.safeParse({
      expectedRevision: 2,
      mode: "discover",
      request: { ...request, youtubeFormat: "video" },
      outputIds: ["11111111-1111-4111-8111-111111111111"],
    }).success,
  ).toBe(false);
  expect(
    studioGenerationRequestSchema.safeParse({ ...request, youtubeFormat: "anything" }).success,
  ).toBe(false);
});

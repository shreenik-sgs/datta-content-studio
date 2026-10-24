import { expect, it } from "vitest";
import { studioGenerationRequestSchema, studioRegenerateSchema } from "./intelligent-content";
const id = "840b1382-c86f-46ce-a47f-1345cb7c6231";
it("accepts a targeted closing-card repair with explicit existing-image timing", () => {
  const command = {
    expectedRevision: 20,
    outputIds: [id],
    mode: "closing",
    illustrationTimings: [{ assetId: "generated-one", startMs: 7000, endMs: 13000 }],
  };
  expect(studioRegenerateSchema.parse(command)).toEqual(command);
  for (const change of [
    { mode: "ai" },
    { outputIds: undefined },
    { illustrationTimings: [{ assetId: "../file", startMs: 0, endMs: 1 }] },
  ])
    expect(() => studioRegenerateSchema.parse({ ...command, ...change })).toThrow();
});

it("scopes a steady opening repair to one existing output", () => {
  const command = { expectedRevision: 22, outputIds: [id], mode: "closing", steadyOpening: true };
  expect(studioRegenerateSchema.parse(command)).toEqual(command);
  for (const change of [
    { mode: "ai" },
    { outputIds: undefined },
    { outputIds: [id, "d11a1dba-5a61-4f8a-8bd0-4e5104972534"] },
  ])
    expect(() => studioRegenerateSchema.parse({ ...command, ...change })).toThrow();
});

it("only changes closing destinations for explicitly selected outputs", () => {
  const command = {
    expectedRevision: 2,
    outputIds: [id],
    mode: "render",
    closingDestinations: { [id]: "youtube" },
  };
  expect(studioRegenerateSchema.parse(command)).toEqual(command);
  for (const change of [
    { mode: "ai" },
    { outputIds: undefined },
    { closingDestinations: {} },
    { closingDestinations: { "d11a1dba-5a61-4f8a-8bd0-4e5104972534": "youtube" } },
    { closingDestinations: { [id]: "untrusted-url" } },
  ])
    expect(() => studioRegenerateSchema.parse({ ...command, ...change })).toThrow();
});

it("accepts and canonicalizes a package-specific YouTube closing target", () => {
  const request = {
    languages: ["en"],
    channels: ["youtube"],
    captions: true,
    instructions: "",
    youtubeClosing: { label: " Gurubhavana ADPT ", url: "https://youtube.com/@gurubhavanaadpt/" },
  };
  expect(studioGenerationRequestSchema.parse(request).youtubeClosing).toEqual({
    label: "Gurubhavana ADPT",
    url: "https://www.youtube.com/@gurubhavanaadpt",
  });
  for (const youtubeClosing of [
    null,
    { label: "Bad", url: "javascript:alert(1)" },
    { ...request.youtubeClosing, injected: true },
  ])
    expect(studioGenerationRequestSchema.safeParse({ ...request, youtubeClosing }).success).toBe(
      false,
    );
});

it("requires an explicit closing destination without restricting target channels by speaker", () => {
  const request = {
    languages: ["en"],
    channels: ["youtube"],
    captions: true,
    instructions: "",
    sourceBranding: "bala-swamiji",
    youtubeClosing: { label: "Gurubhavana ADPT", url: "https://www.youtube.com/@gurubhavanaadpt" },
  };
  expect(studioGenerationRequestSchema.safeParse(request).success).toBe(true);
  expect(
    studioGenerationRequestSchema.safeParse({
      ...request,
      channels: ["youtube", "facebook", "website"],
    }).success,
  ).toBe(true);
  for (const change of [{ youtubeClosing: undefined }, { sourceBranding: "injected-teacher" }])
    expect(studioGenerationRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
});

it("keeps additional discovery separate from existing-file repair", () => {
  expect(studioRegenerateSchema.parse({ expectedRevision: 3, mode: "discover" })).toEqual({
    expectedRevision: 3,
    mode: "discover",
  });
  for (const change of [
    { outputIds: [id] },
    { steadyOpening: true },
    { closingDestinations: { [id]: "youtube" } },
  ])
    expect(() =>
      studioRegenerateSchema.parse({ expectedRevision: 3, mode: "discover", ...change }),
    ).toThrow();
});

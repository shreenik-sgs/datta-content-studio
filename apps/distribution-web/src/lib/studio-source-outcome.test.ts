import { expect, it } from "vitest";
import { value } from "../app/studio-workflow-fixture";
import {
  studioSourceSkipReasons,
  studioSourceVideo,
  studioSourceWithoutTeaching,
} from "./studio-source-outcome";

it("does not classify provider failures or existing Shorts as an empty teaching selection", () => {
  expect(studioSourceWithoutTeaching({ ...value, failure: "STUDIO_NO_SUITABLE_CHANNELS" })).toBe(
    false,
  );
  expect(
    studioSourceWithoutTeaching({
      ...value,
      outputs: [],
      status: "FAILED",
      failure: "STUDIO_PROVIDER_UNAVAILABLE",
    }),
  ).toBe(false);
  expect(
    studioSourceWithoutTeaching({
      ...value,
      outputs: [],
      status: "FAILED",
      failure: "STUDIO_NO_SUITABLE_CHANNELS",
    }),
  ).toBe(true);
  expect(studioSourceSkipReasons(value)).toEqual([]);
});

it("links only recognized original-video URLs, never arbitrary schemes or playlist destinations", () => {
  expect(studioSourceVideo("https://youtu.be/0UO6eFncU9I")?.url).toBe(
    "https://www.youtube.com/watch?v=0UO6eFncU9I",
  );
  for (const link of [
    "javascript:alert(1)",
    "https://example.com/video",
    "https://www.youtube.com/playlist?list=PL1234567890123",
  ])
    expect(studioSourceVideo(link)).toBeUndefined();
});

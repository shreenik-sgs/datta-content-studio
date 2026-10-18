import { expect, it } from "vitest";
import { studioCapacity } from "./studio-capacity";
it("defaults to one worker slot and scales bounded queue/prefetch together", () => {
  expect(studioCapacity({})).toEqual({ generation: 1, queue: 2, prefetch: 3 });
  expect(studioCapacity({ STUDIO_GENERATION_CONCURRENCY: "5" })).toEqual({
    generation: 5,
    queue: 6,
    prefetch: 7,
  });
});
it.each(["0", "9", "Infinity", "1.5", "-1", "", "5workers"])(
  "rejects unsafe capacity %s",
  (value) => {
    expect(() => studioCapacity({ STUDIO_GENERATION_CONCURRENCY: value })).toThrow(
      "INVALID_STUDIO_GENERATION_CONCURRENCY",
    );
  },
);

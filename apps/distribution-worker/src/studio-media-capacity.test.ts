import { expect, it, vi } from "vitest";
import { createStudioMediaSlots, studioMediaCapacity } from "./studio-media-capacity";

it("serializes media work while unrelated provider work can proceed, releasing after failure", async () => {
  const run = createStudioMediaSlots(1);
  let finish = () => {};
  const events: string[] = [];
  const first = run(async () => {
    events.push("first");
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    throw Error("fixture");
  });
  const outcome = first.catch((error) => error.message);
  const second = run(async () => {
    events.push("second");
    return "complete";
  });
  await Promise.resolve();
  events.push("AI request can proceed");
  expect(events).toEqual(["first", "AI request can proceed"]);
  finish();
  expect(await outcome).toBe("fixture");
  expect(await second).toBe("complete");
  expect(events.at(-1)).toBe("second");
});
it("removes cancelled waiters without leaking capacity or starting their process", async () => {
  const run = createStudioMediaSlots(1);
  let finish = () => {};
  const first = run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  const stop = new AbortController();
  const operation = vi.fn();
  const cancelled = run(operation, stop.signal).catch((error) => error.message);
  stop.abort();
  expect(await cancelled).toBe("RENDER_CANCELLED");
  finish();
  await first;
  expect(await run(async () => "next")).toBe("next");
  expect(operation).not.toHaveBeenCalled();
});
it("bounds queue waiting separately from executable time and recovers the slot", async () => {
  vi.useFakeTimers();
  try {
    const run = createStudioMediaSlots(1, 20);
    let finish = () => {};
    const first = run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const second = run(async () => "must not run").catch((error) => error.message);
    await vi.advanceTimersByTimeAsync(20);
    expect(await second).toBe("RENDER_TIMEOUT");
    finish();
    await first;
    expect(await run(async () => "next")).toBe("next");
  } finally {
    vi.useRealTimers();
  }
});
it("validates media capacity separately from generation concurrency", () => {
  expect(studioMediaCapacity({ STUDIO_GENERATION_CONCURRENCY: "2" })).toBe(1);
  expect(studioMediaCapacity({ STUDIO_MEDIA_PROCESS_CONCURRENCY: "2" })).toBe(2);
  for (const value of ["0", "5", "NaN", "1.5"])
    expect(() => studioMediaCapacity({ STUDIO_MEDIA_PROCESS_CONCURRENCY: value })).toThrow(
      "INVALID_STUDIO_MEDIA_CONCURRENCY",
    );
});

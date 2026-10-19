import { afterEach, expect, it, vi } from "vitest";
import { StudioProviderError } from "./studio-provider-error";
import { retrySarvamSection } from "./studio-sarvam-section-retry";

afterEach(() => vi.useRealTimers());
const rate = (delay = 0) =>
  new StudioProviderError("STUDIO_PROVIDER_RATE_LIMITED", delay, false, true);

it("honors provider cooldown and independently budgets each successfully resumed section", async () => {
  vi.useFakeTimers();
  for (let section = 0; section < 4; section++) {
    const run = vi.fn().mockRejectedValueOnce(rate(125000)).mockResolvedValueOnce(section);
    const onWait = vi.fn(async () => {});
    const started = Date.now();
    const task = retrySarvamSection({ run, onWait });
    await vi.advanceTimersByTimeAsync(124999);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledWith(new Date(started + 125000).toISOString());
    await vi.advanceTimersByTimeAsync(1);
    expect(await task).toBe(section);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onWait).toHaveBeenLastCalledWith(null);
  }
});

it("stops after three attempts on the same section", async () => {
  vi.useFakeTimers();
  const run = vi.fn().mockRejectedValue(rate());
  const task = retrySarvamSection({ run, onWait: vi.fn(async () => {}) });
  const rejected = expect(task).rejects.toThrow("STUDIO_PROVIDER_RATE_LIMITED");
  await vi.advanceTimersByTimeAsync(180000);
  await rejected;
  expect(run).toHaveBeenCalledTimes(3);
});

it.each([
  new StudioProviderError("STUDIO_PROVIDER_RATE_LIMITED", 0, false, false),
  rate(3600001),
  new StudioProviderError("STUDIO_PROVIDER_QUOTA_EXHAUSTED", 0, false, true),
  new StudioProviderError("STUDIO_PROVIDER_TIMEOUT", 0, false, false),
  new StudioProviderError("STUDIO_PROVIDER_AUTHENTICATION_FAILED", 0, false, true),
])(
  "does not repeat uncertain work, exhausted quota, authentication or excessive cooldown",
  async (error) => {
    const run = vi.fn().mockRejectedValue(error);
    const onWait = vi.fn(async () => {});
    await expect(retrySarvamSection({ run, onWait })).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onWait).not.toHaveBeenCalled();
  },
);

it("stops promptly during cooldown while preserving safe resumability", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const run = vi.fn().mockRejectedValue(rate());
  const task = retrySarvamSection({
    run,
    onWait: vi.fn(async () => {}),
    signal: controller.signal,
  });
  const rejected = expect(task).rejects.toMatchObject({
    message: "STUDIO_PROVIDER_ABORTED",
    transcriptionResumable: true,
  });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await rejected;
  expect(run).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

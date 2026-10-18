import { afterEach, expect, it, vi } from "vitest";
import { fetchGeminiWithRetry } from "./studio-provider-retry";
afterEach(() => vi.useRealTimers());
const url = "https://generativelanguage.googleapis.com/v1beta/models/test:generateContent";
it("recovers from explicit 503 refusals using the identical request", async () => {
  vi.useFakeTimers();
  const request = { method: "POST", body: "synthetic only" };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response("ok"));
  const pending = fetchGeminiWithRetry(fetcher, url, request);
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(8000);
  expect((await pending).status).toBe(200);
  expect(fetcher.mock.calls.every(([u, r]) => u === url && r === request)).toBe(true);
});
it("stops after three refused attempts", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(null, { status: 503 }));
  const pending = fetchGeminiWithRetry(fetcher, url, {});
  await vi.runAllTimersAsync();
  expect((await pending).status).toBe(503);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it.each([400, 401, 403, 429])("does not replay HTTP %i", async (status) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
  expect((await fetchGeminiWithRetry(fetcher, url, {})).status).toBe(status);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("honors a provider cooldown longer than the retry window", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 503, headers: { "retry-after": "60" } }));
  expect((await fetchGeminiWithRetry(fetcher, url, {})).status).toBe(503);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("cancels backoff without issuing another request", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
  const pending = fetchGeminiWithRetry(fetcher, url, { signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow("STUDIO_PROVIDER_ABORTED");
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await rejected;
  await vi.runAllTimersAsync();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not replay ambiguous network failures", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network"));
  await expect(fetchGeminiWithRetry(fetcher, url, {})).rejects.toThrow("network");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

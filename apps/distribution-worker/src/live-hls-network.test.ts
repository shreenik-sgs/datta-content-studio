import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { fetchLiveMedia } from "./live-hls";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});
function reply(status = 200, chunks = [Buffer.from("video")], location?: string) {
  mocks.request.mockImplementation((_url, options, receive) => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (e: Error) => void;
    };
    req.destroy = (error) => {
      req.emit("error", error);
    };
    req.end = () =>
      queueMicrotask(() => {
        expect(options.family).toBe(4);
        options.lookup(
          "manifest.googlevideo.com",
          {},
          (error: unknown, address: string, family: number) => {
            expect(error).toBeNull();
            expect(address).toBe("93.184.216.34");
            expect(family).toBe(4);
          },
        );
        const response = Object.assign(new EventEmitter(), {
          statusCode: status,
          headers: location ? { location } : {},
          resume: () => {},
          destroy: (error: Error) => {
            response.emit("error", error);
          },
        });
        receive(response);
        for (const chunk of chunks) response.emit("data", chunk);
        response.emit("end");
      });
    return req;
  });
}
it("pins HTTPS to the validated address without automatic family fallback", async () => {
  reply();
  expect(
    await fetchLiveMedia(
      "https://manifest.googlevideo.com/media",
      100,
      new AbortController().signal,
    ),
  ).toEqual(Buffer.from("video"));
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
});
it("rejects private DNS results before any connection", async () => {
  mocks.lookup.mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  await expect(
    fetchLiveMedia("https://manifest.googlevideo.com/media", 100, new AbortController().signal),
  ).rejects.toThrow("LIVE_STREAM_UNSUPPORTED");
  expect(mocks.request).not.toHaveBeenCalled();
});
it("revalidates redirect destinations and bounds received bytes", async () => {
  reply(302, [], "https://example.com/private");
  await expect(
    fetchLiveMedia("https://manifest.googlevideo.com/media", 100, new AbortController().signal),
  ).rejects.toThrow("LIVE_STREAM_UNSUPPORTED");
  expect(mocks.request).toHaveBeenCalledTimes(1);
  reply(200, [Buffer.alloc(101)]);
  await expect(
    fetchLiveMedia("https://manifest.googlevideo.com/media", 100, new AbortController().signal),
  ).rejects.toThrow("LIVE_FRAGMENT_TOO_LARGE");
});
it("reports throttling and honors cancellation without an outgoing request", async () => {
  reply(429, []);
  await expect(
    fetchLiveMedia("https://manifest.googlevideo.com/media", 100, new AbortController().signal),
  ).rejects.toThrow("ONLINE_PROVIDER_RATE_LIMITED");
  mocks.request.mockClear();
  const stop = new AbortController();
  stop.abort();
  await expect(
    fetchLiveMedia("https://manifest.googlevideo.com/media", 100, stop.signal),
  ).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
});

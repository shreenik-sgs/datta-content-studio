import { afterEach, expect, it, vi } from "vitest";
import { withStudioReviewMedia } from "./studio-review-media";

const origin = "https://generativelanguage.googleapis.com";
const video = Buffer.alloc(17 * 1024 * 1024, 7);
const input = {
  apiKey: "synthetic-key",
  parts: [{ bytes: video, mimeType: "video/mp4" as const }],
};
function provider(options: { state?: string; uploadUrl?: string; mismatch?: boolean } = {}) {
  const files = new Map<string, { name: string; mimeType: string; sizeBytes: string }>();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const address = String(url);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.headers && new Headers(init.headers).get("X-Goog-Upload-Command") === "start") {
      const name = JSON.parse(String(init.body)).file.name;
      const metadata = {
        name,
        mimeType: new Headers(init.headers).get("X-Goog-Upload-Header-Content-Type") ?? "",
        sizeBytes: new Headers(init.headers).get("X-Goog-Upload-Header-Content-Length") ?? "",
      };
      files.set(name, metadata);
      return new Response(null, {
        headers: {
          "x-goog-upload-url":
            options.uploadUrl ?? `${origin}/upload/v1beta/files?upload_id=${name}`,
        },
      });
    }
    const name =
      new URL(address).searchParams.get("upload_id") ?? new URL(address).pathname.slice(8);
    const metadata = files.get(name);
    if (!metadata) throw Error("Unexpected file");
    const file = {
      ...metadata,
      uri: `${origin}/v1beta/${name}`,
      state: init?.method === "POST" ? (options.state ?? "ACTIVE") : "ACTIVE",
      ...(options.mismatch ? { name: "files/not-owned" } : {}),
    };
    return Response.json(init?.method === "POST" ? { file } : file);
  });
  return { fetcher, files };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps small review evidence inline without contacting the Files API", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const parts = [
    { text: "Complete source" },
    { bytes: Buffer.from("abc"), mimeType: "video/mp4" as const },
  ];
  expect(await withStudioReviewMedia({ ...input, parts, fetcher }, async (value) => value)).toEqual(
    [parts[0], { inlineData: { mimeType: "video/mp4", data: "YWJj" } }],
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("uploads both complete large videos, keeps frame evidence in order, and cleans only its own files", async () => {
  const { fetcher, files } = provider();
  const png = Buffer.from("full-resolution-frame");
  const consume = vi.fn(async (parts) => {
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    return parts;
  });
  const result = await withStudioReviewMedia(
    {
      ...input,
      fetcher,
      parts: [
        { text: "Original then rendered" },
        ...input.parts,
        { mimeType: "video/mp4", bytes: video },
        { text: "Speech end" },
        { bytes: png, mimeType: "image/png" },
      ],
    },
    consume,
  );
  expect(result[0]).toEqual({ text: "Original then rendered" });
  expect(result.slice(1, 3)).toEqual(
    [...files.keys()].map((name) => ({
      fileData: { mimeType: "video/mp4", fileUri: `${origin}/v1beta/${name}` },
    })),
  );
  expect(result[3]).toEqual({ text: "Speech end" });
  expect(result[4]).toEqual({
    inlineData: { mimeType: "image/png", data: png.toString("base64") },
  });
  const uploads = fetcher.mock.calls.filter(
    ([, init]) => new Headers(init?.headers).get("X-Goog-Upload-Command") === "upload, finalize",
  );
  expect(uploads).toHaveLength(2);
  for (const [, init] of uploads) {
    expect(Buffer.from(init?.body as Uint8Array).equals(video)).toBe(true);
    expect(new Headers(init?.headers).has("x-goog-api-key")).toBe(false);
    expect(init?.redirect).toBe("error");
  }
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => url),
  ).toEqual([...files.keys()].map((name) => `${origin}/v1beta/${name}`));
  expect(consume).toHaveBeenCalledTimes(1);
});

it("waits for processing before review", async () => {
  const { fetcher } = provider({ state: "PROCESSING" });
  const consume = vi.fn(async () => "reviewed");
  const task = withStudioReviewMedia({ ...input, fetcher }, consume);
  await vi.waitFor(() => expect(fetcher.mock.calls).toHaveLength(2));
  expect(consume).not.toHaveBeenCalled();
  expect(await task).toBe("reviewed");
  expect(consume).toHaveBeenCalledTimes(1);
}, 10000);

it.each(["FAILED", "STATE_UNSPECIFIED"])(
  "fails closed for %s files and still cleans them",
  async (state) => {
    const { fetcher } = provider({ state });
    const consume = vi.fn();
    await expect(withStudioReviewMedia({ ...input, fetcher }, consume)).rejects.toThrow(
      "STUDIO_PRESENTATION_REVIEW_FILE_FAILED",
    );
    expect(consume).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  },
);

it.each([
  "https://evil.example/upload",
  `${origin}/other`,
  `${origin}/upload/v1beta/files#secret`,
  "http://generativelanguage.googleapis.com/upload/v1beta/files",
])("rejects an untrusted upload destination %s before sending bytes", async (uploadUrl) => {
  const { fetcher } = provider({ uploadUrl });
  await expect(withStudioReviewMedia({ ...input, fetcher }, vi.fn())).rejects.toThrow(
    "STUDIO_PROVIDER_INVALID_RESPONSE",
  );
  expect(fetcher.mock.calls).toHaveLength(2); // Start and cleanup only.
  expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${origin}/`))).toBe(true);
});

it("rejects mismatched file identity and never deletes the returned foreign name", async () => {
  const { fetcher } = provider({ mismatch: true });
  await expect(withStudioReviewMedia({ ...input, fetcher }, vi.fn())).rejects.toThrow(
    "STUDIO_PROVIDER_INVALID_RESPONSE",
  );
  expect(fetcher.mock.calls.every(([url]) => !String(url).includes("not-owned"))).toBe(true);
});

it("does not replay an ambiguous upload and redacts transport details", async () => {
  const { fetcher } = provider();
  const original = fetcher.getMockImplementation();
  if (!original) throw Error("Missing fixture");
  fetcher.mockImplementation(async (url, init) => {
    if (new Headers(init?.headers).get("X-Goog-Upload-Command") === "upload, finalize")
      throw Error("secret upload URL");
    return original(url, init);
  });
  await expect(withStudioReviewMedia({ ...input, fetcher }, vi.fn())).rejects.toThrow(
    "STUDIO_PROVIDER_UNAVAILABLE",
  );
  expect(
    fetcher.mock.calls.filter(
      ([, init]) => new Headers(init?.headers).get("X-Goog-Upload-Command") === "upload, finalize",
    ),
  ).toHaveLength(1);
  expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
});

it("cleans uploads after cancellation without starting review", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const { fetcher } = provider({ state: "PROCESSING" });
  const consume = vi.fn();
  const task = withStudioReviewMedia({ ...input, fetcher, signal: controller.signal }, consume);
  const rejected = expect(task).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await rejected;
  expect(consume).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(false);
  expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
});

it("cleans files when review fails, preserving the review error", async () => {
  const { fetcher } = provider();
  await expect(
    withStudioReviewMedia({ ...input, fetcher }, async () => {
      throw Error("review rejected");
    }),
  ).rejects.toThrow("review rejected");
  expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
});

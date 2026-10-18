import { expect, it, vi } from "vitest";
import { findBufferYoutubeChannels } from "./buffer-channels";
it("discovers only YouTube channels without sending media or returning credentials", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ data: { account: { organizations: [{ id: "org-one" }] } } }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: {
          channels: [
            {
              id: "one",
              name: "Datta Sannidhi",
              displayName: "@DattaSannidhi",
              service: "youtube",
              isDisconnected: false,
              isLocked: false,
            },
            {
              id: "two",
              name: "Another",
              service: "youtube",
              isDisconnected: true,
              isLocked: false,
            },
            {
              id: "other",
              name: "Other",
              service: "facebook",
              isDisconnected: false,
              isLocked: false,
            },
          ],
        },
      }),
    );
  expect(await findBufferYoutubeChannels("synthetic-api-key", fetcher)).toEqual([
    { id: "one", label: "@DattaSannidhi", available: true },
    { id: "two", label: "Another", available: false },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [url, options] of fetcher.mock.calls) {
    expect(url).toBe("https://api.buffer.com");
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(String(options?.body)).query).toMatch(/^query /);
    expect(String(options?.body)).not.toContain("synthetic-api-key");
  }
});
it("redacts provider errors and rejects oversized responses", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("synthetic-api-key", { status: 401 }));
  await expect(findBufferYoutubeChannels("synthetic-api-key", fetcher)).rejects.toThrow(
    "BUFFER_AUTH_REQUIRED",
  );
  fetcher.mockResolvedValueOnce(Response.json({ errors: [{ message: "synthetic-api-key" }] }));
  await expect(findBufferYoutubeChannels("synthetic-api-key", fetcher)).rejects.toThrow(
    "BUFFER_DISCOVERY_UNAVAILABLE",
  );
  fetcher.mockResolvedValueOnce(new Response("x".repeat(524289)));
  await expect(findBufferYoutubeChannels("synthetic-api-key", fetcher)).rejects.toThrow(
    "UPLOAD_TOO_LARGE",
  );
});

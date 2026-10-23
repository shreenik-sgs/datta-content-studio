import { expect, it, vi } from "vitest";
import { studioYoutubeHistory, youtubePostUrl } from "./studio-channel-history";
import type { StudioProviderCredential } from "./studio-provider-config";
const account = {
  id: "a",
  providerAccountId: "buffer-id",
  platform: "youtube",
  transport: "buffer",
  accessToken: "never-echo-this",
} as StudioProviderCredential;
const channel = () =>
  Response.json({
    data: {
      channel: {
        id: "buffer-id",
        service: "youtube",
        serviceId: `UC${"x".repeat(22)}`,
        organizationId: "org",
        isDisconnected: false,
        isLocked: false,
      },
    },
  });
const post = {
  id: "post",
  channelId: "buffer-id",
  channelService: "youtube",
  status: "sent",
  text: "A meaningful teaching",
  sentAt: "2026-10-22T00:00:00Z",
  externalLink: "https://youtu.be/abcdefghijk",
  metadata: { title: "Native upload" },
};
const page = (next = false, cursor: string | null = null, nodes = [post]) =>
  Response.json({
    data: {
      posts: {
        edges: nodes.map((node) => ({ node })),
        pageInfo: { hasNextPage: next, endCursor: cursor },
      },
    },
  });
it("reads all pages including network uploads without any mutation or search cutoff", async () => {
  const f = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(channel())
    .mockResolvedValueOnce(page(true, "two"))
    .mockResolvedValueOnce(page(false, null, [{ ...post, id: "second" }]));
  const r = await studioYoutubeHistory(account, f);
  expect(r.posts).toHaveLength(2);
  expect(r.posts[0]?.title).toBe("Native upload");
  for (const [url, init] of f.mock.calls) {
    expect(url).toBe("https://api.buffer.com");
    expect(JSON.parse(String(init?.body)).query).toMatch(/^query /);
    expect(init?.redirect).toBe("error");
  }
  expect(JSON.parse(String(f.mock.calls[2]?.[1]?.body)).variables.after).toBe("two");
});
it.each(["repeated cursor", "mixed channel", "partial errors", "rate limited"])(
  "fails closed for %s",
  async (kind) => {
    const f = vi.fn<typeof fetch>().mockResolvedValueOnce(channel());
    if (kind === "repeated cursor") f.mockResolvedValue(page(true, "same"));
    if (kind === "mixed channel")
      f.mockResolvedValue(page(false, null, [{ ...post, channelId: "other" }]));
    if (kind === "partial errors")
      f.mockResolvedValue(
        Response.json({ data: { posts: {} }, errors: [{ message: account.accessToken }] }),
      );
    if (kind === "rate limited") f.mockResolvedValue(new Response("try later", { status: 429 }));
    await expect(studioYoutubeHistory(account, f)).rejects.toThrow(/^STUDIO_POSTING_CHECK_/);
  },
);
it("rejects disconnected accounts before reading any posts", async () => {
  const f = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ data: { channel: { id: "other" } } }));
  await expect(studioYoutubeHistory(account, f)).rejects.toThrow(
    "STUDIO_POSTING_CHECK_UNAVAILABLE",
  );
  expect(f).toHaveBeenCalledTimes(1);
});
it("canonicalizes only genuine YouTube video links", () => {
  expect(youtubePostUrl("https://www.youtube.com/shorts/abcdefghijk")).toBe(
    "https://www.youtube.com/watch?v=abcdefghijk",
  );
  for (const url of [
    "https://youtube.com.evil.test/watch?v=abcdefghijk",
    "javascript:alert(1)",
    "https://u:p@youtube.com/watch?v=abcdefghijk",
    "https://youtube.com/@someone",
  ])
    expect(youtubePostUrl(url)).toBeNull();
});

import { describe, expect, it, vi } from "vitest";
import {
  type StudioAdapterOptions,
  type StudioPlatform,
  type StudioProviderAccount,
  type StudioProviderAuthorization,
  type StudioPublicationInput,
  createSocialPlatformAdapter,
} from "./social-platform-adapters";
const now = new Date("2026-10-05T12:00:00Z");
const input: StudioPublicationInput = {
  publicationId: "publication-1",
  approvalId: "approval-1",
  payloadSha256: "a".repeat(64),
  kind: "text",
  title: "Ashrama reflection",
  text: "Sri Ganapathy Sachchidananda Ashrama — reflect with care.",
};
function account(platform: StudioPlatform = "threads"): StudioProviderAccount {
  return {
    id: "account-1",
    platform,
    transport: platform === "reddit" ? "reddit" : platform === "telegram" ? "telegram" : "buffer",
    providerAccountId:
      platform === "reddit"
        ? "AshramaTest"
        : platform === "telegram"
          ? "@ashrama_test"
          : "buffer-channel",
    world: "PRODUCTION",
    enabled: true,
    eligibilityVerified: true,
    defaults: {
      youtube: { privacy: "public", madeForKids: false, isAiGenerated: false, categoryId: "27" },
      tiktok: { automaticPostingVerified: true, isAiGenerated: false },
      pinterest: { boardServiceId: "board-1" },
      reddit: { userAgent: "server:sgs-hub:v1 (by /u/ashrama_owner)" },
    },
  };
}
function fixture(platform: StudioPlatform = "threads") {
  const fetcher = vi.fn<typeof fetch>();
  const policy: StudioProviderAuthorization = {
    allowed: true,
    accountId: "account-1",
    world: "PRODUCTION",
    approvalId: input.approvalId,
    payloadSha256: input.payloadSha256,
    checkedAt: now.toISOString(),
  };
  const options: StudioAdapterOptions = {
    account: account(platform),
    accessToken: platform === "telegram" ? "123456:synthetic_token" : "synthetic-only",
    fetcher,
    authorize: vi.fn(async () => policy),
    trustedMediaOrigins: ["https://media.ashrama.test"],
    now: () => now,
  };
  return { options, fetcher, policy, adapter: createSocialPlatformAdapter(options) };
}
function channel(platform: StudioPlatform = "threads", changes: Record<string, unknown> = {}) {
  return Response.json({
    data: {
      channel: {
        id: "buffer-channel",
        service: platform === "x" ? "twitter" : platform,
        isDisconnected: false,
        isLocked: false,
        isQueuePaused: false,
        ...changes,
      },
    },
  });
}
function post(changes: Record<string, unknown> = {}) {
  return {
    id: "buffer-post",
    channelId: "buffer-channel",
    channelService: "threads",
    status: "sending",
    schedulingType: "automatic",
    sentAt: null,
    externalLink: null,
    text: input.text,
    ...changes,
  };
}
const creation = (changes: Record<string, unknown> = {}) =>
  Response.json({ data: { createPost: { post: post(changes) } } });
const receipt = (changes: Record<string, unknown> = {}) =>
  Response.json({
    data: {
      post: post({
        status: "sent",
        sentAt: now.toISOString(),
        externalLink: "https://www.threads.com/@ashrama/post/real-id",
        ...changes,
      }),
    },
  });
const media = (kind: "image" | "video"): StudioPublicationInput => ({
  ...input,
  kind,
  media: {
    url: `https://media.ashrama.test/approved.${kind === "image" ? "png" : "mp4"}?signature=short-lived`,
    sha256: "b".repeat(64),
    mimeType: kind === "image" ? "image/png" : "video/mp4",
  },
});

describe("Studio publishing adapters — injected HTTP only", () => {
  it("waits for a bound automatic sent receipt and never repeats creation while polling", async () => {
    const { adapter, fetcher, options } = fixture();
    fetcher
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(creation())
      .mockResolvedValueOnce(receipt());
    const result = await adapter.advance(input, null);
    expect(result.kind).toBe("PROGRESS");
    if (result.kind !== "PROGRESS") throw new Error();
    expect(options.authorize).toHaveBeenCalledTimes(2);
    const createRequest = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(createRequest.variables.input).toMatchObject({
      channelId: "buffer-channel",
      mode: "shareNow",
      schedulingType: "automatic",
      needsApproval: false,
      saveToDraft: false,
      assets: [],
    });
    expect(await adapter.advance(input, result.checkpoint)).toEqual({
      kind: "PUBLISHED",
      remoteId: "buffer-post",
      destination: "https://www.threads.com/@ashrama/post/real-id",
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)).query).toContain(
      "query HubReceipt",
    );
    expect(
      fetcher.mock.calls.every(
        ([url, init]) => url === "https://api.buffer.com" && init?.redirect === "error",
      ),
    ).toBe(true);
  });
  it.each([
    "youtube",
    "instagram",
    "facebook",
    "x",
    "tiktok",
    "threads",
    "linkedin",
    "pinterest",
    "bluesky",
  ] as const)("maps approved video to %s with current service metadata", async (platform) => {
    const { adapter, fetcher } = fixture(platform);
    fetcher
      .mockResolvedValueOnce(channel(platform))
      .mockResolvedValueOnce(creation({ channelService: platform === "x" ? "twitter" : platform }));
    expect((await adapter.advance(media("video"), null)).kind).toBe("PROGRESS");
    const payload = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).variables.input;
    expect(payload.assets).toEqual([{ video: { url: media("video").media?.url } }]);
    if (platform === "youtube")
      expect(payload.metadata.youtube).toEqual({
        privacy: "public",
        madeForKids: false,
        isAiGenerated: false,
        categoryId: "27",
        title: input.title,
        notifySubscribers: false,
      });
    if (platform === "tiktok") expect(payload.metadata.tiktok).toEqual({ isAiGenerated: false });
    if (platform === "pinterest") expect(payload.metadata.pinterest.boardServiceId).toBe("board-1");
    if (platform === "instagram")
      expect(payload.metadata.instagram).toEqual({ type: "reel", shouldShareToFeed: true });
  });
  it("sends image cards and includes approved canonical links", async () => {
    const { adapter, fetcher } = fixture("facebook");
    const payload = { ...media("image"), link: "https://ashrama.test/blog/teaching" };
    fetcher
      .mockResolvedValueOnce(channel("facebook"))
      .mockResolvedValueOnce(
        creation({ channelService: "facebook", text: `${input.text}\n\n${payload.link}` }),
      );
    expect((await adapter.advance(payload, null)).kind).toBe("PROGRESS");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).variables.input.assets).toEqual([
      { image: { url: payload.media?.url } },
    ]);
  });
  it.each(["TEST", "denied", "stale", "approval", "payload", "account"])(
    "blocks %s authorization before HTTP",
    async (reason) => {
      const { adapter, fetcher, policy } = fixture();
      if (reason === "TEST") policy.world = "TEST";
      if (reason === "denied") policy.allowed = false;
      if (reason === "stale") policy.checkedAt = "2026-10-05T11:59:00Z";
      if (reason === "approval") policy.approvalId = "different";
      if (reason === "payload") policy.payloadSha256 = "c".repeat(64);
      if (reason === "account") policy.accountId = "different";
      expect((await adapter.advance(input, null)).kind).toBe("BLOCKED");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("rechecks Admin authorization after provider preflight", async () => {
    const { adapter, fetcher, policy } = fixture();
    fetcher.mockImplementationOnce(async () => {
      policy.allowed = false;
      return channel();
    });
    expect(await adapter.advance(input, null)).toMatchObject({
      kind: "BLOCKED",
      code: "APPROVAL_OR_ACCOUNT_CHANGED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { isDisconnected: true },
    { isLocked: true },
    { isQueuePaused: true },
    { service: "facebook" },
    { id: "other-channel" },
  ])("refuses unavailable or mismatched Buffer channels", async (change) => {
    const { adapter, fetcher } = fixture();
    fetcher.mockResolvedValue(channel("threads", change));
    expect(await adapter.advance(input, null)).toMatchObject({
      kind: "BLOCKED",
      code: "BUFFER_CHANNEL_NOT_READY",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps unknown mutation outcomes unknown and prevents a blind in-process resend", async () => {
    const { adapter, fetcher } = fixture();
    fetcher
      .mockResolvedValueOnce(channel())
      .mockRejectedValueOnce(new Error("lost response contains a secret"));
    expect(await adapter.advance(input, null)).toEqual({
      kind: "UNKNOWN",
      code: "PUBLISH_OUTCOME_UNKNOWN",
    });
    expect(await adapter.advance(input, null)).toEqual({
      kind: "UNKNOWN",
      code: "PUBLICATION_ALREADY_ATTEMPTED",
    });
    expect(await adapter.reconcile(input, null)).toEqual({
      kind: "UNKNOWN",
      code: "NO_RECEIPT_REQUIRES_RECONCILIATION",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    { status: "scheduled" },
    { status: "draft" },
    { status: "needs_approval" },
    { status: "error" },
    { status: "sent", schedulingType: "notification" },
    { status: "sent", externalLink: "https://evil.test/post" },
    { status: "sent", sentAt: null },
    { channelId: "other" },
    { text: "edited after approval" },
  ])(
    "never invents success from incomplete/changed/nonautomatic provider results",
    async (change) => {
      const { adapter, fetcher } = fixture();
      fetcher.mockResolvedValueOnce(channel()).mockResolvedValueOnce(creation(change));
      expect((await adapter.advance(input, null)).kind).not.toBe("PUBLISHED");
    },
  );
  it("carries the channel's own reason for a rejection, reduced to one plain line", async () => {
    const { adapter, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(channel()).mockResolvedValueOnce(
      creation({
        status: "error",
        error: {
          message: "  The user has exceeded the number of videos\nthey may upload.  ",
          rawError: '{"domain":"youtube.video","reason":"uploadLimitExceeded"}',
        },
      }),
    );
    expect(await adapter.advance(input, null)).toMatchObject({
      kind: "REJECTED",
      code: "BUFFER_PUBLISH_FAILED",
      detail: "The user has exceeded the number of videos they may upload.",
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).query).toContain(
      "error { message }",
    );
  });
  it("carries Buffer's refusal message when it will not create the post", async () => {
    const { adapter, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(channel()).mockResolvedValueOnce(
      Response.json({
        data: { createPost: { message: "Channel is locked. Upgrade your plan." } },
      }),
    );
    expect(await adapter.advance(input, null)).toEqual({
      kind: "REJECTED",
      code: "BUFFER_CREATE_REJECTED",
      detail: "Channel is locked. Upgrade your plan.",
    });
  });
  it("binds persisted checkpoints to the publication, account, text and media checksum", async () => {
    const { adapter, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(channel()).mockResolvedValueOnce(creation());
    const result = await adapter.advance(media("video"), null);
    if (result.kind !== "PROGRESS") throw new Error();
    for (const changed of [
      { ...result.checkpoint, accountId: "other" },
      { ...result.checkpoint, providerAccountId: "other" },
      { ...result.checkpoint, publicationId: "other" },
    ])
      expect((await adapter.reconcile(media("video"), changed)).kind).toBe("BLOCKED");
    expect(
      (await adapter.reconcile({ ...media("video"), text: "changed" }, result.checkpoint)).kind,
    ).toBe("BLOCKED");
    expect(
      (
        await adapter.reconcile(
          {
            ...media("video"),
            media: {
              url: "https://media.ashrama.test/v.mp4",
              mimeType: "video/mp4",
              sha256: "c".repeat(64),
            },
          },
          result.checkpoint,
        )
      ).kind,
    ).toBe("BLOCKED");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not transfer unapproved, insecure or wrong-format media URLs to a provider", async () => {
    const { adapter, fetcher } = fixture();
    for (const url of [
      "https://evil.test/video.mp4",
      "http://media.ashrama.test/v.mp4",
      "https://user:secret@media.ashrama.test/v.mp4",
      "https://media.ashrama.test/v.mp4#fragment",
    ])
      expect(
        (
          await adapter.advance(
            { ...media("video"), media: { url, mimeType: "video/mp4", sha256: "b".repeat(64) } },
            null,
          )
        ).kind,
      ).toBe("BLOCKED");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds hostile response bodies and exposes only stable error codes", async () => {
    const { adapter, fetcher } = fixture();
    fetcher
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(new Response("x".repeat(129 * 1024)));
    expect(await adapter.advance(input, null)).toEqual({
      kind: "UNKNOWN",
      code: "PUBLISH_OUTCOME_UNKNOWN",
    });
  });
  it("requires TikTok automatic eligibility and YouTube settings without any provider call", async () => {
    for (const platform of ["tiktok", "youtube"] as const) {
      const { options, fetcher } = fixture(platform);
      options.account.defaults = {};
      expect((await createSocialPlatformAdapter(options).advance(media("video"), null)).kind).toBe(
        "BLOCKED",
      );
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it("submits Reddit self posts then reads the exact subreddit receipt", async () => {
    const { adapter, fetcher } = fixture("reddit");
    fetcher
      .mockResolvedValueOnce(Response.json({ json: { errors: [], data: { name: "t3_abc123" } } }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            children: [
              {
                data: {
                  name: "t3_abc123",
                  subreddit: "AshramaTest",
                  title: input.title,
                  selftext: input.text,
                  permalink: "/r/AshramaTest/comments/abc123/reflection/",
                  removed_by_category: null,
                },
              },
            ],
          },
        }),
      );
    const result = await adapter.advance(input, null);
    expect(result.kind).toBe("PROGRESS");
    if (result.kind !== "PROGRESS") throw new Error();
    expect(new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body)).get("kind")).toBe("self");
    expect(await adapter.reconcile(input, result.checkpoint)).toEqual({
      kind: "PUBLISHED",
      remoteId: "t3_abc123",
      destination: "https://www.reddit.com/r/AshramaTest/comments/abc123/reflection/",
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://oauth.reddit.com/api/info?id=t3_abc123");
  });
  it("recognizes Reddit API errors even when HTTP is successful", async () => {
    const { adapter, fetcher } = fixture("reddit");
    fetcher.mockResolvedValue(
      Response.json({ json: { errors: [["SUBREDDIT_NOTALLOWED", "secret provider text"]] } }),
    );
    expect(await adapter.advance(input, null)).toEqual({
      kind: "REJECTED",
      code: "REDDIT_CREATE_REJECTED",
    });
  });
  it.each(["text", "image", "video"] as const)(
    "verifies Telegram public-channel %s receipts",
    async (kind) => {
      const { adapter, fetcher } = fixture("telegram");
      const payload = kind === "text" ? input : media(kind);
      fetcher.mockResolvedValue(
        Response.json({
          ok: true,
          result: {
            message_id: 17,
            chat: { id: -10012345678, type: "channel", username: "ashrama_test" },
            ...(kind === "text"
              ? { text: input.text }
              : kind === "image"
                ? { caption: input.text, photo: [{ file_id: "image" }] }
                : { caption: input.text, video: { file_id: "video" } }),
          },
        }),
      );
      expect(await adapter.advance(payload, null)).toEqual({
        kind: "PUBLISHED",
        remoteId: "-10012345678:17",
        destination: "https://t.me/ashrama_test/17",
      });
      expect(fetcher.mock.calls[0]?.[0]).toContain(
        kind === "text" ? "/sendMessage" : kind === "image" ? "/sendPhoto" : "/sendVideo",
      );
    },
  );
  it("rejects a Telegram private chat or a different destination receipt", async () => {
    const { adapter, fetcher } = fixture("telegram");
    fetcher.mockResolvedValue(
      Response.json({
        ok: true,
        result: {
          message_id: 17,
          chat: { id: 123, type: "private", username: "ashrama_test" },
          text: input.text,
        },
      }),
    );
    expect(await adapter.advance(input, null)).toEqual({
      kind: "UNKNOWN",
      code: "TELEGRAM_RECEIPT_MISMATCH",
    });
  });
});

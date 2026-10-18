import { createHash } from "node:crypto";
import type {
  ChannelAdoption,
  ChannelDispatchPolicy,
  YouTubeCheckpoint,
} from "@satsang/distribution-domain";
import { describe, expect, it, vi } from "vitest";
import { createTelegramChannelAdapter, createYouTubeChannelAdapter } from "./channel-adapters";
const now = new Date("2026-10-03T12:00:00Z");
const controller = () => new AbortController().signal;
const sessionUrl =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=synthetic";
const bytes = new Uint8Array([1, 2, 3, 4]);
const checkpoint: YouTubeCheckpoint = {
  channel: "youtube",
  sessionUrl,
  artifactSha256: createHash("sha256").update(bytes).digest("hex"),
  totalBytes: 4,
  nextByte: 0,
};
const metadata = {
  title: "Synthetic fixture",
  description: "Contract fixture only",
  categoryId: "22",
  language: "te",
  visibility: "private" as const,
  madeForKids: false,
  containsSyntheticMedia: true,
};
function fixture(channel: "youtube" | "telegram", fetcher: typeof fetch) {
  const destination = channel === "youtube" ? "UC-synthetic" : "-100123";
  const adoption: ChannelAdoption = {
    channel,
    accountId: "test-channel",
    world: "TEST",
    enabled: true,
    officialCapabilityEvidence: "Official API contract fixture",
    accountEligibilityEvidence: "Synthetic destination",
    contractTestEvidence: "Fake HTTP only",
    authorizationExpiresAt: "2026-10-04T12:00:00Z",
    verifiedDestination: destination,
    allowedVisibility: ["private", "public"],
  };
  const policy: ChannelDispatchPolicy = {
    channel,
    accountId: "test-channel",
    world: "TEST",
    destination,
    visibility: channel === "youtube" ? "private" : "public",
    checkedAt: now.toISOString(),
    activationAllowed: true,
    emergencyStop: false,
    circuitOpen: false,
    quotaAvailable: true,
    audience: { kind: "PUBLIC_CHANNEL", authorized: true, authorizationId: "synthetic" },
  };
  return { adoption, fetcher, dispatchPolicy: vi.fn(async () => policy), now: () => now };
}
const videoReceipt = () =>
  Response.json(
    {
      id: "fixture0001",
      snippet: { channelId: "UC-synthetic" },
      status: { privacyStatus: "private" },
    },
    { status: 201 },
  );
const post = { destination: "-100123", text: "Synthetic example\nhttps://example.test/s/opaque" };
const messageReceipt = () =>
  Response.json({
    ok: true,
    result: { message_id: 17, chat: { id: -100123, type: "channel" }, text: post.text },
  });

describe("YouTube official resumable upload contract; fake network only", () => {
  it("creates a session with explicit metadata and muted subscriber notifications, requiring persistence before bytes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200, headers: { location: sessionUrl } }));
    const options = fixture("youtube", fetcher);
    const adapter = createYouTubeChannelAdapter({ ...options, accessToken: "synthetic-only" });
    expect(
      await adapter.createSession(
        { metadata, totalBytes: 4, artifactSha256: checkpoint.artifactSha256 },
        controller(),
      ),
    ).toEqual({ kind: "SESSION_READY", checkpoint });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = required(fetcher.mock.calls[0]);
    expect(url).toContain("notifySubscribers=false");
    expect(request?.method).toBe("POST");
    expect(request?.redirect).toBe("error");
    expect(JSON.parse(request?.body as string)).toMatchObject({
      snippet: { defaultLanguage: "te" },
      status: { privacyStatus: "private", containsSyntheticMedia: true },
    });
    expect(options.dispatchPolicy).toHaveBeenCalledOnce();
  });
  it("hash-verifies bytes, resumes at the authoritative offset and verifies remote destination/privacy", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(videoReceipt());
    const adapter = createYouTubeChannelAdapter({
      ...fixture("youtube", fetcher),
      accessToken: "synthetic-only",
    });
    const result = await adapter.uploadRemaining(
      { ...checkpoint, nextByte: 2 },
      bytes,
      controller(),
    );
    expect(result).toMatchObject({
      kind: "COMPLETE",
      receipt: { channel: "youtube", remoteId: "fixture0001", visibility: "private" },
    });
    const [, request] = required(fetcher.mock.calls[0]);
    expect(request?.headers).toMatchObject({
      "content-range": "bytes 2-3/4",
      "content-length": "2",
    });
    expect(Array.from(request?.body as Uint8Array)).toEqual([3, 4]);
    await expect(
      adapter.uploadRemaining(checkpoint, new Uint8Array([9, 9, 9, 9]), controller()),
    ).rejects.toThrow("ARTIFACT_CHANGED");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("after an interrupted upload queries that same session and never starts a fresh video", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("synthetic timeout"))
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { range: "bytes=0-1", "retry-after": "3" } }),
      )
      .mockResolvedValueOnce(videoReceipt());
    const adapter = createYouTubeChannelAdapter({
      ...fixture("youtube", fetcher),
      accessToken: "synthetic-only",
    });
    expect(await adapter.uploadRemaining(checkpoint, bytes, controller())).toEqual({
      kind: "UNKNOWN",
      code: "TRANSPORT",
    });
    const result = await adapter.reconcile(checkpoint, controller());
    expect(result).toEqual({
      kind: "RESUME",
      checkpoint: { ...checkpoint, nextByte: 2 },
      retryAfterSeconds: 3,
    });
    expect(required(fetcher.mock.calls[1])[1]?.headers).toMatchObject({
      "content-range": "bytes */4",
      "content-length": "0",
    });
    if (result.kind !== "RESUME") throw new Error("Expected checkpoint");
    expect((await adapter.uploadRemaining(result.checkpoint, bytes, controller())).kind).toBe(
      "COMPLETE",
    );
    expect(fetcher.mock.calls.every(([url]) => url === sessionUrl)).toBe(true);
  });
  it("can recover a completed upload after a lost response without uploading again", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(videoReceipt());
    const adapter = createYouTubeChannelAdapter({
      ...fixture("youtube", fetcher),
      accessToken: "synthetic-only",
    });
    expect((await adapter.reconcile(checkpoint, controller())).kind).toBe("COMPLETE");
    expect(required(fetcher.mock.calls[0])[1]?.body).toBe("");
  });
  it("refuses unsafe session origins before transmitting credentials and never follows redirects", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = createYouTubeChannelAdapter({
      ...fixture("youtube", fetcher),
      accessToken: "synthetic-only",
    });
    for (const session of [
      "https://attacker.test/upload?upload_id=x",
      "http://www.googleapis.com/upload/youtube/v3/videos?upload_id=x",
      `${sessionUrl}#fragment`,
    ])
      await expect(
        adapter.reconcile({ ...checkpoint, sessionUrl: session }, controller()),
      ).rejects.toThrow("INVALID_UPLOAD_SESSION");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps expired/unknown sessions, malformed ranges and throttled reconciliation out of automatic new uploads", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { range: "bytes=0-999" } }))
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "30" } }));
    const adapter = createYouTubeChannelAdapter({
      ...fixture("youtube", fetcher),
      accessToken: "synthetic-only",
    });
    expect(await adapter.reconcile(null, controller())).toEqual({
      kind: "MANUAL_RECONCILIATION",
      code: "NO_LOOKUP",
    });
    expect(await adapter.reconcile(checkpoint, controller())).toEqual({
      kind: "MANUAL_RECONCILIATION",
      code: "SESSION_EXPIRED",
    });
    expect((await adapter.reconcile(checkpoint, controller())).kind).toBe("UNKNOWN");
    expect((await adapter.reconcile(checkpoint, controller())).kind).toBe("UNKNOWN");
  });
  it("makes expired OAuth visible and rejects provider-reported privacy/account drift", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            id: "fixture0001",
            snippet: { channelId: "different" },
            status: { privacyStatus: "private" },
          },
          { status: 201 },
        ),
      );
    const adapter = createYouTubeChannelAdapter({
      ...fixture("youtube", fetcher),
      accessToken: "synthetic-only",
    });
    expect(await adapter.uploadRemaining(checkpoint, bytes, controller())).toMatchObject({
      kind: "REJECTED",
      code: "AUTHORIZATION",
    });
    expect(await adapter.uploadRemaining(checkpoint, bytes, controller())).toEqual({
      kind: "MANUAL_RECONCILIATION",
      code: "REMOTE_MISMATCH",
    });
  });
});

describe("Telegram approved channel text contract; fake network only", () => {
  it("sends approved text once, disables paid broadcast/notifications and verifies the returned channel", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(messageReceipt());
    const adapter = createTelegramChannelAdapter({
      ...fixture("telegram", fetcher),
      botToken: "123:synthetic_only",
    });
    expect(await adapter.publish(post, controller())).toMatchObject({
      kind: "COMPLETE",
      receipt: { remoteId: "17", remoteDestination: "-100123" },
    });
    const [url, request] = required(fetcher.mock.calls[0]);
    expect(url).toBe("https://api.telegram.org/bot123:synthetic_only/sendMessage");
    expect(JSON.parse(request?.body as string)).toEqual({
      chat_id: "-100123",
      text: post.text,
      disable_notification: true,
      allow_paid_broadcast: false,
      link_preview_options: { is_disabled: true },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not retry or consume the update stream after a timeout or server error", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("timeout with token must not escape"))
      .mockResolvedValueOnce(Response.json({ ok: false, error_code: 500 }, { status: 500 }));
    const adapter = createTelegramChannelAdapter({
      ...fixture("telegram", fetcher),
      botToken: "123:synthetic_only",
    });
    expect(await adapter.publish(post, controller())).toEqual({
      kind: "UNKNOWN",
      code: "TRANSPORT",
    });
    expect(adapter.reconcile()).toEqual({ kind: "MANUAL_RECONCILIATION", code: "NO_LOOKUP" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await adapter.publish(post, controller())).toEqual({
      kind: "UNKNOWN",
      code: "SERVER_FAILURE",
    });
  });
  it("retries only an explicit Bot API rate-limit rejection with its requested delay", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: 67 } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(new Response("Proxy rate limit", { status: 429 }));
    const adapter = createTelegramChannelAdapter({
      ...fixture("telegram", fetcher),
      botToken: "123:synthetic_only",
    });
    expect(await adapter.publish(post, controller())).toEqual({
      kind: "REJECTED",
      code: "RATE_LIMIT",
      retryAfterSeconds: 67,
    });
    expect((await adapter.publish(post, controller())).kind).toBe("UNKNOWN");
  });
  it("blocks revoked permission, cross-account destinations, direct delivery and stops before sending", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const options = fixture("telegram", fetcher);
    const adapter = createTelegramChannelAdapter({ ...options, botToken: "123:synthetic_only" });
    await expect(
      adapter.publish({ ...post, destination: "100123" }, controller()),
    ).rejects.toThrow();
    await expect(
      adapter.publish({ ...post, destination: "-100999" }, controller()),
    ).rejects.toThrow("DESTINATION_REFUSED");
    const original = await options.dispatchPolicy();
    for (const changes of [
      { emergencyStop: true },
      { activationAllowed: false },
      { circuitOpen: true },
      {
        audience: {
          kind: "DIRECT" as const,
          consentGranted: false,
          consentRevision: 2,
          purpose: "DISTRIBUTION",
        },
      },
    ]) {
      options.dispatchPolicy.mockResolvedValue({ ...original, ...changes });
      await expect(adapter.publish(post, controller())).rejects.toThrow("CHANNEL_");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("contains malformed, oversized and cross-chat responses without claiming publication", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          result: { message_id: 2, chat: { id: -100999, type: "channel" }, text: post.text },
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, result: {} }))
      .mockResolvedValueOnce(new Response("a".repeat(65 * 1024)));
    const adapter = createTelegramChannelAdapter({
      ...fixture("telegram", fetcher),
      botToken: "123:synthetic_only",
    });
    expect((await adapter.publish(post, controller())).kind).toBe("MANUAL_RECONCILIATION");
    expect((await adapter.publish(post, controller())).kind).toBe("UNKNOWN");
    expect((await adapter.publish(post, controller())).kind).toBe("UNKNOWN");
  });
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}

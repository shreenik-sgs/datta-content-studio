import { createHash } from "node:crypto";
import {
  type TelegramChannelPost,
  type YoutubePublicationMetadata,
  channelAdoptionSchema,
  telegramChannelPostSchema,
  youtubePublicationMetadataSchema,
} from "@satsang/distribution-contracts";
import {
  type ChannelAdoption,
  type ChannelDispatchPolicy,
  type ChannelProviderOutcome,
  type YouTubeCheckpoint,
  channelDispatchDecision,
} from "@satsang/distribution-domain";

export type ChannelTransportOptions = {
  adoption: ChannelAdoption;
  /** Mandatory injection: constructing an adapter cannot accidentally use global fetch. */
  fetcher: typeof fetch;
  /** Re-read authorization, approvals, rights, stop, quota and audience immediately before each mutation. */
  dispatchPolicy: () => Promise<ChannelDispatchPolicy>;
  now?: () => Date;
};
type Transport = ReturnType<typeof channelTransport>;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const unknown = (
  code: "TRANSPORT" | "INVALID_RESPONSE" | "SERVER_FAILURE",
): ChannelProviderOutcome => ({ kind: "UNKNOWN", code });
const invalid = (): ChannelProviderOutcome => ({
  kind: "REJECTED",
  code: "INVALID_REQUEST",
  retryAfterSeconds: null,
});

function channelTransport(options: ChannelTransportOptions, channel: "youtube" | "telegram") {
  const adoption = channelAdoptionSchema.parse(options.adoption);
  if (adoption.channel !== channel || !adoption.enabled)
    throw new Error("CHANNEL_PROVIDER_NOT_ADOPTED");
  const now = options.now ?? (() => new Date());
  return {
    adoption,
    now,
    async authorize() {
      const policy = await options.dispatchPolicy();
      const decision = channelDispatchDecision(adoption, policy, now().toISOString());
      if (!decision.allowed) throw new Error(`CHANNEL_${decision.reason}`);
      return policy;
    },
    async request(url: string, init: RequestInit, signal: AbortSignal) {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
      const response = await options.fetcher(url, { ...init, signal: deadline, redirect: "error" });
      // Continue the timeout through body consumption; never emit provider bodies or credential-bearing URLs.
      const reader = response.body?.getReader();
      if (!reader) return { response, body: null as unknown };
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          deadline.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error("CHANNEL_RESPONSE_LIMIT");
          chunks.push(part.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      let body: unknown = null;
      if (size) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* malformed means unknown */
        }
      }
      return { response, body };
    },
  };
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function retryAfter(response: Response, now: Date): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const until = Date.parse(raw);
  return Number.isFinite(until) ? Math.max(1, Math.ceil((until - now.getTime()) / 1000)) : null;
}
function youtubeFailure(response: Response, now: Date): ChannelProviderOutcome {
  if (response.status === 401 || response.status === 403)
    return { kind: "REJECTED", code: "AUTHORIZATION", retryAfterSeconds: null };
  if (response.status === 429)
    return { kind: "REJECTED", code: "RATE_LIMIT", retryAfterSeconds: retryAfter(response, now) };
  if (response.status >= 500) return unknown("SERVER_FAILURE");
  if (response.status >= 400)
    return { kind: "REJECTED", code: "PROVIDER_REFUSED", retryAfterSeconds: null };
  return unknown("INVALID_RESPONSE");
}
function checkpointAllowed(value: YouTubeCheckpoint): void {
  const url = new URL(value.sessionUrl);
  if (
    url.origin !== "https://www.googleapis.com" ||
    url.pathname !== "/upload/youtube/v3/videos" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.searchParams.get("upload_id") ||
    url.searchParams.get("uploadType") !== "resumable" ||
    !/^[a-f0-9]{64}$/.test(value.artifactSha256) ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 1 ||
    value.totalBytes > MAX_ARTIFACT_BYTES ||
    !Number.isSafeInteger(value.nextByte) ||
    value.nextByte < 0 ||
    value.nextByte >= value.totalBytes
  )
    throw new Error("CHANNEL_INVALID_UPLOAD_SESSION");
}
function uploadResult(
  transport: Transport,
  checkpoint: YouTubeCheckpoint,
  expectedVisibility: ChannelDispatchPolicy["visibility"],
  response: Response,
  body: unknown,
): ChannelProviderOutcome {
  if (response.status === 308) {
    const range = response.headers.get("range");
    const match = range?.match(/^bytes=0-(\d+)$/);
    if (range && !match) return unknown("INVALID_RESPONSE");
    const nextByte = match ? Number(match[1]) + 1 : 0;
    if (
      !Number.isSafeInteger(nextByte) ||
      nextByte < checkpoint.nextByte ||
      nextByte >= checkpoint.totalBytes
    )
      return unknown("INVALID_RESPONSE");
    return {
      kind: "RESUME",
      checkpoint: { ...checkpoint, nextByte },
      retryAfterSeconds: retryAfter(response, transport.now()) ?? 1,
    };
  }
  if (response.status === 200 || response.status === 201) {
    const resource = object(body);
    const snippet = object(resource?.snippet);
    const status = object(resource?.status);
    if (typeof resource?.id !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(resource.id))
      return unknown("INVALID_RESPONSE");
    if (
      snippet?.channelId !== transport.adoption.verifiedDestination ||
      status?.privacyStatus !== expectedVisibility
    )
      return { kind: "MANUAL_RECONCILIATION", code: "REMOTE_MISMATCH" };
    return {
      kind: "COMPLETE",
      receipt: {
        channel: "youtube",
        remoteId: resource.id,
        remoteDestination: transport.adoption.verifiedDestination,
        visibility: expectedVisibility,
      },
    };
  }
  if (response.status === 404) return { kind: "MANUAL_RECONCILIATION", code: "SESSION_EXPIRED" };
  return youtubeFailure(response, transport.now());
}
/** Uses a previously authorized OAuth credential; credential acquisition and refresh remain outside the transport. */
export function createYouTubeChannelAdapter(
  options: ChannelTransportOptions & { accessToken: string },
) {
  if (!options.accessToken || /[\r\n]/.test(options.accessToken))
    throw new Error("CHANNEL_CREDENTIAL_REQUIRED");
  const transport = channelTransport(options, "youtube");
  const authorization = `Bearer ${options.accessToken}`;
  return {
    async createSession(
      input: { metadata: YoutubePublicationMetadata; artifactSha256: string; totalBytes: number },
      signal: AbortSignal,
    ): Promise<ChannelProviderOutcome> {
      const metadata = youtubePublicationMetadataSchema.parse(input.metadata);
      if (
        !/^[a-f0-9]{64}$/.test(input.artifactSha256) ||
        !Number.isSafeInteger(input.totalBytes) ||
        input.totalBytes < 1 ||
        input.totalBytes > MAX_ARTIFACT_BYTES
      )
        throw new Error("CHANNEL_INVALID_ARTIFACT");
      const policy = await transport.authorize();
      if (metadata.visibility !== policy.visibility) throw new Error("CHANNEL_VISIBILITY_REFUSED");
      signal.throwIfAborted();
      try {
        const { response } = await transport.request(
          "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false",
          {
            method: "POST",
            headers: {
              authorization,
              "content-type": "application/json; charset=UTF-8",
              "x-upload-content-length": String(input.totalBytes),
              "x-upload-content-type": "video/mp4",
            },
            body: JSON.stringify({
              snippet: {
                title: metadata.title,
                description: metadata.description,
                categoryId: metadata.categoryId,
                defaultLanguage: metadata.language,
              },
              status: {
                privacyStatus: metadata.visibility,
                selfDeclaredMadeForKids: metadata.madeForKids,
                containsSyntheticMedia: metadata.containsSyntheticMedia,
              },
            }),
          },
          signal,
        );
        if (response.status !== 200) return youtubeFailure(response, transport.now());
        const sessionUrl = response.headers.get("location");
        if (!sessionUrl) return unknown("INVALID_RESPONSE");
        const checkpoint: YouTubeCheckpoint = {
          channel: "youtube",
          sessionUrl,
          artifactSha256: input.artifactSha256,
          totalBytes: input.totalBytes,
          nextByte: 0,
        };
        checkpointAllowed(checkpoint);
        return { kind: "SESSION_READY", checkpoint };
      } catch {
        return unknown("TRANSPORT");
      }
    },
    /** Caller MUST persist SESSION_READY before calling; retries resume this exact URI, never initialize again. */
    async uploadRemaining(
      checkpoint: YouTubeCheckpoint,
      artifact: Uint8Array,
      signal: AbortSignal,
    ): Promise<ChannelProviderOutcome> {
      checkpointAllowed(checkpoint);
      if (
        artifact.byteLength !== checkpoint.totalBytes ||
        createHash("sha256").update(artifact).digest("hex") !== checkpoint.artifactSha256
      )
        throw new Error("CHANNEL_ARTIFACT_CHANGED");
      const policy = await transport.authorize();
      signal.throwIfAborted();
      try {
        const { response, body } = await transport.request(
          checkpoint.sessionUrl,
          {
            method: "PUT",
            headers: {
              authorization,
              "content-type": "video/mp4",
              "content-length": String(checkpoint.totalBytes - checkpoint.nextByte),
              "content-range": `bytes ${checkpoint.nextByte}-${checkpoint.totalBytes - 1}/${checkpoint.totalBytes}`,
            },
            body: Buffer.from(artifact.subarray(checkpoint.nextByte)),
          },
          signal,
        );
        return uploadResult(transport, checkpoint, policy.visibility, response, body);
      } catch {
        return unknown("TRANSPORT");
      }
    },
    /** An empty status query is required after timeout/5xx/expired worker lease, before any further bytes. */
    async reconcile(
      checkpoint: YouTubeCheckpoint | null,
      signal: AbortSignal,
    ): Promise<ChannelProviderOutcome> {
      if (!checkpoint) return { kind: "MANUAL_RECONCILIATION", code: "NO_LOOKUP" };
      checkpointAllowed(checkpoint);
      const policy = await transport.authorize();
      signal.throwIfAborted();
      try {
        const { response, body } = await transport.request(
          checkpoint.sessionUrl,
          {
            method: "PUT",
            headers: {
              authorization,
              "content-length": "0",
              "content-range": `bytes */${checkpoint.totalBytes}`,
            },
            body: "",
          },
          signal,
        );
        // A throttled lookup says nothing about whether the previous upload completed.
        if (response.status === 429) return unknown("SERVER_FAILURE");
        return uploadResult(transport, checkpoint, policy.visibility, response, body);
      } catch {
        return unknown("TRANSPORT");
      }
    },
  };
}

/** R5 Telegram scope is an explicitly authorized channel post, without direct delivery or paid broadcast. */
export function createTelegramChannelAdapter(
  options: ChannelTransportOptions & { botToken: string },
) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(options.botToken))
    throw new Error("CHANNEL_CREDENTIAL_REQUIRED");
  const transport = channelTransport(options, "telegram");
  return {
    async publish(
      input: TelegramChannelPost,
      signal: AbortSignal,
    ): Promise<ChannelProviderOutcome> {
      const post = telegramChannelPostSchema.parse(input);
      const policy = await transport.authorize();
      if (post.destination !== policy.destination || policy.visibility !== "public")
        throw new Error("CHANNEL_DESTINATION_REFUSED");
      signal.throwIfAborted();
      try {
        const { response, body } = await transport.request(
          `https://api.telegram.org/bot${options.botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: post.destination,
              text: post.text,
              disable_notification: true,
              allow_paid_broadcast: false,
              link_preview_options: { is_disabled: true },
            }),
          },
          signal,
        );
        const envelope = object(body);
        if (response.ok && envelope?.ok === true) {
          const message = object(envelope.result);
          const chat = object(message?.chat);
          if (!Number.isSafeInteger(message?.message_id) || (message?.message_id as number) < 1)
            return unknown("INVALID_RESPONSE");
          if (
            chat?.type !== "channel" ||
            String(chat?.id) !== post.destination ||
            message?.text !== post.text
          )
            return { kind: "MANUAL_RECONCILIATION", code: "REMOTE_MISMATCH" };
          return {
            kind: "COMPLETE",
            receipt: {
              channel: "telegram",
              remoteId: String(message?.message_id),
              remoteDestination: post.destination,
              visibility: "public",
            },
          };
        }
        // Only an explicit Bot API rejection is safe to retry; generic proxy failures remain unknown.
        if (envelope?.ok === false && Number.isSafeInteger(envelope.error_code)) {
          if (envelope.error_code === 429) {
            const seconds = object(envelope.parameters)?.retry_after;
            return {
              kind: "REJECTED",
              code: "RATE_LIMIT",
              retryAfterSeconds:
                Number.isSafeInteger(seconds) && (seconds as number) > 0
                  ? (seconds as number)
                  : null,
            };
          }
          if (envelope.error_code === 401 || envelope.error_code === 403)
            return { kind: "REJECTED", code: "AUTHORIZATION", retryAfterSeconds: null };
          if ((envelope.error_code as number) >= 400 && (envelope.error_code as number) < 500)
            return invalid();
        }
        return unknown(response.status >= 500 ? "SERVER_FAILURE" : "INVALID_RESPONSE");
      } catch {
        return unknown("TRANSPORT");
      }
    },
    /** Bot API has no documented idempotency key or lookup for an unknown sent message ID.
     * Do not consume getUpdates, replay sendMessage or infer failure from an absent update. */
    reconcile(): ChannelProviderOutcome {
      return { kind: "MANUAL_RECONCILIATION", code: "NO_LOOKUP" };
    },
  };
}

import { createHash } from "node:crypto";
import {
  type StudioPlatform,
  type StudioProviderAccount,
  studioProviderAccountBlock,
} from "@satsang/distribution-db";
export type { StudioPlatform, StudioProviderAccount } from "@satsang/distribution-db";

export type StudioPublicationInput = {
  publicationId: string;
  approvalId: string;
  payloadSha256: string;
  kind: "text" | "link" | "image" | "video";
  title: string;
  text: string;
  link?: string;
  media?: { url: string; sha256: string; mimeType: string };
};
export type StudioProviderCheckpoint = {
  version: 1;
  transport: StudioProviderAccount["transport"];
  accountId: string;
  platform: StudioPlatform;
  providerAccountId: string;
  publicationId: string;
  approvalId: string;
  payloadSha256: string;
  requestSha256: string;
  providerPostId: string;
};
export type StudioProviderOutcome =
  | { kind: "PROGRESS"; checkpoint: StudioProviderCheckpoint; retryAfterSeconds: number }
  | { kind: "PUBLISHED"; remoteId: string; destination: string }
  | {
      kind: "BLOCKED" | "REJECTED" | "UNKNOWN";
      code: string;
      checkpoint?: StudioProviderCheckpoint;
    };
export type StudioProviderAuthorization = {
  allowed: boolean;
  accountId: string;
  world: "TEST" | "PRODUCTION";
  approvalId: string;
  payloadSha256: string;
  checkedAt: string;
};
export type StudioAdapterOptions = {
  account: StudioProviderAccount;
  accessToken: string;
  fetcher: typeof fetch;
  authorize: (input: StudioPublicationInput) => Promise<StudioProviderAuthorization>;
  trustedMediaOrigins: string[];
  now?: () => Date;
};
const BUFFER_ENDPOINT = "https://api.buffer.com";
const POST_FIELDS = "id channelId channelService status schedulingType sentAt externalLink text";
const CREATE_POST = `mutation HubPublish($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { ${POST_FIELDS} } } ... on MutationError { message } } }`;
const GET_POST = `query HubReceipt($input: PostInput!) { post(input: $input) { ${POST_FIELDS} } }`;
const GET_CHANNEL =
  "query HubChannel($input: ChannelInput!) { channel(input: $input) { id service isDisconnected isLocked isQueuePaused } }";
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const identifier = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9_.:@-]{1,160}$/.test(x) && !/[\r\n]/.test(x);
const sha = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/.test(x) && !/[\r\n]/.test(x);
const service = (platform: StudioPlatform) => (platform === "x" ? "twitter" : platform);
function httpsUrl(value: unknown): URL | null {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    /\s/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url : null;
  } catch {
    return null;
  }
}
function bodyText(input: StudioPublicationInput): string {
  return input.link && !input.text.includes(input.link)
    ? `${input.text}\n\n${input.link}`
    : input.text;
}
function fingerprint(input: StudioPublicationInput, account: StudioProviderAccount): string {
  // Signed URL expiry may change during receipt polling; immutable media SHA remains bound.
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: input.title,
        text: input.text,
        kind: input.kind,
        link: input.link ?? null,
        media: input.media ? { sha256: input.media.sha256, mimeType: input.media.mimeType } : null,
        defaults: account.defaults ?? null,
      }),
    )
    .digest("hex");
}
function checkpointFor(
  input: StudioPublicationInput,
  account: StudioProviderAccount,
  providerPostId: string,
): StudioProviderCheckpoint {
  return {
    version: 1,
    transport: account.transport,
    accountId: account.id,
    platform: account.platform,
    providerAccountId: account.providerAccountId,
    publicationId: input.publicationId,
    approvalId: input.approvalId,
    payloadSha256: input.payloadSha256,
    requestSha256: fingerprint(input, account),
    providerPostId,
  };
}
function validCheckpoint(
  input: StudioPublicationInput,
  account: StudioProviderAccount,
  cp: StudioProviderCheckpoint,
): boolean {
  const expected = checkpointFor(input, account, cp.providerPostId);
  return (
    identifier(cp.providerPostId) &&
    Object.entries(expected).every(
      ([key, value]) => cp[key as keyof StudioProviderCheckpoint] === value,
    )
  );
}
const receiptHosts: Record<StudioPlatform, string[]> = {
  youtube: ["youtube.com", "www.youtube.com", "youtu.be"],
  instagram: ["instagram.com", "www.instagram.com"],
  facebook: ["facebook.com", "www.facebook.com", "fb.watch"],
  x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
  reddit: ["reddit.com", "www.reddit.com"],
  tiktok: ["tiktok.com", "www.tiktok.com"],
  threads: ["threads.net", "www.threads.net", "threads.com", "www.threads.com"],
  linkedin: ["linkedin.com", "www.linkedin.com"],
  pinterest: ["pinterest.com", "www.pinterest.com", "pin.it"],
  whatsapp: [],
  telegram: ["t.me"],
  bluesky: ["bsky.app"],
};
function destination(platform: StudioPlatform, raw: unknown): string | null {
  const url = httpsUrl(raw);
  return url && receiptHosts[platform].includes(url.hostname) && url.pathname !== "/"
    ? url.href
    : null;
}

/** All HTTP is injected. One advance performs at most one publishing mutation; a checkpoint means poll, never recreate. */
export function createSocialPlatformAdapter(options: StudioAdapterOptions) {
  const account = structuredClone(options.account);
  const accessToken = options.accessToken;
  const origins = new Set(options.trustedMediaOrigins);
  const now = options.now ?? (() => new Date());
  const attempts = new Set<string>();
  const outcome = (
    kind: "BLOCKED" | "REJECTED" | "UNKNOWN",
    code: string,
    cp?: StudioProviderCheckpoint,
  ): StudioProviderOutcome => ({ kind, code, ...(cp ? { checkpoint: cp } : {}) });
  function validate(input: StudioPublicationInput): string | null {
    const block = studioProviderAccountBlock(account);
    if (block) return block;
    if (!accessToken || accessToken.length > 8192 || /[\r\n]/.test(accessToken))
      return "CREDENTIAL_REQUIRED";
    if (
      !identifier(input.publicationId) ||
      !identifier(input.approvalId) ||
      !sha(input.payloadSha256) ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 40_000 ||
      typeof input.title !== "string" ||
      input.title.length > 300 ||
      !["text", "link", "image", "video"].includes(input.kind)
    )
      return "INVALID_PUBLICATION";
    if (input.link !== undefined && !httpsUrl(input.link)) return "INVALID_LINK";
    if (input.kind === "link" && !input.link) return "LINK_REQUIRED";
    if (input.kind === "image" || input.kind === "video") {
      const url = httpsUrl(input.media?.url);
      if (
        !url ||
        !origins.has(url.origin) ||
        !sha(input.media?.sha256) ||
        !input.media ||
        !(input.kind === "image" ? ["image/png", "image/jpeg"] : ["video/mp4"]).includes(
          input.media.mimeType,
        )
      )
        return "APPROVED_MEDIA_URL_REQUIRED";
    } else if (input.media) return "UNEXPECTED_MEDIA";
    if ((account.platform === "youtube" || account.platform === "tiktok") && input.kind !== "video")
      return "VIDEO_REQUIRED";
    if (
      ["instagram", "pinterest"].includes(account.platform) &&
      !["image", "video"].includes(input.kind)
    )
      return "MEDIA_REQUIRED";
    if (account.platform === "reddit" && !["text", "link"].includes(input.kind))
      return "REDDIT_TEXT_OR_LINK_REQUIRED";
    if (account.platform === "reddit" && (!input.title.trim() || input.title.length > 300))
      return "TITLE_REQUIRED";
    if (account.platform === "youtube" && (!input.title.trim() || input.title.length > 100))
      return "YOUTUBE_TITLE_REQUIRED";
    if (account.platform === "telegram" && bodyText(input).length > (input.media ? 1024 : 4096))
      return "TELEGRAM_TEXT_TOO_LONG";
    if (account.transport === "telegram" && !/^[0-9]+:[A-Za-z0-9_-]+$/.test(accessToken))
      return "TELEGRAM_TOKEN_INVALID";
    return null;
  }
  async function authorized(
    input: StudioPublicationInput,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted) return "CANCELLED";
    try {
      const policy = await options.authorize(structuredClone(input));
      if (policy.world !== "PRODUCTION") return "TEST_NETWORK_DISABLED";
      if (
        !policy.allowed ||
        policy.accountId !== account.id ||
        policy.approvalId !== input.approvalId ||
        policy.payloadSha256 !== input.payloadSha256
      )
        return "APPROVAL_OR_ACCOUNT_CHANGED";
      const age = now().getTime() - Date.parse(policy.checkedAt);
      return !Number.isFinite(age) || age < 0 || age > 5000 ? "AUTHORIZATION_STALE" : null;
    } catch {
      return "AUTHORIZATION_UNAVAILABLE";
    }
  }
  async function request(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ status: number; value: unknown }> {
    const deadline = AbortSignal.timeout(30_000);
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
    let response: Response;
    try {
      response = await options.fetcher(url, {
        ...init,
        signal: requestSignal,
        redirect: "error",
      });
    } catch {
      throw new Error("PROVIDER_TRANSPORT_FAILED");
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      return { status: response.status, value: null };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("INVALID_PROVIDER_RESPONSE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          throw new Error("PROVIDER_TRANSPORT_FAILED");
        }
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 128 * 1024) throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
        chunks.push(chunk.value);
      }
      return {
        status: response.status,
        value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const graphql = (query: string, input: unknown, signal?: AbortSignal) =>
    request(
      BUFFER_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query, variables: { input } }),
      },
      signal,
    );
  function bufferReceipt(
    input: StudioPublicationInput,
    value: unknown,
    existing?: StudioProviderCheckpoint,
  ): StudioProviderOutcome {
    if (!record(value) || !identifier(value.id))
      return outcome("UNKNOWN", "BUFFER_RECEIPT_INVALID", existing);
    const cp = checkpointFor(input, account, value.id);
    if (
      (existing && existing.providerPostId !== value.id) ||
      value.channelId !== account.providerAccountId ||
      value.channelService !== service(account.platform) ||
      value.text !== bodyText(input)
    )
      return outcome("UNKNOWN", "BUFFER_RECEIPT_MISMATCH", existing ?? cp);
    if (value.schedulingType !== "automatic")
      return outcome("BLOCKED", "AUTOMATIC_PUBLISHING_REQUIRED", cp);
    if (value.status === "sent") {
      const url = destination(account.platform, value.externalLink);
      if (!url || typeof value.sentAt !== "string" || !Number.isFinite(Date.parse(value.sentAt)))
        return outcome("UNKNOWN", "BUFFER_SENT_RECEIPT_INCOMPLETE", cp);
      return { kind: "PUBLISHED", remoteId: value.id, destination: url };
    }
    if (value.status === "sending" || value.status === "scheduled")
      return { kind: "PROGRESS", checkpoint: cp, retryAfterSeconds: 30 };
    if (value.status === "draft" || value.status === "needs_approval")
      return outcome("BLOCKED", "BUFFER_APPROVAL_REQUIRED", cp);
    if (value.status === "error") return outcome("REJECTED", "BUFFER_PUBLISH_FAILED", cp);
    return outcome("UNKNOWN", "BUFFER_STATUS_UNKNOWN", cp);
  }
  function bufferInput(input: StudioPublicationInput) {
    let metadata: object | undefined;
    if (account.platform === "youtube")
      metadata = {
        youtube: { ...account.defaults?.youtube, title: input.title, notifySubscribers: false },
      };
    if (account.platform === "tiktok")
      metadata = { tiktok: { isAiGenerated: account.defaults?.tiktok?.isAiGenerated } };
    if (account.platform === "instagram")
      metadata = {
        instagram: { type: input.kind === "video" ? "reel" : "post", shouldShareToFeed: true },
      };
    if (account.platform === "facebook")
      metadata = { facebook: { type: input.kind === "video" ? "reel" : "post" } };
    if (account.platform === "pinterest")
      metadata = {
        pinterest: {
          boardServiceId: account.defaults?.pinterest?.boardServiceId,
          title: input.title,
          ...(input.link ? { url: input.link } : {}),
        },
      };
    return {
      channelId: account.providerAccountId,
      text: bodyText(input),
      mode: "shareNow",
      schedulingType: "automatic",
      needsApproval: false,
      saveToDraft: false,
      aiAssisted: true,
      source: "SGS Distribution Hub",
      assets: input.media ? [{ [input.kind]: { url: input.media.url } }] : [],
      ...(metadata ? { metadata } : {}),
    };
  }
  async function poll(
    input: StudioPublicationInput,
    cp: StudioProviderCheckpoint,
    signal?: AbortSignal,
  ): Promise<StudioProviderOutcome> {
    if (!validCheckpoint(input, account, cp)) return outcome("BLOCKED", "CHECKPOINT_MISMATCH");
    const block = await authorized(input, signal);
    if (block) return outcome("BLOCKED", block, cp);
    try {
      if (account.transport === "buffer") {
        const response = await graphql(GET_POST, { id: cp.providerPostId }, signal);
        if (response.status === 429 || response.status >= 500)
          return outcome("UNKNOWN", "BUFFER_RECEIPT_UNAVAILABLE", cp);
        if (
          response.status !== 200 ||
          !record(response.value) ||
          response.value.errors ||
          !record(response.value.data)
        )
          return outcome("UNKNOWN", "BUFFER_RECEIPT_INVALID", cp);
        return bufferReceipt(input, response.value.data.post, cp);
      }
      if (account.transport === "reddit") {
        const response = await request(
          `https://oauth.reddit.com/api/info?id=${encodeURIComponent(cp.providerPostId)}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": account.defaults?.reddit?.userAgent ?? "",
            },
          },
          signal,
        );
        if (response.status === 429 || response.status >= 500)
          return outcome("UNKNOWN", "REDDIT_RECEIPT_UNAVAILABLE", cp);
        if (
          response.status !== 200 ||
          !record(response.value) ||
          !record(response.value.data) ||
          !Array.isArray(response.value.data.children)
        )
          return outcome("UNKNOWN", "REDDIT_RECEIPT_INVALID", cp);
        const child: unknown = response.value.data.children[0];
        const post = record(child) && record(child.data) ? child.data : null;
        const url = post ? destination("reddit", `https://www.reddit.com${post.permalink}`) : null;
        if (
          !post ||
          typeof post.permalink !== "string" ||
          !post.permalink
            .toLowerCase()
            .startsWith(
              `/r/${account.providerAccountId.toLowerCase()}/comments/${cp.providerPostId.slice(3)}/`,
            ) ||
          post.name !== cp.providerPostId ||
          String(post.subreddit).toLowerCase() !== account.providerAccountId.toLowerCase() ||
          post.title !== input.title ||
          (input.kind === "text" ? post.selftext !== bodyText(input) : post.url !== input.link) ||
          !url ||
          post.removed_by_category != null
        )
          return outcome("UNKNOWN", "REDDIT_RECEIPT_MISMATCH", cp);
        return { kind: "PUBLISHED", remoteId: cp.providerPostId, destination: url };
      }
      return outcome("UNKNOWN", "TELEGRAM_RECEIPT_REQUIRES_RECONCILIATION", cp);
    } catch (error) {
      return outcome(
        "UNKNOWN",
        error instanceof Error && error.message === "PROVIDER_TRANSPORT_FAILED"
          ? "RECEIPT_QUERY_FAILED"
          : "RECEIPT_INVALID",
        cp,
      );
    }
  }
  async function advance(
    raw: StudioPublicationInput,
    rawCheckpoint: StudioProviderCheckpoint | null,
    signal?: AbortSignal,
  ): Promise<StudioProviderOutcome> {
    const input = structuredClone(raw);
    const cp = rawCheckpoint ? structuredClone(rawCheckpoint) : null;
    const invalid = validate(input);
    if (invalid) return outcome("BLOCKED", invalid);
    if (cp) return poll(input, cp, signal);
    if (attempts.has(input.publicationId))
      return outcome("UNKNOWN", "PUBLICATION_ALREADY_ATTEMPTED");
    let block = await authorized(input, signal);
    if (block) return outcome("BLOCKED", block);
    if (account.transport === "buffer") {
      try {
        const response = await graphql(GET_CHANNEL, { id: account.providerAccountId }, signal);
        const data =
          record(response.value) && record(response.value.data) ? response.value.data : null;
        const channel = data && record(data.channel) ? data.channel : null;
        if (
          response.status !== 200 ||
          (record(response.value) && response.value.errors) ||
          !channel ||
          channel.id !== account.providerAccountId ||
          channel.service !== service(account.platform) ||
          channel.isDisconnected !== false ||
          channel.isLocked !== false ||
          channel.isQueuePaused !== false
        )
          return outcome("BLOCKED", "BUFFER_CHANNEL_NOT_READY");
      } catch {
        return outcome("BLOCKED", "BUFFER_CHANNEL_CHECK_FAILED");
      }
      block = await authorized(input, signal);
      if (block) return outcome("BLOCKED", block);
    }
    attempts.add(input.publicationId);
    try {
      if (account.transport === "buffer") {
        const response = await graphql(CREATE_POST, bufferInput(input), signal);
        if (
          response.status !== 200 ||
          !record(response.value) ||
          response.value.errors ||
          !record(response.value.data) ||
          !record(response.value.data.createPost)
        )
          return outcome("UNKNOWN", "BUFFER_CREATE_OUTCOME_UNKNOWN");
        const result = response.value.data.createPost;
        if (!result.post && typeof result.message === "string")
          return outcome("REJECTED", "BUFFER_CREATE_REJECTED");
        return bufferReceipt(input, result.post);
      }
      if (account.transport === "reddit") {
        const form = new URLSearchParams({
          api_type: "json",
          sr: account.providerAccountId,
          kind: input.kind === "link" ? "link" : "self",
          title: input.title,
          sendreplies: "false",
          ...(input.kind === "link" ? { url: input.link ?? "" } : { text: bodyText(input) }),
        });
        const response = await request(
          "https://oauth.reddit.com/api/submit",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": account.defaults?.reddit?.userAgent ?? "",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
          },
          signal,
        );
        const json =
          record(response.value) && record(response.value.json) ? response.value.json : null;
        if (response.status !== 200 || !json || !Array.isArray(json.errors))
          return outcome("UNKNOWN", "REDDIT_CREATE_OUTCOME_UNKNOWN");
        if (json.errors.length) return outcome("REJECTED", "REDDIT_CREATE_REJECTED");
        const data = record(json.data) ? json.data : null;
        if (
          !data ||
          typeof data.name !== "string" ||
          !/^t3_[a-z0-9]+$/.test(data.name) ||
          /[\r\n]/.test(data.name)
        )
          return outcome("UNKNOWN", "REDDIT_CREATE_RECEIPT_INVALID");
        return {
          kind: "PROGRESS",
          checkpoint: checkpointFor(input, account, data.name),
          retryAfterSeconds: 5,
        };
      }
      const method =
        input.kind === "image" ? "sendPhoto" : input.kind === "video" ? "sendVideo" : "sendMessage";
      const body = input.media
        ? {
            chat_id: account.providerAccountId,
            caption: bodyText(input),
            [input.kind === "image" ? "photo" : "video"]: input.media.url,
          }
        : { chat_id: account.providerAccountId, text: bodyText(input) };
      const response = await request(
        `https://api.telegram.org/bot${accessToken}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        signal,
      );
      if (!record(response.value) || response.status !== 200 || response.value.ok !== true)
        return outcome(
          response.status >= 400 &&
            response.status < 500 &&
            record(response.value) &&
            response.value.ok === false
            ? "REJECTED"
            : "UNKNOWN",
          "TELEGRAM_SEND_NOT_CONFIRMED",
        );
      const result = record(response.value.result) ? response.value.result : null;
      const chat = result && record(result.chat) ? result.chat : null;
      if (
        !result ||
        !chat ||
        chat.type !== "channel" ||
        !Number.isSafeInteger(chat.id) ||
        !String(chat.id).startsWith("-100") ||
        !Number.isSafeInteger(result.message_id) ||
        Number(result.message_id) <= 0 ||
        (account.providerAccountId.startsWith("@")
          ? `@${chat.username}`.toLowerCase() !== account.providerAccountId.toLowerCase()
          : String(chat.id) !== account.providerAccountId) ||
        (input.media ? result.caption : result.text) !== bodyText(input) ||
        (input.kind === "image" &&
          (!Array.isArray(result.photo) ||
            result.photo.length === 0 ||
            !result.photo.every(
              (photo: unknown) =>
                record(photo) && typeof photo.file_id === "string" && photo.file_id.length > 0,
            ))) ||
        (input.kind === "video" &&
          (!record(result.video) ||
            typeof result.video.file_id !== "string" ||
            !result.video.file_id))
      )
        return outcome("UNKNOWN", "TELEGRAM_RECEIPT_MISMATCH");
      const channel =
        typeof chat.username === "string" && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(chat.username)
          ? chat.username
          : `c/${String(chat.id).replace(/^-100/, "")}`;
      return {
        kind: "PUBLISHED",
        remoteId: `${chat.id}:${result.message_id}`,
        destination: `https://t.me/${channel}/${result.message_id}`,
      };
    } catch {
      return outcome("UNKNOWN", "PUBLISH_OUTCOME_UNKNOWN");
    }
  }
  return {
    advance,
    async reconcile(
      raw: StudioPublicationInput,
      checkpoint: StudioProviderCheckpoint | null,
      signal?: AbortSignal,
    ): Promise<StudioProviderOutcome> {
      const input = structuredClone(raw);
      const invalid = validate(input);
      if (invalid) return outcome("BLOCKED", invalid);
      if (!checkpoint) return outcome("UNKNOWN", "NO_RECEIPT_REQUIRES_RECONCILIATION");
      return poll(input, structuredClone(checkpoint), signal);
    },
  };
}

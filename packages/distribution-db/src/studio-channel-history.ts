import type { ChannelPost } from "@satsang/distribution-domain";
import type { StudioProviderCredential } from "./studio-provider-config.js";

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[\w:-]{1,160}$/.test(v);
export function youtubePostUrl(value: unknown): string | null {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const video = ["youtube.com", "www.youtube.com"].includes(u.hostname)
      ? u.pathname === "/watch"
        ? u.searchParams.get("v")
        : u.pathname.match(/^\/shorts\/([\w-]{11})$/)?.[1]
      : u.hostname === "youtu.be"
        ? u.pathname.slice(1)
        : null;
    return video && /^[\w-]{11}$/.test(video) ? `https://www.youtube.com/watch?v=${video}` : null;
  } catch {
    return null;
  }
}

/** Demand-only, read-only, fully paginated Buffer inventory, including via:network posts.
 * Buffer's visibility/sync limits still apply; this is not an audiovisual fingerprint search. */
export async function studioYoutubeHistory(account: StudioProviderCredential, fetcher = fetch) {
  if (account.platform !== "youtube" || account.transport !== "buffer" || !account.accessToken)
    throw Error("STUDIO_POSTING_CHECK_UNAVAILABLE");
  const signal = AbortSignal.timeout(45000);
  async function query(query: string, variables: Record<string, unknown>) {
    const res = await fetcher("https://api.buffer.com", {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${account.accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw Error("STUDIO_POSTING_CHECK_UNAVAILABLE");
    const reader = res.body?.getReader();
    if (!reader) throw Error("STUDIO_POSTING_CHECK_UNAVAILABLE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) throw Error("STUDIO_POSTING_CHECK_INCOMPLETE");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(result) || result.errors || !record(result.data))
      throw Error("STUDIO_POSTING_CHECK_UNAVAILABLE");
    return result.data;
  }
  try {
    const { channel } = await query(
      "query PostingChannel($input: ChannelInput!) { channel(input:$input) { id service serviceId organizationId isDisconnected isLocked } }",
      { input: { id: account.providerAccountId } },
    );
    if (
      !record(channel) ||
      channel.id !== account.providerAccountId ||
      channel.service !== "youtube" ||
      !id(channel.organizationId) ||
      typeof channel.serviceId !== "string" ||
      !/^UC[\w-]{22}$/.test(channel.serviceId) ||
      channel.isDisconnected !== false ||
      channel.isLocked !== false
    )
      throw Error("STUDIO_POSTING_CHECK_UNAVAILABLE");
    const posts: ChannelPost[] = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 200; page++) {
      const data = await query(
        "query PostingHistory($input: PostsInput!, $after: String) { posts(input:$input, first:100, after:$after) { edges { node { id channelId channelService status text sentAt externalLink metadata { ... on YoutubePostMetadata { title } } } } pageInfo { hasNextPage endCursor } } }",
        {
          input: {
            organizationId: channel.organizationId,
            filter: {
              channelIds: [account.providerAccountId],
              status: ["sent", "scheduled", "sending"],
            },
          },
          after,
        },
      );
      const result = data.posts;
      if (
        !record(result) ||
        !Array.isArray(result.edges) ||
        !record(result.pageInfo) ||
        typeof result.pageInfo.hasNextPage !== "boolean"
      )
        throw Error("STUDIO_POSTING_CHECK_INCOMPLETE");
      for (const edge of result.edges) {
        const p = record(edge) ? edge.node : null;
        if (
          !record(p) ||
          !id(p.id) ||
          p.channelId !== account.providerAccountId ||
          p.channelService !== "youtube" ||
          typeof p.text !== "string" ||
          !["sent", "scheduled", "sending"].includes(String(p.status))
        )
          throw Error("STUDIO_POSTING_CHECK_INCOMPLETE");
        const meta = record(p.metadata) ? p.metadata : null;
        posts.push({
          id: p.id,
          title: typeof meta?.title === "string" ? meta.title : (p.text.split("\n")[0] ?? ""),
          text: p.text,
          status: String(p.status),
          url: youtubePostUrl(p.externalLink),
          sentAt: typeof p.sentAt === "string" ? p.sentAt : null,
          assetSha256: null,
        });
      }
      if (!result.pageInfo.hasNextPage)
        return {
          destination: `youtube:${channel.serviceId}`,
          posts,
          checkedAt: new Date().toISOString(),
        };
      const cursor = result.pageInfo.endCursor;
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor))
        throw Error("STUDIO_POSTING_CHECK_INCOMPLETE");
      cursors.add(cursor);
      after = cursor;
    }
    throw Error("STUDIO_POSTING_CHECK_INCOMPLETE");
  } catch (e) {
    if (
      e instanceof Error &&
      ["STUDIO_POSTING_CHECK_INCOMPLETE", "STUDIO_POSTING_CHECK_UNAVAILABLE"].includes(e.message)
    )
      throw e;
    throw Error("STUDIO_POSTING_CHECK_UNAVAILABLE");
  }
}

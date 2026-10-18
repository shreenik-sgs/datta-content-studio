import { z } from "zod";
import { readBoundedBody } from "./http";

const identifier = z.string().min(1).max(160);
const channelsSchema = z.object({
  channels: z
    .array(
      z.object({
        id: identifier,
        name: z.string().max(200),
        displayName: z.string().max(200).nullable().optional(),
        service: z.string(),
        isDisconnected: z.boolean(),
        isLocked: z.boolean(),
      }),
    )
    .max(500),
});

/** Read-only discovery against a fixed provider endpoint. Never log/return the API key or raw errors. */
export async function findBufferYoutubeChannels(accessToken: string, fetcher = fetch) {
  const signal = AbortSignal.timeout(20000);
  async function query(query: string, variables?: Record<string, unknown>) {
    const response = await fetcher("https://api.buffer.com", {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query, variables }),
    });
    if ([401, 403].includes(response.status)) throw Error("BUFFER_AUTH_REQUIRED");
    if (!response.ok) throw Error("BUFFER_DISCOVERY_UNAVAILABLE");
    const body = JSON.parse(new TextDecoder().decode(await readBoundedBody(response, 512 * 1024)));
    if (body.errors?.length || !body.data) throw Error("BUFFER_DISCOVERY_UNAVAILABLE");
    return body.data;
  }
  const organizations = z
    .object({ account: z.object({ organizations: z.array(z.object({ id: identifier })).max(25) }) })
    .parse(await query("query HubOrganizations { account { organizations { id } } }"));
  const found = new Map<string, { id: string; label: string; available: boolean }>();
  for (const org of organizations.account.organizations) {
    const data = channelsSchema.parse(
      await query(
        "query HubChannels($input: ChannelsInput!) { channels(input: $input) { id name displayName service isDisconnected isLocked } }",
        { input: { organizationId: org.id } },
      ),
    );
    for (const channel of data.channels.filter((c) => c.service === "youtube"))
      found.set(channel.id, {
        id: channel.id,
        label: channel.displayName || channel.name,
        available: !channel.isDisconnected && !channel.isLocked,
      });
  }
  return [...found.values()];
}

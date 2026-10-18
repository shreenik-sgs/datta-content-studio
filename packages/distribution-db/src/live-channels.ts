import { liveChannelsResponseSchema } from "@satsang/distribution-contracts";
import type { LiveCurationChannel } from "@satsang/distribution-domain";
import { createStudioRoleAuthority } from "./studio-authority";
/** Channels belong to this application; no Sannidhi OAuth connection is read. */
export async function readLiveCurationChannels(
  env: Record<string, string | undefined>,
  actor: { userId: string; isTest: boolean },
): Promise<LiveCurationChannel[]> {
  if (!(await createStudioRoleAuthority(env)({ ...actor, capability: "content.create" })))
    throw Error("FORBIDDEN");
  return liveChannelsResponseSchema.shape.channels.parse(
    JSON.parse(env.STUDIO_LIVE_CHANNELS_JSON ?? "[]"),
  );
}

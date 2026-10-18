import { liveCurationConfigureSchema } from "@satsang/distribution-contracts";
import {
  createLiveCurationRepository,
  createStudioRoleAuthority,
  readLiveCurationChannels,
} from "@satsang/distribution-db";
import { json, readBoundedBody } from "../../../lib/http";
import { access, distributionPool } from "../../../lib/runtime";
import { studioProblem } from "../../../lib/studio-runtime";
const repository = () =>
  createLiveCurationRepository(distributionPool(), createStudioRoleAuthority(process.env));
export async function GET(request: Request) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const state = await repository().list(auth.context);
    let channels: Awaited<ReturnType<typeof readLiveCurationChannels>> = [];
    let channelError: string | null = null;
    try {
      channels = await readLiveCurationChannels(process.env, auth.context);
    } catch {
      channelError =
        "The app could not load the channels configured in Practices. Refresh to retry.";
    }
    return json({
      ...state,
      channels,
      channelError,
      available:
        process.env.STUDIO_LIVE_MONITOR_ENABLED === "true" &&
        (await repository().ready(auth.context.isTest)),
    });
  } catch (error) {
    return studioProblem(error);
  }
}
export async function POST(request: Request) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  const saved: string[] = [];
  try {
    const command = liveCurationConfigureSchema.parse(
      JSON.parse(Buffer.from(await readBoundedBody(request, 20000)).toString("utf8")),
    );
    if (
      command.monitors.some((m) => m.settings.enabled) &&
      (process.env.STUDIO_LIVE_MONITOR_ENABLED !== "true" ||
        !(await repository().ready(auth.context.isTest)))
    )
      return json({ error: "LIVE_MONITOR_UNAVAILABLE" }, 503);
    const channels = command.monitors.some((m) => m.settings.enabled)
      ? await readLiveCurationChannels(process.env, auth.context)
      : [];
    for (const input of command.monitors) {
      const result = await repository().configure(auth.context, input, channels);
      saved.push(result.channelName);
    }
    return json({ saved });
  } catch (error) {
    const code = error instanceof Error ? error.message : "LIVE_CAPTURE_UNAVAILABLE";
    if (code.startsWith("LIVE_") || code === "REVISION_CONFLICT")
      return json({ error: code, saved }, 409);
    return studioProblem(error);
  }
}

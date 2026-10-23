import {
  loadStudioProviderConfig,
  studioSettingsPath,
  studioYoutubeHistory,
} from "@satsang/distribution-db";
import { type PostingCheck, studioChannelPostingMatches } from "@satsang/distribution-domain";
import { z } from "zod";
import { json } from "../../../../../lib/http";
import { access } from "../../../../../lib/runtime";
import { studioJson, studioProblem, studioRepository } from "../../../../../lib/studio-runtime";

/** Operator-triggered read only. No background polling and never approves or queues content. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const id = z
      .string()
      .uuid()
      .parse((await params).id);
    const { accountId } = z
      .object({ accountId: z.string().min(1).max(160) })
      .strict()
      .parse(await studioJson(request));
    const repo = studioRepository();
    const pkg = await repo.get(auth.context, id);
    const config = await loadStudioProviderConfig(
      studioSettingsPath(process.env, auth.context.isTest),
    );
    const account = config.accounts.find(
      (a) => a.id === accountId && a.platform === "youtube" && !a.connectionPending,
    );
    if (!account) throw Error("STUDIO_PUBLISH_ACCOUNT_INVALID");
    const checks: Record<string, PostingCheck> = {};
    let error: string | null = null;
    let inventory: Awaited<ReturnType<typeof studioYoutubeHistory>> | null = null;
    try {
      inventory = await studioYoutubeHistory(account);
    } catch (e) {
      error =
        e instanceof Error && e.message === "STUDIO_POSTING_CHECK_INCOMPLETE"
          ? e.message
          : "STUDIO_POSTING_CHECK_UNAVAILABLE";
    }
    const destination = inventory?.destination ?? `youtube:buffer:${account.providerAccountId}`;
    const known = await repo.checkPostingHistory(
      auth.context,
      id,
      account.id,
      destination,
      "youtube",
    );
    for (const output of pkg.outputs.filter((o) => o.channel === "youtube"))
      checks[output.id] = {
        destination,
        checkedAt: inventory?.checkedAt ?? new Date().toISOString(),
        scanned: inventory?.posts.length ?? 0,
        error,
        matches: [
          ...(known[output.id] ?? []),
          ...studioChannelPostingMatches(output, inventory?.posts ?? []),
        ],
      };
    return json({ accountId, checks });
  } catch (e) {
    return studioProblem(e);
  }
}

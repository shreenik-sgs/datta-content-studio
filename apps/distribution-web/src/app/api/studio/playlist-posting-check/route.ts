import {
  loadStudioProviderConfig,
  studioSettingsPath,
  studioYoutubeHistory,
} from "@satsang/distribution-db";
import { type PostingCheck, studioChannelPostingMatches } from "@satsang/distribution-domain";
import { z } from "zod";
import { json } from "../../../../lib/http";
import { access } from "../../../../lib/runtime";
import { studioJson, studioProblem, studioRepository } from "../../../../lib/studio-runtime";

/** An explicit operator check reads the destination once for the entire series.
 * This never writes history, submits, approves, queues, or publishes anything.
 * Exact Studio receipts come from the batched workspace listing; this response
 * adds potential matches from Buffer's available channel history. */
export async function POST(request: Request) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const { playlistId, accountId } = z
      .object({ playlistId: z.string().uuid(), accountId: z.string().min(1).max(160) })
      .strict()
      .parse(await studioJson(request));
    const packages = await studioRepository().list(auth.context, { playlistId });
    if (!packages.length) throw Error("NOT_FOUND");
    const config = await loadStudioProviderConfig(
      studioSettingsPath(process.env, auth.context.isTest),
    );
    const account = config.accounts.find(
      (item) => item.id === accountId && item.platform === "youtube" && !item.connectionPending,
    );
    if (!account) throw Error("STUDIO_PUBLISH_ACCOUNT_INVALID");
    let inventory: Awaited<ReturnType<typeof studioYoutubeHistory>> | null = null;
    let error: string | null = null;
    try {
      inventory = await studioYoutubeHistory(account);
    } catch (cause) {
      error =
        cause instanceof Error && cause.message === "STUDIO_POSTING_CHECK_INCOMPLETE"
          ? cause.message
          : "STUDIO_POSTING_CHECK_UNAVAILABLE";
    }
    const checkedAt = inventory?.checkedAt ?? new Date().toISOString();
    const destination = inventory?.destination ?? `youtube:buffer:${account.providerAccountId}`;
    const checks: Record<string, PostingCheck> = {};
    const revisions: Record<string, number> = {};
    for (const pkg of packages) {
      revisions[pkg.id] = pkg.revision;
      for (const output of pkg.outputs.filter((item) => item.channel === "youtube"))
        checks[output.id] = {
          destination,
          checkedAt,
          scanned: inventory?.posts.length ?? 0,
          error,
          matches: studioChannelPostingMatches(output, inventory?.posts ?? []),
        };
    }
    return json({ playlistId, accountId, checkedAt, revisions, checks });
  } catch (cause) {
    return studioProblem(cause);
  }
}

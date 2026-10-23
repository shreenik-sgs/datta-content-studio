import type { PostingCheck } from "@satsang/distribution-domain";
import type { LineageState } from "./studio-lineage";
import type {
  PublicStudioOutput,
  PublicStudioPackage,
  PublicStudioPublication,
} from "./studio-model";
import { studioMessage } from "./studio-model";

export type StudioPostingKey =
  | "posted"
  | "earlier_version"
  | "queued"
  | "not_posted"
  | "attention"
  | "simulated"
  | "cancelled";

export type StudioPostingState = LineageState & {
  key: StudioPostingKey;
  url: string | null;
  postedAt: string | null;
};

export const STUDIO_POSTING_FILTERS: { value: StudioPostingKey | "all"; label: string }[] = [
  { value: "all", label: "All posting statuses" },
  { value: "posted", label: "Posted" },
  { value: "queued", label: "Queued / sending" },
  { value: "not_posted", label: "No Studio posting record" },
  { value: "attention", label: "Needs attention" },
  { value: "earlier_version", label: "Earlier version posted" },
  { value: "simulated", label: "Test only" },
  { value: "cancelled", label: "Cancelled / retracted" },
];

function publicUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Display only: publication and duplicate-prevention policy remains in the domain.
 * Account and world scope are essential. A simulated receipt or a similar title
 * must never be counted as a confirmed live upload. */
export function studioPostingState(
  pkg: Pick<PublicStudioPackage, "id" | "isTest" | "revision">,
  output: Pick<PublicStudioOutput, "id" | "channel">,
  publications: readonly PublicStudioPublication[],
  options: {
    accountId?: string | undefined;
    check?: { accountId: string; result: PostingCheck } | undefined;
  } = {},
): StudioPostingState {
  const receipts = publications
    .filter(
      (item) =>
        item.packageId === pkg.id &&
        item.outputId === output.id &&
        item.channel === output.channel &&
        item.isTest === pkg.isTest &&
        (!options.accountId || item.selectedAccountId === options.accountId),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.attempt - a.attempt);
  const current = receipts.find((item) => item.packageRevision === pkg.revision);
  const earlier = receipts.find(
    (item) => item.packageRevision < pkg.revision && !item.isTest && item.status === "PUBLISHED",
  );
  const state = (
    key: StudioPostingKey,
    label: string,
    detail: string,
    tone: LineageState["tone"],
    receipt?: PublicStudioPublication,
  ): StudioPostingState => ({
    key,
    label,
    detail,
    tone,
    url: publicUrl(receipt?.remoteUrl),
    postedAt: key === "posted" || key === "earlier_version" ? (receipt?.updatedAt ?? null) : null,
  });

  if (current) {
    if (current.status === "PUBLISHED")
      return current.isTest
        ? state(
            "attention",
            "Test receipt needs checking",
            "A TEST receipt does not establish that this video is live on the channel.",
            "attention",
          )
        : state(
            "posted",
            "Posted",
            `Studio confirmed publication of the current version (revision ${pkg.revision}).`,
            "success",
            current,
          );
    if (current.status === "SIMULATED")
      return state(
        "simulated",
        "Test only · not posted",
        "Studio simulated this request. It did not upload a video to the channel.",
        "neutral",
      );
    if (["QUEUED", "RUNNING", "PROCESSING"].includes(current.status))
      return state(
        "queued",
        current.status === "QUEUED"
          ? "Queued"
          : current.status === "RUNNING"
            ? "Sending"
            : "Channel is processing",
        `${current.isTest ? "Test request. " : ""}Publication is not yet confirmed.${earlier ? " An earlier version has been posted." : ""}`,
        "pending",
        current,
      );
    if (current.status === "CANCELLED")
      return state(
        "cancelled",
        "Cancelled / retracted",
        "This Studio request is cancelled. This alone does not verify removal of a video from YouTube.",
        "excluded",
        current,
      );
    return state(
      "attention",
      current.status === "UNCERTAIN"
        ? "Check channel"
        : current.status === "BLOCKED"
          ? "Posting blocked"
          : "Posting failed",
      current.error
        ? studioMessage(current.error)
        : "Check the channel and the posting record before retrying; the outcome is not confirmed.",
      "attention",
      current,
    );
  }
  if (earlier)
    return state(
      "earlier_version",
      "Earlier version posted",
      `Revision ${earlier.packageRevision} was posted. The current revision ${pkg.revision} has no Studio publication receipt.`,
      "attention",
      earlier,
    );

  // A channel check must be tied to the currently selected account. Calling UI
  // also binds the snapshot to package revision so edits invalidate stale checks.
  const check =
    options.accountId && options.check?.accountId === options.accountId
      ? options.check.result
      : null;
  if (check) {
    const match = check.matches[0];
    if (match)
      return {
        ...state(
          "attention",
          "Possible existing post",
          "The channel check found a related video or posting record. Compare it before posting; a matching title alone is not proof that this exact file was uploaded.",
          "attention",
        ),
        url: publicUrl(match.url),
      };
    if (check.error)
      return state(
        "attention",
        "Channel check incomplete",
        studioMessage(check.error),
        "attention",
      );
    return state(
      "not_posted",
      "No Studio posting record",
      `No match was found in ${check.scanned} channel records checked. Uploads outside the available history may still exist.`,
      "neutral",
    );
  }
  return state(
    "not_posted",
    "No Studio posting record",
    "Studio has no posting receipt for this file and account. Videos uploaded outside Studio have not been checked.",
    "neutral",
  );
}

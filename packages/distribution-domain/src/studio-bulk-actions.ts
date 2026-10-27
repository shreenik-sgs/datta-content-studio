import type { StudioOutput, StudioPublication } from "./intelligent-content";

/** A selection is an exact scope, never a hint to fall back to the entire package. */
export function studioSelectedOutputs<T extends Pick<StudioOutput, "id" | "included">>(
  outputs: readonly T[],
  ids?: readonly string[],
): T[] {
  const included = outputs.filter((output) => output.included);
  if (!ids) return included;
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !included.some((output) => output.id === id))
  )
    throw Error("INVALID_STUDIO_OUTPUT_SELECTION");
  return included.filter((output) => ids.includes(output.id));
}

export type StudioRetractionResult =
  | "CANCELLED"
  | "ALREADY_CANCELLED"
  | "REMOVE_ON_CHANNEL"
  | "CHECK_CHANNEL";

/** Never equate deleting a Buffer record with deleting the actual channel video. */
export function studioRetractionDecision(
  job: Pick<StudioPublication, "status" | "isTest" | "remoteId" | "channel">,
  hasCheckpoint: boolean,
): StudioRetractionResult {
  if (job.status === "CANCELLED") return "ALREADY_CANCELLED";
  if (job.status === "SIMULATED" && job.isTest) return "CANCELLED";
  if (job.status === "PUBLISHED" && job.channel === "website") return "CANCELLED";
  if (["QUEUED", "BLOCKED"].includes(job.status) && !job.remoteId && !hasCheckpoint)
    return "CANCELLED";
  if (job.status === "PUBLISHED") return "REMOVE_ON_CHANNEL";
  // A worker may already have sent a request. Its lease must not be revoked here.
  return "CHECK_CHANNEL";
}

export type StudioPublicationRetry = "REQUEUE" | "FRESH_ATTEMPT" | null;
/** Which earlier posting request an explicit Post may send again.
 * A blocked request never reached the channel: queue the same request. A failed
 * request was rejected by the channel after the provider created it; that provider
 * record is never published, so a fresh attempt creates a new one and keeps the
 * old id in the attempt history. Unknown or completed outcomes are never repeated. */
export function studioPublicationRetryDecision(
  job: Pick<StudioPublication, "status" | "remoteId">,
  hasCheckpoint: boolean,
): StudioPublicationRetry {
  if (job.status === "BLOCKED" && !job.remoteId && !hasCheckpoint) return "REQUEUE";
  if (job.status === "FAILED") return "FRESH_ATTEMPT";
  return null;
}
/** Consecutive channel rejections on one account that pause the rest of its queue,
 * so a plan or daily upload limit is not discovered one failed post at a time. */
export const STUDIO_PUBLISHING_PAUSE_REJECTIONS = 3;
export function studioPublishingShouldPause(recentStatuses: readonly string[]): boolean {
  return (
    recentStatuses.length >= STUDIO_PUBLISHING_PAUSE_REJECTIONS &&
    recentStatuses
      .slice(0, STUDIO_PUBLISHING_PAUSE_REJECTIONS)
      .every((status) => status === "FAILED")
  );
}

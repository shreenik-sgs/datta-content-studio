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

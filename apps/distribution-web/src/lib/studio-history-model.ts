import type { PublicStudioOutput, PublicStudioPackage } from "./studio-model";

export type StudioHistoryEntry = {
  revision: number;
  action: string;
  actorId: string;
  createdAt: string;
  package: PublicStudioPackage;
};
export type StudioHistoryPage = {
  version: 1;
  revisions: StudioHistoryEntry[];
  nextOffset: number | null;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reject another package or protocol version before displaying historical metadata. */
export function readStudioHistory(value: unknown, packageId: string): StudioHistoryPage {
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.revisions) ||
    !(
      value.nextOffset === null ||
      (Number.isSafeInteger(value.nextOffset) && Number(value.nextOffset) >= 0)
    )
  )
    throw new Error("INVALID_HISTORY_RESPONSE");
  for (const entry of value.revisions) {
    if (
      !record(entry) ||
      !Number.isSafeInteger(entry.revision) ||
      Number(entry.revision) < 1 ||
      typeof entry.action !== "string" ||
      typeof entry.actorId !== "string" ||
      typeof entry.createdAt !== "string" ||
      !Number.isFinite(Date.parse(entry.createdAt)) ||
      !record(entry.package) ||
      entry.package.id !== packageId ||
      entry.package.revision !== entry.revision ||
      !Array.isArray(entry.package.outputs)
    )
      throw new Error("INVALID_HISTORY_RESPONSE");
  }
  return value as StudioHistoryPage;
}

export function mergeStudioHistory(
  previous: readonly StudioHistoryEntry[],
  incoming: readonly StudioHistoryEntry[],
): StudioHistoryEntry[] {
  return [
    ...new Map([...previous, ...incoming].map((entry) => [entry.revision, entry])).values(),
  ].sort((a, b) => b.revision - a.revision);
}

function files(output: PublicStudioOutput) {
  return JSON.stringify({
    asset: output.asset ? [output.asset.filename, output.asset.sha256] : null,
    captions: output.captions.map((caption) => [
      caption.language,
      caption.asset.filename,
      caption.asset.sha256,
    ]),
  });
}

export function studioHistoricalFileChange(
  output: PublicStudioOutput,
  previous: StudioHistoryEntry | undefined,
  revision: number,
): string {
  if (!output.asset) return "File needs generation";
  if (!previous)
    return revision === 1 ? "First saved file" : "Load the previous activity to compare";
  const earlier = previous.package.outputs.find((item) => item.id === output.id);
  if (!earlier?.asset) return "New file";
  return files(output) === files(earlier) ? "Files unchanged" : "File or captions changed";
}

export function studioHistoryChange(
  current: StudioHistoryEntry,
  previous: StudioHistoryEntry | undefined,
): string {
  if (!previous) return current.revision === 1 ? "Package created" : "Earlier activity not loaded";
  const content = (entry: StudioHistoryEntry) =>
    JSON.stringify(
      entry.package.outputs.map((output) => ({
        id: output.id,
        title: output.title,
        body: output.body,
        included: output.included,
        channel: output.channel,
        format: output.format,
        language: output.language,
        startMs: output.startMs,
        endMs: output.endMs,
        files: files(output),
      })),
    );
  return content(current) === content(previous)
    ? "Workflow update · files unchanged"
    : "Content or file selection changed";
}

export function studioHistoryAction(action: string): string {
  return (
    (
      {
        CREATED: "Package created",
        GENERATION_REQUESTED: "Generation requested",
        GENERATED: "Content generated",
        GENERATION_FAILED: "Generation needs attention",
        REVISED: "Content Curator revision",
        SUBMITTED: "Submitted for Content Approver review",
        REJECTED: "Changes requested",
        APPROVED: "Approved",
        APPROVED_TEACHING_AND_MACHINE_TRANSCRIPT: "Approved after teaching and transcript review",
        APPROVED_TEACHING_AND_APPROVED_TRANSCRIPT: "Approved after teaching review",
        DISCARDED: "Package or output discarded",
      } as Record<string, string>
    )[action] ?? "Workflow updated"
  );
}

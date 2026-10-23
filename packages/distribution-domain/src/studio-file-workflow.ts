import type { DistributionCapability } from "./content";
import type {
  StudioApproval,
  StudioOutput,
  StudioPackage,
  StudioStatus,
} from "./intelligent-content";
import { studioCanEdit } from "./studio-workflow";

export type StudioFileWorkflow = {
  status: "DRAFT" | "IN_REVIEW" | "CHANGES_REQUESTED" | "APPROVED" | "DISCARDED";
  actorId: string;
  updatedAt: string;
  approval?: StudioApproval & { fingerprint: string };
};
type File = Pick<StudioOutput, "id" | "included" | "workflow">;
type Package = Pick<StudioPackage, "status" | "approval" | "revision">;

/** Old packages retain their existing review state until the first scoped transition. */
export function studioFileStatus(pkg: Pick<Package, "status">, output: File): StudioStatus {
  if (pkg.status === "DISCARDED" || !output.included) return "DISCARDED";
  return output.workflow?.status ?? pkg.status;
}
export function studioFileApproval(pkg: Package, output: File): StudioApproval | null {
  if (studioFileStatus(pkg, output) !== "APPROVED") return null;
  return output.workflow ? (output.workflow.approval ?? null) : pkg.approval;
}
export function studioCanEditFile(
  pkg: Pick<Package, "status">,
  output: File,
  capabilities: readonly DistributionCapability[],
) {
  return (
    !["QUEUED", "GENERATING", "DISCARDED"].includes(pkg.status) &&
    studioCanEdit(studioFileStatus(pkg, output), capabilities)
  );
}
export function studioFileWorkflowStep(pkg: Pick<Package, "status">, output: File) {
  const status = studioFileStatus(pkg, output);
  return status === "DISCARDED"
    ? null
    : status === "APPROVED"
      ? 6
      : status === "IN_REVIEW"
        ? 4
        : status === "CHANGES_REQUESTED"
          ? 5
          : ["QUEUED", "GENERATING", "FAILED"].includes(status)
            ? 2
            : 3;
}
export function studioAggregateFileStatus(outputs: readonly File[]): StudioStatus {
  const states = outputs.filter((o) => o.included).map((o) => o.workflow?.status ?? "DRAFT");
  if (!states.length) return "DISCARDED";
  for (const state of ["CHANGES_REQUESTED", "IN_REVIEW", "DRAFT"] as const)
    if (states.includes(state)) return state;
  return states.every((state) => state === "APPROVED") ? "APPROVED" : "DRAFT";
}

/** A file's approval survives sibling transitions. Jobs before its approval are older versions. */
export function studioPublicationMatchesFile(
  pkg: Pick<StudioPackage, "revision">,
  output: Pick<StudioOutput, "workflow">,
  publication: { packageRevision: number },
) {
  return (
    publication.packageRevision === pkg.revision ||
    Boolean(
      output.workflow?.status === "APPROVED" &&
        output.workflow.approval &&
        publication.packageRevision >= output.workflow.approval.revision &&
        publication.packageRevision <= pkg.revision,
    )
  );
}

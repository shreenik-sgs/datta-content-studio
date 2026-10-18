import type { DistributionCapability } from "./content";
import type { StudioStatus } from "./intelligent-content";

const editable: readonly StudioStatus[] = ["DRAFT", "CHANGES_REQUESTED", "FAILED"];

/** Curators work only before submission or after a reviewer returns the package. */
export function studioCanEdit(
  status: StudioStatus,
  capabilities: readonly DistributionCapability[],
): boolean {
  return capabilities.includes("content.create") && editable.includes(status);
}

/** Exclusion is a review decision once a package has been submitted. */
export function studioCanDiscard(
  status: StudioStatus,
  capabilities: readonly DistributionCapability[],
  target: "package" | "output",
): boolean {
  if (status === "DISCARDED") return false;
  if (capabilities.includes("content.review")) {
    if (target === "package") return true;
    if (status === "IN_REVIEW" || status === "APPROVED") return true;
  }
  return studioCanEdit(status, capabilities);
}

/** Removing an approved output requires fresh approval of the remaining exact revision. */
export function studioStatusAfterOutputDiscard(status: StudioStatus): StudioStatus {
  return status === "IN_REVIEW" || status === "APPROVED" ? "IN_REVIEW" : "DRAFT";
}

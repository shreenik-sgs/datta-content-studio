import { describe, expect, it } from "vitest";
import type { StudioStatus } from "./intelligent-content";
import { studioCanDiscard, studioCanEdit, studioStatusAfterOutputDiscard } from "./studio-workflow";

const statuses: StudioStatus[] = [
  "QUEUED",
  "GENERATING",
  "DRAFT",
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "DISCARDED",
  "FAILED",
];
describe("Studio duties after handoff", () => {
  it.each(statuses)("limits curator mutations at %s to editable work", (status) => {
    const editable = ["DRAFT", "CHANGES_REQUESTED", "FAILED"].includes(status);
    expect(studioCanEdit(status, ["content.create"])).toBe(editable);
    expect(studioCanDiscard(status, ["content.create"], "output")).toBe(editable);
    expect(studioCanDiscard(status, ["content.create"], "package")).toBe(editable);
    expect(studioCanEdit(status, ["content.review", "content.publish"])).toBe(false);
    expect(studioCanDiscard(status, ["content.publish"], "output")).toBe(false);
  });
  it.each(statuses)("keeps approver exclusion in the review workflow at %s", (status) => {
    expect(studioCanDiscard(status, ["content.review"], "package")).toBe(status !== "DISCARDED");
    expect(studioCanDiscard(status, ["content.review"], "output")).toBe(
      status === "IN_REVIEW" || status === "APPROVED",
    );
    if (status === "IN_REVIEW" || status === "APPROVED")
      expect(studioStatusAfterOutputDiscard(status)).toBe("IN_REVIEW");
  });
  it("requires fresh review when the same person also holds curator authority", () => {
    const both = ["content.create", "content.review"] as const;
    expect(studioCanEdit("APPROVED", both)).toBe(false);
    expect(studioCanDiscard("IN_REVIEW", both, "output")).toBe(true);
    expect(studioStatusAfterOutputDiscard("APPROVED")).toBe("IN_REVIEW");
  });
});

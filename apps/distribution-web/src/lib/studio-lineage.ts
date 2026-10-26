import {
  studioFileApproval,
  studioFileStatus,
  studioPublicationMatchesFile,
  studioRenderedDurationMs,
} from "@satsang/distribution-domain";
import type { StudioFeedback } from "@satsang/distribution-domain";
import {
  type PublicStudioOutput,
  type PublicStudioPackage,
  type PublicStudioPublication,
  STUDIO_PUBLICATION_LABELS,
  STUDIO_STATUS_LABELS,
  studioMessage,
} from "./studio-model";

export type LineageState = {
  label: string;
  detail: string;
  tone: "neutral" | "pending" | "success" | "attention" | "excluded";
};

/** These are source clip boundaries, not measured encoded-video duration. */
export function studioOutputLength(output: PublicStudioOutput): { label: string; detail: string } {
  if (["short", "reel", "video"].includes(output.format)) {
    if (
      output.startMs === null ||
      output.endMs === null ||
      !Number.isFinite(output.startMs) ||
      !Number.isFinite(output.endMs) ||
      output.endMs <= output.startMs
    )
      return { label: "Not available", detail: "Source clip duration" };
    const seconds = (output.listedDurationMs ?? studioRenderedDurationMs(output)) / 1000;
    return {
      label: `${Number(seconds.toFixed(2))} sec`,
      detail:
        (output.listedClosingHoldMs ?? output.presentationReview?.closingCard?.cleanHoldMs)
          ? "Video including clean closing card"
          : "Source clip",
    };
  }
  if (output.format === "blog") {
    const count = [
      ...new Intl.Segmenter(output.language, { granularity: "word" }).segment(output.body),
    ].filter((part) => part.isWordLike).length;
    return { label: `${count} ${count === 1 ? "word" : "words"}`, detail: "Blog copy" };
  }
  const count = [
    ...new Intl.Segmenter(output.language, { granularity: "grapheme" }).segment(output.body),
  ].length;
  return {
    label: `${count} ${count === 1 ? "character" : "characters"}`,
    detail: "Post copy · visible characters",
  };
}

/** Review belongs to the package. A receipt only describes its exact reviewed
 * revision, output, channel and world; old receipts cannot label edited files. */
export function studioOutputState(
  value: PublicStudioPackage,
  output: PublicStudioOutput,
  publications: readonly PublicStudioPublication[],
): LineageState {
  const status = studioFileStatus(value, output);
  if (value.status === "DISCARDED")
    return { label: "Discarded", detail: "Package discarded", tone: "excluded" };
  if (!output.included)
    return {
      label: "Excluded",
      detail: "Kept for traceability; not selected for publication",
      tone: "excluded",
    };
  if (status !== "APPROVED" && output.correction)
    return {
      label:
        output.correction.state === "pending"
          ? "Changes requested for this file"
          : output.correction.state === "revised"
            ? "Corrected · ready to resubmit"
            : "Corrected · awaiting review",
      detail: output.correction.comment,
      tone: output.correction.state === "pending" ? "attention" : "pending",
    };
  if (!output.workflow && status === "CHANGES_REQUESTED" && value.outputs.some((o) => o.correction))
    return {
      label: "Unchanged · awaiting package review",
      detail: "Another file was returned for correction",
      tone: "pending",
    };
  if (status !== "APPROVED")
    return {
      label: STUDIO_STATUS_LABELS[status],
      detail: `Package revision ${value.revision}`,
      tone:
        status === "CHANGES_REQUESTED" || status === "FAILED"
          ? "attention"
          : status === "IN_REVIEW"
            ? "pending"
            : "neutral",
    };
  if (
    !studioFileApproval(value, output) ||
    (!output.workflow && value.approval?.revision !== value.revision)
  )
    return {
      label: "Review required",
      detail: "Approval does not match this package revision",
      tone: "attention",
    };
  const publication = publications
    .filter(
      (item) =>
        item.packageId === value.id &&
        studioPublicationMatchesFile(value, output, item) &&
        item.outputId === output.id &&
        item.channel === output.channel &&
        item.isTest === value.isTest,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.attempt - a.attempt)[0];
  if (!publication)
    return {
      label: "Approved",
      detail: "No publication receipt for this revision",
      tone: "success",
    };
  if (value.isTest && publication.status === "PUBLISHED")
    return {
      label: "Test result needs verification",
      detail: "A TEST receipt does not establish live publication",
      tone: "attention",
    };
  return {
    label: STUDIO_PUBLICATION_LABELS[publication.status],
    detail: publication.error
      ? studioMessage(publication.error)
      : `Package revision ${publication.packageRevision}`,
    tone:
      publication.status === "PUBLISHED"
        ? "success"
        : ["FAILED", "BLOCKED", "UNCERTAIN"].includes(publication.status)
          ? "attention"
          : publication.status === "CANCELLED"
            ? "excluded"
            : "pending",
  };
}

/** No output-targeted reviewer field exists: display the latest shared review,
 * including its revision, rather than assigning a package note to one file. */
export function studioLatestReview(value: PublicStudioPackage): StudioFeedback | null {
  return (
    value.feedback
      .filter((item) => ["APPROVED", "REJECTED", "DISCARDED"].includes(item.action))
      .sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

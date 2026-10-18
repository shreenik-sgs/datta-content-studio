import type { StudioGenerationProgress, StudioPackage } from "./intelligent-content";
import {
  type StudioBoundaryReview,
  studioBoundaryPasses,
  validateStudioBoundaryReview,
} from "./studio-boundary-review";
import { type StudioPlan, studioOutputKey, validStudioMessageId } from "./studio-planner";

export type StudioExcludedMessage = { messageId: string; title: string; reasons: string[] };

export const STUDIO_STANDALONE_CONTEXT_GUIDANCE =
  "For a standalone Short/Reel, evaluate only what the viewer hears inside the selected clip. Surrounding transcript is boundary evidence, not context the viewer has heard. An opening such as After performing such a sacrifice, he realized this is not the way depends on an unidentified person and prior event; it fails openingComplete and contextComplete unless the included speech itself promptly establishes the necessary actor, event and reason. A broadly understandable moral later in the clip does not excuse a dangling story opening. A harmless discourse connector such as likewise is not by itself a failure when the following teaching is independently clear. Do not repair missing context by inserting a name, event, motive or conclusion into translated captions when it is absent from the included native speech. An exact pronoun may be rendered naturally, but a translator must not import missing narrative facts. The title, description, artwork and reviewer knowledge cannot supply missing spoken setup. Select another complete contiguous passage, or include the necessary setup within the channel duration limit; never invent introductory narration.";

/** Candidate discovery can omit unsuitable proposals; editing a delivered file never can. */
export function canSelectInitialStudioCandidates(pkg: StudioPackage, selectedCorrection: boolean) {
  return (
    pkg.request.allCompleteMessages === true &&
    pkg.outputs.length === 0 &&
    pkg.provenance == null &&
    pkg.feedback.length === 0 &&
    !selectedCorrection
  );
}

/** Keep complete reviewed messages across every variant, without rewriting the passing work. */
export function selectInitialStudioCandidates(
  plan: StudioPlan,
  checks: StudioContentReview[],
  request: StudioPackage["request"],
): StudioPlan {
  validateStudioContentReview({ checks }, plan);
  const excluded = new Map<string, string[]>();
  for (const check of checks) {
    const issues = studioContentReviewIssues([check]);
    if (!issues.length) continue;
    if (!validStudioMessageId(check.messageId)) throw Error("INVALID_STUDIO_MESSAGE");
    excluded.set(check.messageId, [...(excluded.get(check.messageId) ?? []), ...issues]);
  }
  if (!excluded.size) return plan;
  let outputs = plan.outputs.filter((output) => !excluded.has(output.messageId ?? ""));
  const skippedChannels = [...plan.skippedChannels];
  for (const channel of request.channels) {
    if (
      !skippedChannels.some((skip) => skip.channel === channel) &&
      request.languages.some(
        (language) => !outputs.some((o) => o.channel === channel && o.language === language),
      )
    ) {
      outputs = outputs.filter((output) => output.channel !== channel);
      skippedChannels.push({
        channel,
        reason:
          "No complete candidate passed AI review in every selected language for this channel.",
      });
    }
  }
  return {
    ...plan,
    outputs,
    skippedChannels,
    excludedMessages: [...excluded].map(([messageId, reasons]) => ({
      messageId,
      title: plan.outputs.find((output) => output.messageId === messageId)?.title ?? messageId,
      reasons,
    })),
  };
}

export const STUDIO_CONTENT_REVIEW_CHECKS = [
  "openingComplete",
  "endingComplete",
  "contextComplete",
  "attributionCorrect",
  "captionsFaithful",
  "copySupported",
] as const;

export type StudioContentReview = {
  boundary?: StudioBoundaryReview;
  messageId?: string;
  channel: string;
  language: string;
  reason: string;
} & Record<(typeof STUDIO_CONTENT_REVIEW_CHECKS)[number], boolean>;

/** A separate editorial check is evidence, never human approval. Missing checks fail closed. */
export function validateStudioContentReview(raw: unknown, plan: StudioPlan): StudioContentReview[] {
  const invalid = () => new Error("STUDIO_VIDEO_REVIEW_INVALID");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const checks = (raw as { checks?: unknown }).checks;
  const videos = plan.outputs;
  if (!Array.isArray(checks) || checks.length !== videos.length) throw invalid();
  const seen = new Set<string>();
  return checks.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const check = value as StudioContentReview;
    const key = studioOutputKey(check);
    if (
      !videos.some((o) => studioOutputKey(o) === key) ||
      seen.has(key) ||
      typeof check.reason !== "string" ||
      !check.reason.trim() ||
      check.reason.length > 3000 ||
      STUDIO_CONTENT_REVIEW_CHECKS.some((field) => typeof check[field] !== "boolean")
    )
      throw invalid();
    seen.add(key);
    if (check.boundary) {
      validateStudioBoundaryReview(check.boundary);
      if (
        (check.openingComplete && !studioBoundaryPasses(check.boundary.opening)) ||
        (check.endingComplete && !studioBoundaryPasses(check.boundary.ending))
      )
        throw invalid();
    }
    return check;
  });
}

export function studioContentReviewIssues(checks: StudioContentReview[]): string[] {
  return checks.flatMap((check) => {
    const failures = STUDIO_CONTENT_REVIEW_CHECKS.filter((field) => !check[field]);
    return failures.length
      ? [
          `${check.channel}/${check.language}${check.messageId ? `/${check.messageId}` : ""}: ${failures.join(", ")}. ${check.reason}`,
        ]
      : [];
  });
}

/** A narrow extra guard for recognizable transliterated verses, not a language classifier. */
export function studioEnglishCaptionNeedsTranslation(text: string): boolean {
  const english = new Set(
    "the and this that these those is are was were be being been you your we our they their it its of with from for into who which when where what how not only through children meaning verse".split(
      " ",
    ),
  );
  const sanskrit = new Set(
    "aham tvam tesam mayi mayy bhavami bhavati yatra tatra yad tad yatha tatha sarvam eva api ca vai iti ya yah yena evam trividham narakasyedam dvaram nasanam atmanah kama krodha lobha tasmad etat trayam tyajet".split(
      " ",
    ),
  );
  const passages = [text, ...(text.match(/[‘'“"][^‘'’“”"]{15,}[’'”"]/gu) ?? [])];
  return passages.some((passage) => {
    const diacritics = (passage.match(/[āīūṛṝḷṅñṭḍṇśṣḥṁṃ]/giu) ?? []).length;
    const words =
      passage
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .match(/[a-z]+/g) ?? [];
    const recognized = words.filter((word) => sanskrit.has(word)).length;
    return (
      words.length >= 5 &&
      ((diacritics >= 2 && recognized >= 2) || recognized >= 4) &&
      !words.some((word) => english.has(word))
    );
  });
}

export type StudioAiReviewEvidence = {
  status: "PASSED";
  policyVersion: "content-integrity-v1";
  provider: "gemini" | "openai";
  model: string;
  recordedAt: string;
  reviewedAt?: string;
  inputMode: "transcript" | "transcript_and_audio";
  sourceSha256: string;
  fileVersion: number;
  humanFeedbackConsidered: boolean;
  checks: StudioContentReview;
};

export function validateStudioAiReviewEvidence(
  review: StudioAiReviewEvidence,
  target: {
    channel: string;
    language: string;
    messageId?: string;
    fileVersion: number;
    sourceSha256: string;
    startMs?: number | null;
    endMs?: number | null;
  },
): void {
  if (
    !review ||
    review.status !== "PASSED" ||
    review.policyVersion !== "content-integrity-v1" ||
    !["gemini", "openai"].includes(review.provider) ||
    typeof review.model !== "string" ||
    !review.model.trim() ||
    review.model.length > 128 ||
    !Number.isFinite(Date.parse(review.recordedAt)) ||
    (review.reviewedAt !== undefined && !Number.isFinite(Date.parse(review.reviewedAt))) ||
    !["transcript", "transcript_and_audio"].includes(review.inputMode) ||
    review.sourceSha256 !== target.sourceSha256 ||
    review.fileVersion !== target.fileVersion ||
    typeof review.humanFeedbackConsidered !== "boolean" ||
    !review.checks ||
    review.checks.channel !== target.channel ||
    review.checks.language !== target.language ||
    review.checks.messageId !== target.messageId ||
    typeof review.checks.reason !== "string" ||
    !review.checks.reason.trim() ||
    review.checks.reason.length > 3000 ||
    STUDIO_CONTENT_REVIEW_CHECKS.some((field) => review.checks[field] !== true)
  )
    throw new Error("INVALID_STUDIO_AI_REVIEW");
  if (review.checks.boundary) {
    validateStudioBoundaryReview(
      review.checks.boundary,
      target.startMs != null && target.endMs != null
        ? { startMs: target.startMs, endMs: target.endMs }
        : undefined,
    );
    if (
      !studioBoundaryPasses(review.checks.boundary.opening) ||
      !studioBoundaryPasses(review.checks.boundary.ending)
    )
      throw Error("INVALID_STUDIO_AI_REVIEW");
  }
}

/** Repair a failed teaching across its channel variants while retaining unrelated reviewed work. */
export function studioContentRepairTargets(plan: StudioPlan, checks: StudioContentReview[]) {
  validateStudioContentReview({ checks }, plan);
  const failed = checks.filter((check) => studioContentReviewIssues([check]).length);
  return plan.outputs.filter((output) =>
    failed.some((check) =>
      output.messageId && check.messageId
        ? output.messageId === check.messageId
        : studioOutputKey(output) === studioOutputKey(check),
    ),
  );
}

/** Bound a repair to one teaching and its channel variants, never the entire failed package. */
export function studioContentRepairBatches(plan: StudioPlan, checks: StudioContentReview[]) {
  const batches = new Map<string, StudioPlan["outputs"]>();
  for (const output of studioContentRepairTargets(plan, checks)) {
    const key = output.messageId ? `message:${output.messageId}` : studioOutputKey(output);
    const batch = batches.get(key) ?? [];
    batch.push(output);
    batches.set(key, batch);
  }
  return [...batches.values()];
}

/** Explicitly selected versions of one teaching share one correction plan. Other files stay out. */
export function studioSelectedMessageGroups<
  T extends { id: string; messageId?: string; channel: string; language: string },
>(outputs: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const output of outputs) {
    // Each planner request covers channels × languages. Keep an uneven selection from inventing
    // unselected variants (for example YouTube English plus Facebook Hindi).
    const channels = outputs
      .filter((other) => other.messageId === output.messageId && other.language === output.language)
      .map((other) => other.channel)
      .sort();
    const key = output.messageId
      ? `message:${output.messageId}:${channels.join(",")}`
      : `file:${output.id}`;
    const group = groups.get(key) ?? [];
    group.push(output);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Image/review substeps must not reset a selected master back to zero completed files. */
export function studioScopedGenerationProgress(
  progress: StudioGenerationProgress,
  counts: { finished: number; groupSize: number; groupCompleted: number; total: number },
): { progress: StudioGenerationProgress; groupCompleted: number } {
  const reported =
    progress.phase === "complete"
      ? counts.groupSize
      : progress.phase === "rendering" && progress.total === counts.groupSize
        ? progress.completed
        : counts.groupCompleted;
  const groupCompleted = Math.min(counts.groupSize, Math.max(counts.groupCompleted, reported));
  const completed = Math.min(counts.total, counts.finished + groupCompleted);
  return {
    groupCompleted,
    progress: {
      ...progress,
      phase:
        progress.phase === "complete" && completed < counts.total ? "rendering" : progress.phase,
      completed,
      total: counts.total,
    },
  };
}

/** Provider rewrites of passing files are ignored; shared captions for those files are preserved. */
export function mergeStudioContentRepair(
  original: StudioPlan,
  repaired: StudioPlan,
  targets: StudioPlan["outputs"],
): StudioPlan {
  const keys = new Set(targets.map(studioOutputKey));
  const replacements = repaired.outputs.filter((output) => keys.has(studioOutputKey(output)));
  if (
    replacements.length !== keys.size ||
    new Set(replacements.map(studioOutputKey)).size !== keys.size
  )
    throw new Error("STUDIO_EDITED_OUTPUT_OMITTED");
  const outputs = original.outputs.map((output) =>
    keys.has(studioOutputKey(output))
      ? (replacements.find(
          (replacement) => studioOutputKey(replacement) === studioOutputKey(output),
        ) as StudioPlan["outputs"][number])
      : output,
  );
  const languages = new Set(
    [...original.translations, ...repaired.translations].map((value) => value.language),
  );
  return {
    ...original,
    outputs,
    translations: [...languages].map((language) => {
      const preservedIds = new Set(
        original.outputs
          .filter((output) => output.language === language && !keys.has(studioOutputKey(output)))
          .flatMap((output) => output.sourceSegmentIds),
      );
      const requiredIds = new Set(
        outputs
          .filter((output) => output.language === language)
          .flatMap((output) => output.sourceSegmentIds),
      );
      const segments = new Map(
        original.translations
          .find((value) => value.language === language)
          ?.segments.map((segment) => [segment.id, segment]),
      );
      for (const segment of repaired.translations.find((value) => value.language === language)
        ?.segments ?? [])
        if (!preservedIds.has(segment.id)) segments.set(segment.id, segment);
      return {
        language,
        segments: [...segments.values()].filter((segment) => requiredIds.has(segment.id)),
      };
    }),
  };
}

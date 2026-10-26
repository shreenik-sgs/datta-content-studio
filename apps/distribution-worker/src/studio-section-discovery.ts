import {
  STUDIO_DISCOVERY_POLICY,
  type StudioDiscoveryCoverage,
  type StudioPlan,
  studioDiscoveryOverlaps,
  studioDiscoverySections,
  studioDiscoveryTranscript,
  studioFormatForChannel,
  studioSourceRange,
  validateStudioDiscoveryDecisions,
  validateStudioPlan,
} from "@satsang/distribution-domain";
import {
  type StudioCheckpoints,
  StudioNoSuitableContentError,
  studioFingerprint,
} from "./studio-checkpoints.js";
import {
  STUDIO_EDITORIAL_REVIEW_POLICY,
  StudioContentQualityError,
} from "./studio-content-review.js";
import { reviewStudioDiscoveryNovelty } from "./studio-discovery-review.js";
import type { generateStudioPlan } from "./studio-intelligence.js";

type Input = Parameters<typeof generateStudioPlan>[0];
type Options = import("./studio-checkpoints.js").StudioPlanReviewOptions;
type Run = (
  input: Input,
  checkpoints?: StudioCheckpoints,
  options?: Options,
) => Promise<StudioPlan>;

/** Each paid section and its novelty decision can be resumed independently after interruption. */
export async function generateStudioSectionPlan(
  input: Input,
  checkpoints: StudioCheckpoints | undefined,
  options: Options,
  run: Run,
): Promise<StudioPlan> {
  const sections = studioDiscoverySections(input.transcript);
  const videos = input.pkg.request.channels.filter((c) =>
    ["short", "reel"].includes(studioFormatForChannel(c)),
  );
  const written = input.pkg.request.channels.filter((c) => !videos.includes(c));
  const combined: StudioPlan = { outputs: [], translations: [], skippedChannels: [] };
  const coverage: StudioDiscoveryCoverage = {
    policy: STUDIO_DISCOVERY_POLICY,
    sections: [],
    completedAt: "",
  };
  const existing = input.discoveryExcludedOutputs ?? [];
  for (const section of sections) {
    if (input.signal?.aborted) throw input.signal.reason;
    const prefix = `discovery:${section.startMs}`;
    const identity = (id: string | undefined) =>
      `section-${section.startMs}-${studioFingerprint(id).slice(0, 16)}`;
    const namespace: StudioCheckpoints | undefined = checkpoints
      ? {
          get: (key, fingerprint) => checkpoints.get(`${prefix}:${key}`, fingerprint),
          set: (key, fingerprint, value) => checkpoints.set(`${prefix}:${key}`, fingerprint, value),
          progress: (value) =>
            checkpoints.progress({
              ...value,
              discoverySection: section.index + 1,
              discoverySections: sections.length,
            }),
        }
      : undefined;
    const retained = [...existing, ...combined.outputs];
    const { originalAudio: _audio, ...base } = input;
    const scoped: Input = {
      ...base,
      pkg: { ...input.pkg, outputs: [], request: { ...input.pkg.request, channels: videos } },
      transcript: studioDiscoveryTranscript(input.transcript, section),
      discoverySection: section,
      discoveryExcludedOutputs: retained,
    };
    // A completed empty section is a reviewed outcome, not a transient failure. Preserve it
    // during a later render retry so new candidates cannot shift downstream deduplication.
    const emptyFingerprint = studioFingerprint({
      version: 1,
      discoveryPolicy: STUDIO_DISCOVERY_POLICY,
      editorialPolicy: STUDIO_EDITORIAL_REVIEW_POLICY,
      section,
      source: scoped.pkg.source,
      request: scoped.pkg.request,
      feedback: scoped.pkg.feedback,
      transcript: scoped.transcript,
      retained,
      provider: scoped.provider,
      model: scoped.model,
      fallback: options.fallback && {
        provider: options.fallback.provider,
        model: options.fallback.model,
      },
      audioReview: Boolean(input.reviewAudio),
      mediaReview: Boolean(options.reviewMedia),
      mediaReviewPolicy: options.mediaReviewPolicy,
    });
    type EmptyOutcome = "no-suitable-content" | "quality-review-rejected";
    const recordEmpty = async (outcome: EmptyOutcome) => {
      const result = {
        ...section,
        candidates: 0,
        accepted: 0,
        duplicates: 0,
        reason:
          outcome === "quality-review-rejected"
            ? "Candidate teachings did not pass the strict quality review after correction attempts."
            : "No suitable complete teaching found in this section.",
      };
      coverage.sections.push(result);
      await namespace?.set("coverage", studioFingerprint(scoped.transcript), result);
      await checkpoints?.progress({
        phase: "drafting",
        provider: input.provider,
        completed: section.index + 1,
        total: sections.length,
        discoverySection: section.index + 1,
        discoverySections: sections.length,
      });
    };
    const empty = namespace?.get<EmptyOutcome>("completed-empty-section", emptyFingerprint);
    if (empty === "no-suitable-content" || empty === "quality-review-rejected") {
      await recordEmpty(empty);
      continue;
    }
    let plan: StudioPlan;
    try {
      plan = await run(scoped, namespace, {
        ...options,
        ...(options.onReview
          ? {
              onReview: (
                checks: Parameters<NonNullable<Options["onReview"]>>[0],
                evidence: Parameters<NonNullable<Options["onReview"]>>[1],
              ) =>
                options.onReview?.(
                  checks.map((c) => ({ ...c, messageId: identity(c.messageId) })),
                  evidence,
                ),
            }
          : {}),
      });
    } catch (error) {
      // A completed suitability review may legitimately find no complete teaching in a section.
      // Provider, timeout, contract and source-integrity failures always remain resumable errors.
      if (
        !(error instanceof StudioNoSuitableContentError) &&
        !(error instanceof StudioContentQualityError)
      )
        throw error;
      const outcome: EmptyOutcome =
        error instanceof StudioContentQualityError
          ? "quality-review-rejected"
          : "no-suitable-content";
      await namespace?.set("completed-empty-section", emptyFingerprint, outcome);
      await recordEmpty(outcome);
      continue;
    }
    const groups = [...new Map(plan.outputs.map((o) => [o.messageId, o])).values()];
    const owned = groups.filter((o) => {
      const range = studioSourceRange(o.sourceSegmentIds, input.transcript, o.format, o.sourceTrim);
      return range.startMs >= section.startMs && range.startMs < section.endMs;
    });
    const separate: typeof owned = [];
    for (const o of owned) {
      if (!studioDiscoveryOverlaps(o, [...retained, ...separate], input.transcript))
        separate.push(o);
    }
    const fingerprint = studioFingerprint({
      policy: STUDIO_DISCOVERY_POLICY,
      candidates: separate,
      retained,
      model: input.model,
      provider: input.provider,
    });
    const decisions =
      namespace?.get<Awaited<ReturnType<typeof reviewStudioDiscoveryNovelty>>>(
        "novelty",
        fingerprint,
      ) ?? (await reviewStudioDiscoveryNovelty(input, separate, retained));
    validateStudioDiscoveryDecisions(
      { decisions },
      separate.length,
      new Set(retained.map((o) => o.messageId ?? o.sourceSegmentIds.join(":"))).size,
    );
    await namespace?.set("novelty", fingerprint, decisions);
    const accepted = new Set(
      separate.filter((_o, i) => decisions[i]?.duplicateOf === null).map((o) => o.messageId),
    );
    const outputs = plan.outputs
      .filter((o) => accepted.has(o.messageId))
      .map((o) => ({ ...o, messageId: identity(o.messageId) }));
    combined.outputs.push(...outputs);
    const used = new Set(outputs.flatMap((o) => o.sourceSegmentIds));
    for (const translation of plan.translations) {
      let to = combined.translations.find((t) => t.language === translation.language);
      if (!to) {
        to = { language: translation.language, segments: [] };
        combined.translations.push(to);
      }
      for (const cue of translation.segments)
        if (used.has(cue.id) && !to.segments.some((c) => c.id === cue.id)) to.segments.push(cue);
    }
    const result = {
      ...section,
      candidates: owned.length,
      accepted: accepted.size,
      duplicates: owned.length - accepted.size,
    };
    coverage.sections.push(result);
    await namespace?.set("coverage", studioFingerprint(scoped.transcript), result);
    await checkpoints?.progress({
      phase: "drafting",
      provider: input.provider,
      completed: section.index + 1,
      total: sections.length,
      discoverySection: section.index + 1,
      discoverySections: sections.length,
    });
  }
  if (written.length) {
    const writtenPlan = await run(
      { ...input, pkg: { ...input.pkg, request: { ...input.pkg.request, channels: written } } },
      checkpoints,
      options,
    );
    combined.outputs.push(...writtenPlan.outputs);
    combined.skippedChannels.push(...writtenPlan.skippedChannels);
    combined.translations.push(...writtenPlan.translations);
  }
  for (const channel of videos)
    if (!combined.outputs.some((o) => o.channel === channel))
      combined.skippedChannels.push({
        channel,
        reason:
          "No additional distinct, complete teaching passed all reviewed sections. Existing drafts are unchanged.",
      });
  coverage.completedAt = new Date().toISOString();
  combined.discovery = coverage;
  if (!combined.outputs.length && !input.discoveryExcludedOutputs)
    throw new StudioNoSuitableContentError(combined.skippedChannels);
  validateStudioPlan(combined, input.pkg, input.transcript, true);
  return combined;
}

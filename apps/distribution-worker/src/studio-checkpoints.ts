import { createHash } from "node:crypto";
import type {
  StudioContentReview,
  StudioGenerationProgress,
  StudioPlan,
} from "@satsang/distribution-domain";
import {
  canSelectInitialStudioCandidates,
  mergeStudioContentRepair,
  reuseStudioPlanTranslations,
  selectInitialStudioCandidates,
  studioContentRepairBatches,
  studioContentReviewIssues,
  studioOutputKey,
  validateStudioContentReview,
  validateStudioPlan,
} from "@satsang/distribution-domain";
import {
  STUDIO_EDITORIAL_REVIEW_POLICY,
  StudioContentQualityError,
  reviewStudioContent,
} from "./studio-content-review.js";
import { generateStudioPlan } from "./studio-intelligence.js";
import { generateStudioSectionPlan } from "./studio-section-discovery.js";

export type StudioCheckpoints = {
  get: <T>(key: string, fingerprint: string) => T | undefined;
  set: (key: string, fingerprint: string, value: unknown) => Promise<void>;
  progress: (value: StudioGenerationProgress) => Promise<void>;
};
export class StudioNoSuitableContentError extends Error {
  constructor(readonly excludedChannels: StudioPlan["skippedChannels"]) {
    super("STUDIO_NO_SUITABLE_CHANNELS");
  }
}
/** JSONB reorders object keys; saved work must survive that round trip without repeating paid calls. */
export const studioFingerprint = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, entry: unknown) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
          : entry,
      ),
    )
    .digest("hex");

export type StudioPlanReviewOptions = {
  /** Review changes invalidate evidence, while keeping the paid draft and translation. */
  mediaReviewPolicy?: string;
  reviewMedia?: (plan: StudioPlan, checks: StudioContentReview[]) => Promise<StudioContentReview[]>;
  fallback?: { provider: "openai"; apiKey: string; model: string };
  onReview?: (
    checks: StudioContentReview[],
    evidence: {
      provider: "gemini" | "openai";
      model: string;
      audioIncluded: boolean;
      reviewedAt?: string;
    },
  ) => void;
  onProvider?: (provider: "gemini" | "openai", model: string, audioIncluded: boolean) => void;
};

/** Bounded sequential requests avoid an all-language response and bursts against the API quota. */
export async function generateCheckpointedStudioPlan(
  input: Parameters<typeof generateStudioPlan>[0],
  checkpoints?: StudioCheckpoints,
  options: StudioPlanReviewOptions = {},
): Promise<StudioPlan> {
  if (input.provider === "local") return generateStudioPlan(input);
  if (
    !input.discoverySection &&
    !input.retainedOutputs &&
    !input.contentReviewCorrection &&
    !input.pkg.outputs.length &&
    input.pkg.request.allCompleteMessages &&
    !input.pkg.source.liveWindow &&
    (input.transcript.durationMs > 300000 || input.discoveryExcludedOutputs !== undefined) &&
    input.pkg.request.channels.some((c) =>
      ["youtube", "facebook", "instagram", "tiktok"].includes(c),
    )
  )
    return generateStudioSectionPlan(input, checkpoints, options, generateCheckpointedStudioPlan);

  const mediaReviewPolicy = options.reviewMedia ? options.mediaReviewPolicy : undefined;
  const combined: StudioPlan = { outputs: [], skippedChannels: [], translations: [] };
  const candidateSelection = canSelectInitialStudioCandidates(
    input.pkg,
    input.retainedOutputs !== undefined,
  );
  const allChecks = new Map<string, StudioContentReview>();
  const completedSelections: (() => Promise<void>)[] = [];
  const { channels, languages } = input.pkg.request;
  const total = languages.length * Math.ceil(channels.length / 4);
  let completed = 0;
  let useFallback = false;
  for (const language of languages) {
    for (let index = 0; index < channels.length; index += 4) {
      const selected = channels
        .slice(index, index + 4)
        .filter((channel) => !combined.skippedChannels.some((skip) => skip.channel === channel));
      if (!selected.length) {
        completed++;
        continue;
      }
      const pkg = {
        ...input.pkg,
        // Selected-file corrections require exactly this batch's identities, not other languages.
        ...(input.retainedOutputs
          ? {
              outputs: input.pkg.outputs.filter(
                (output) => selected.includes(output.channel) && output.language === language,
              ),
            }
          : {}),
        request: { ...input.pkg.request, channels: selected, languages: [language] },
      };
      // Prior-language excerpts give each later language the same source context.
      const referenceChannels = pkg.request.allCompleteMessages
        ? [
            ...new Set([
              ...selected,
              ...combined.outputs
                .filter((o) => ["short", "reel", "video"].includes(o.format))
                .map((o) => o.channel),
            ]),
          ]
        : selected;
      const referencePlan = {
        outputs: referenceChannels.flatMap((channel) => {
          const first = combined.outputs.find((output) => output.channel === channel);
          return first
            ? combined.outputs.filter((o) => o.channel === channel && o.language === first.language)
            : [];
        }),
        translations: combined.translations.filter((value) => value.language === language),
        skippedChannels: [],
      };
      const key = `plan:${language}:${index}`;
      const fingerprint = studioFingerprint({
        editorialReview: STUDIO_EDITORIAL_REVIEW_POLICY,
        discoverySection: input.discoverySection,
        discoveryExcludedOutputs: input.discoveryExcludedOutputs,
        version: 13,
        ...(input.reviewAudio ? { audioReview: "selected-source-windows-v1" } : {}),
        mediaReview: Boolean(options.reviewMedia),
        source: pkg.source,
        request: pkg.request,
        feedback: pkg.feedback,
        drafts: pkg.outputs,
        retainedOutputs: input.retainedOutputs,
        transcript: input.transcript,
        provider: input.provider,
        model: input.model,
        fallbackModel: options.fallback?.model,
        referencePlan,
      });
      await checkpoints?.progress({
        phase: "drafting",
        provider: input.provider,
        completed,
        total,
        language,
        ...(selected[0] ? { channel: selected[0] } : {}),
      });
      type SavedPlan = {
        mediaReviewPolicy?: string;
        selectionComplete?: boolean;
        plan: StudioPlan;
        checks: StudioContentReview[];
        reviewedAt?: string;
        provider: "gemini" | "openai";
        model: string;
        audioIncluded: boolean;
      };
      let saved = checkpoints?.get<SavedPlan>(key, fingerprint);
      const previous = saved;
      if (mediaReviewPolicy && saved?.mediaReviewPolicy !== mediaReviewPolicy) {
        if (saved?.provider === "openai" && options.fallback) useFallback = true;
        saved = undefined;
      }
      // A wholly rejected prior run may retry its saved working draft, never treat it as approval.
      if (
        saved &&
        studioContentReviewIssues(saved.checks).length &&
        !(candidateSelection && saved.selectionComplete)
      )
        saved = undefined;
      if (!saved) {
        const draft = async (fallback: boolean): Promise<SavedPlan> => {
          const engine =
            fallback && options.fallback
              ? options.fallback
              : {
                  provider: input.provider as "gemini" | "openai",
                  apiKey: input.apiKey ?? "",
                  model: input.model ?? "",
                };
          await checkpoints?.progress({
            phase: "drafting",
            provider: engine.provider,
            completed,
            total,
            language,
          });
          const { originalAudio, ...base } = input;
          const audioIncluded =
            engine.provider === "gemini" && completed === 0 && Boolean(originalAudio);
          const request = {
            ...base,
            ...engine,
            pkg,
            referencePlan,
            allowAllSkipped: true,
            ...(audioIncluded && originalAudio ? { originalAudio } : {}),
          };
          // Working drafts are internal recovery data, not new curator-visible file versions.
          const workingKey = `${key}:working:${engine.provider}`;
          const workingFingerprint = studioFingerprint({
            fingerprint,
            model: engine.model,
            version: 1,
          });
          type Working = {
            plan: StudioPlan;
            checks?: StudioContentReview[];
            mediaReviewPolicy?: string;
          };
          const working =
            checkpoints?.get<Working>(workingKey, workingFingerprint) ??
            (previous?.provider === engine.provider ? previous : undefined);
          let plan =
            working?.plan ??
            reuseStudioPlanTranslations(await generateStudioPlan(request), referencePlan);
          validateStudioPlan(plan, pkg, input.transcript, true);
          let checks = working?.checks;
          if (mediaReviewPolicy && working?.mediaReviewPolicy !== mediaReviewPolicy)
            checks = undefined;
          await checkpoints?.set(workingKey, workingFingerprint, {
            plan,
            checks,
            ...(mediaReviewPolicy ? { mediaReviewPolicy } : {}),
          });
          const reviewInput = {
            ...request,
            ...(engine.provider === "gemini" && originalAudio ? { originalAudio } : {}),
          };
          for (let repair = 0; ; repair++) {
            await checkpoints?.progress({
              phase: "reviewing",
              provider: engine.provider,
              completed: 0,
              total: 1,
              language,
              ...(selected[0] ? { channel: selected[0] } : {}),
            });
            if (!checks) {
              checks = await reviewStudioContent({ ...reviewInput, plan });
              if (options.reviewMedia) checks = await options.reviewMedia(plan, checks);
            }
            checks = validateStudioContentReview({ checks }, plan);
            await checkpoints?.set(workingKey, workingFingerprint, {
              plan,
              checks,
              ...(mediaReviewPolicy ? { mediaReviewPolicy } : {}),
            });
            const issues = studioContentReviewIssues(checks);
            if (!issues.length) break;
            // Bounded repairs preserve the last draft and findings if the provider is interrupted.
            if (repair >= 3) {
              if (candidateSelection) break;
              throw new StudioContentQualityError(checks);
            }
            for (const targets of studioContentRepairBatches(plan, checks)) {
              const identities = new Set(targets.map(studioOutputKey));
              const ids = new Set(targets.flatMap((output) => output.sourceSegmentIds));
              const targetPlan = {
                ...plan,
                outputs: targets,
                skippedChannels: [],
                translations: plan.translations.map((translation) => ({
                  ...translation,
                  segments: translation.segments.filter((segment) => ids.has(segment.id)),
                })),
              };
              const repaired = await generateStudioPlan({
                ...request,
                pkg: {
                  ...pkg,
                  request: {
                    ...pkg.request,
                    channels: [...new Set(targets.map((output) => output.channel))],
                    languages: [...new Set(targets.map((output) => output.language))],
                  },
                },
                contentReviewCorrection: {
                  priorPlan: targetPlan,
                  retainedOutputs: plan.outputs.filter(
                    (output) => !identities.has(studioOutputKey(output)),
                  ),
                  issues: studioContentReviewIssues(
                    checks.filter((check) => identities.has(studioOutputKey(check))),
                  ),
                },
              });
              // Preserve contract errors and checkpoint each repaired message before the next call.
              plan = reuseStudioPlanTranslations(
                mergeStudioContentRepair(plan, repaired, targets),
                referencePlan,
              );
              validateStudioPlan(plan, pkg, input.transcript, true);
              await checkpoints?.set(workingKey, workingFingerprint, { plan });
            }
            // Recheck the actual merged captions/copy, never reuse evidence for a changed output.
            checks = undefined;
          }
          return {
            plan,
            checks,
            ...(mediaReviewPolicy ? { mediaReviewPolicy } : {}),
            reviewedAt: new Date().toISOString(),
            provider: engine.provider,
            model: engine.model ?? "",
            audioIncluded:
              engine.provider === "gemini" && Boolean(originalAudio || input.reviewAudio),
          };
        };
        try {
          saved = await draft(useFallback);
        } catch (error) {
          if (
            useFallback ||
            !options.fallback ||
            !(error instanceof Error) ||
            ![
              "STUDIO_PROVIDER_UNAVAILABLE",
              "STUDIO_PROVIDER_RATE_LIMITED",
              "STUDIO_PROVIDER_QUOTA_EXHAUSTED",
              "STUDIO_PROVIDER_TIMEOUT",
            ].includes(error.message)
          )
            throw error;
          useFallback = true;
          saved = await draft(true);
        }
        await checkpoints?.set(key, fingerprint, saved);
      }
      const plan = saved.plan;
      if (candidateSelection && checkpoints) {
        const accepted = { ...saved, selectionComplete: true };
        completedSelections.push(() => checkpoints.set(key, fingerprint, accepted));
      }
      const validatedChecks = validateStudioContentReview({ checks: saved.checks }, plan);
      if (studioContentReviewIssues(validatedChecks).length && !candidateSelection)
        throw new StudioContentQualityError(saved.checks);
      for (const check of validatedChecks) allChecks.set(studioOutputKey(check), check);
      options.onProvider?.(saved.provider, saved.model, saved.audioIncluded);
      options.onReview?.(
        validatedChecks.filter((check) => !studioContentReviewIssues([check]).length),
        saved,
      );
      validateStudioPlan(plan, pkg, input.transcript, true);
      for (const skip of plan.skippedChannels) {
        combined.skippedChannels.push(skip);
        // A channel is omitted consistently across the package, never silently missing one language.
        combined.outputs = combined.outputs.filter((output) => output.channel !== skip.channel);
      }
      combined.outputs.push(...plan.outputs);
      for (const translation of plan.translations) {
        const existing = combined.translations.find(
          (value) => value.language === translation.language,
        );
        if (!existing) combined.translations.push(translation);
        else
          for (const segment of translation.segments)
            if (!existing.segments.some((value) => value.id === segment.id))
              existing.segments.push(segment);
      }
      completed++;
      await checkpoints?.progress({
        phase: "drafting",
        provider: saved.provider,
        completed,
        total,
        language,
      });
    }
  }
  if (!combined.outputs.length) {
    if (!input.pkg.source.liveWindow)
      throw new StudioNoSuitableContentError(combined.skippedChannels);
    validateStudioPlan(combined, input.pkg, input.transcript);
    for (const complete of completedSelections) await complete();
    return combined;
  }
  const checks = combined.outputs.map((output) => {
    const check = allChecks.get(studioOutputKey(output));
    if (!check) throw Error("STUDIO_VIDEO_REVIEW_INVALID");
    return check;
  });
  const selected = candidateSelection
    ? selectInitialStudioCandidates(combined, checks, input.pkg.request)
    : combined;
  if (!selected.outputs.length && !input.pkg.source.liveWindow)
    throw new StudioContentQualityError(checks);
  validateStudioPlan(selected, input.pkg, input.transcript);
  for (const complete of completedSelections) await complete();
  return selected;
}

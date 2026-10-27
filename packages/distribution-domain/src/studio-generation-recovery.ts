import type { StudioGenerationProgress, StudioPackage } from "./intelligent-content";
import { STUDIO_BOUNDARY_EVIDENCE_POLICY } from "./studio-boundary-review";
import { STUDIO_PRESENTATION_POLICY, STUDIO_SOURCE_FRAMING_POLICY } from "./studio-presentation";

/** Bump when rendered bytes change for unchanged inputs; it invalidates saved video caches. */
export const STUDIO_RENDERER_VERSION = "full-picture-clean-hold-v1" as const;
/** Bump when the final rendered-video review changes; it invalidates saved review verdicts. */
export const STUDIO_PRESENTATION_REVIEWER_VERSION = 6 as const;

/** Identifies the Studio's own media pipeline: rendering plus the final media gate.
 * It changes only with the code above, never with a source, request or operator. */
export const STUDIO_MEDIA_PIPELINE_VERSION = [
  STUDIO_RENDERER_VERSION,
  `review-${STUDIO_PRESENTATION_REVIEWER_VERSION}`,
  STUDIO_BOUNDARY_EVIDENCE_POLICY,
  STUDIO_SOURCE_FRAMING_POLICY,
  STUDIO_PRESENTATION_POLICY,
].join("/");

const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The pipeline a running worker reports. A deployed release tag extends it so a
 * worker fix outside the media constants (for example a render timeout) also counts
 * as a change; without a tag only the media constants can change it. */
export function studioMediaPipeline(env: { STUDIO_RELEASE?: string | undefined }): string {
  const release = env.STUDIO_RELEASE?.trim();
  return release && RELEASE.test(release)
    ? `${STUDIO_MEDIA_PIPELINE_VERSION}@${release}`
    : STUDIO_MEDIA_PIPELINE_VERSION;
}

/** Failures caused by the Studio's own rendering or final media gate, not by the
 * source, the operator's settings or the operator's authority. A newer pipeline can
 * change their outcome; an unchanged one reuses the saved verdict and fails the same way. */
export const STUDIO_RECOVERABLE_GENERATION_FAILURES = [
  "STUDIO_PRESENTATION_REPAIR_REQUIRED",
  "STUDIO_PRESENTATION_BOUNDARY_REQUIRED",
  "RENDER_TIMEOUT",
  "RENDER_STALLED",
  "RENDER_PROCESS_FAILED",
  "GENERATION_FAILED",
] as const;

export function studioGenerationRecoverable(code: string | null | undefined): boolean {
  return (STUDIO_RECOVERABLE_GENERATION_FAILURES as readonly string[]).includes(code ?? "");
}

export type StudioGenerationRecoveryRecord = {
  mediaPipeline: string;
  at: string;
  outcome: "requeued" | "declined";
  code?: string;
};

/** Decide whether a failed job is retried now. At most one automatic retry per failed
 * job per media pipeline: the failing worker records its pipeline, and the recovery
 * records the pipeline it handled, so an unchanged worker never loops. */
export function studioGenerationRecovery(input: {
  failure: string | null | undefined;
  progress: Pick<StudioGenerationProgress, "mediaPipeline" | "recovery"> | null | undefined;
  currentPipeline: string;
}): "retry" | null {
  if (!studioGenerationRecoverable(input.failure)) return null;
  if (input.progress?.mediaPipeline === input.currentPipeline) return null;
  if (input.progress?.recovery?.mediaPipeline === input.currentPipeline) return null;
  return "retry";
}

/** Repeat the failed request unchanged: same mode, files and card settings. */
export function studioGenerationRecoveryRequest(pkg: StudioPackage): {
  expectedRevision: number;
  mode?: "ai" | "render" | "closing" | "discover";
  outputIds?: string[];
  steadyOpening?: true;
  closingDestinations?: Record<string, "app" | "youtube">;
  illustrationTimings?: NonNullable<StudioPackage["generation"]>["illustrationTimings"];
} {
  if (pkg.status !== "FAILED") throw Error("INVALID_STUDIO_TRANSITION");
  const generation = pkg.generation;
  if (!generation) return { expectedRevision: pkg.revision };
  if (generation.mode === "discover") return { expectedRevision: pkg.revision, mode: "discover" };
  return {
    expectedRevision: pkg.revision,
    mode: generation.mode,
    outputIds: [...generation.outputIds],
    ...(generation.steadyOpening ? { steadyOpening: true as const } : {}),
    ...(generation.closingDestinations
      ? { closingDestinations: { ...generation.closingDestinations } }
      : {}),
    ...(generation.illustrationTimings
      ? { illustrationTimings: structuredClone(generation.illustrationTimings) }
      : {}),
  };
}

/** Temporary refusals keep the job eligible; anything else is declined for this pipeline. */
export function studioGenerationRecoveryDeferred(code: string): boolean {
  return ["PLAYLIST_SETTINGS_PAUSED", "OPERATOR_AUTHORITY_UNAVAILABLE"].includes(code);
}

import { onlineVideoSource, studioNeedsSuitabilityReview } from "@satsang/distribution-domain";
import type { PublicStudioPackage } from "./studio-model";

/** A suitability result belongs to this source, never every recording sharing its title. */
export function studioSourceWithoutTeaching(value: PublicStudioPackage) {
  return (
    !value.outputs.length &&
    ((value.status === "DRAFT" && Boolean(value.provenance?.skippedChannels.length)) ||
      (value.status === "FAILED" && studioNeedsSuitabilityReview(value.failure)))
  );
}

export function studioSourceSkipReasons(value: PublicStudioPackage) {
  const reasons = value.generationProgress?.excludedChannels?.length
    ? value.generationProgress.excludedChannels
    : value.provenance?.skippedChannels;
  return [...new Set(reasons?.map((item) => item.reason.trim()).filter(Boolean) ?? [])];
}

export function studioSourceVideo(raw?: string) {
  if (!raw) return undefined;
  try {
    const source = onlineVideoSource(raw);
    return source.kind === "video" ? source : undefined;
  } catch {
    return undefined;
  }
}

import {
  type StudioGenerationPreview,
  type StudioOutput,
  type StudioPackage,
  studioOutputKey,
  validateStudioAiReviewEvidence,
  validateStudioAsset,
  validateStudioPresentationReview,
} from "@satsang/distribution-domain";

/** Preserve checked renders across retries as explicitly labelled, read-only previews.
 * They are never candidates for submission/publication. Edited/approved packages use their
 * committed outputs, and source/asset/review bindings must still match on every read. */
export function studioGenerationPreviews(
  pkg: StudioPackage,
  createdAt: string,
  entries: Record<string, { value?: unknown }> | null,
): StudioGenerationPreview[] {
  if (
    pkg.outputs.length ||
    pkg.generation ||
    pkg.approval ||
    !["QUEUED", "GENERATING", "FAILED"].includes(pkg.status)
  )
    return [];
  const since = Date.parse(createdAt);
  if (!Number.isFinite(since)) return [];
  return Object.entries(entries ?? {}).flatMap(([key, entry]) => {
    try {
      const output = entry.value as StudioOutput;
      if (
        !output ||
        key !== `output:${studioOutputKey(output)}` ||
        !output.generatedAt ||
        !Number.isFinite(Date.parse(output.generatedAt)) ||
        !["short", "reel"].includes(output.format) ||
        output.asset?.mimeType !== "video/mp4" ||
        !pkg.request.channels.includes(output.channel) ||
        !pkg.request.languages.includes(output.language) ||
        !output.aiReview ||
        !output.presentationReview ||
        output.startMs == null ||
        output.endMs == null ||
        !Array.isArray(output.captions) ||
        output.captions.length > 8
      )
        return [];
      const binding = {
        masterId: pkg.source.masterId,
        versionId: pkg.source.versionId,
        packageId: pkg.id,
        outputId: output.id,
      };
      validateStudioAsset(output.asset, binding);
      if (output.thumbnail) validateStudioAsset(output.thumbnail, binding);
      for (const caption of output.captions) validateStudioAsset(caption.asset, binding);
      validateStudioAiReviewEvidence(output.aiReview, {
        ...output,
        fileVersion: output.fileVersion ?? 1,
        sourceSha256: pkg.source.sha256,
      });
      validateStudioPresentationReview(output.presentationReview, {
        sourceSha256: pkg.source.sha256,
        renderedSha256: output.asset.sha256,
        fileVersion: output.fileVersion ?? 1,
        durationMs: output.endMs - output.startMs,
      });
      return [
        {
          id: output.id,
          title: output.title,
          channel: output.channel,
          language: output.language,
          format: output.format,
          generatedAt: output.generatedAt,
          fromPreviousRun: Date.parse(output.generatedAt) < since,
          asset: output.asset,
          captions: output.captions,
          ...(output.thumbnail ? { thumbnail: output.thumbnail } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
}

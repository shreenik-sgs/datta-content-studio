import { isDeepStrictEqual } from "node:util";
import {
  type StudioOutput,
  type StudioPackage,
  type StudioYoutubeClosing,
  replaceStudioYoutubeFooter,
  studioClosingCardPlan,
  studioOutputKey,
} from "@satsang/distribution-domain";
import { studioGenerationPreviews } from "./studio-generation-previews";

/** A card-only replacement cannot smuggle editorial changes through maintenance. */
export function validateStudioClosingReplacement(
  pkg: StudioPackage,
  prior: StudioOutput,
  next: StudioOutput,
  target: StudioYoutubeClosing,
  preserveGeneratedAt = false,
) {
  const card = prior.presentationReview?.closingCard;
  const proof = next.presentationReview?.closingRefresh;
  const envelope = {
    ...pkg,
    outputs: [],
    generation: null,
    approval: null,
    status: "GENERATING" as const,
  };
  const valid = (output: StudioOutput) =>
    studioGenerationPreviews(envelope, "1970-01-01T00:00:00Z", {
      [`output:${studioOutputKey(output)}`]: { value: output },
    }).length === 1;
  if (
    !card?.youtubeClosing ||
    !prior.asset ||
    !next.asset ||
    !proof ||
    !valid(prior) ||
    !valid(next) ||
    proof.previousSha256 !== prior.asset.sha256 ||
    proof.previousFileVersion !== (prior.fileVersion ?? 1) ||
    next.fileVersion !== (prior.fileVersion ?? 1) + 1 ||
    next.thumbnail?.sha256 !== prior.thumbnail?.sha256
  )
    throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
  const expected = {
    ...prior,
    asset: next.asset,
    ...(next.thumbnail ? { thumbnail: next.thumbnail } : {}),
    fileVersion: next.fileVersion,
    generatedAt: preserveGeneratedAt ? prior.generatedAt : next.generatedAt,
    body: replaceStudioYoutubeFooter(prior.body, card.youtubeClosing, target),
    closingDestination: "youtube",
    aiReview: { ...prior.aiReview, fileVersion: next.fileVersion },
    presentationReview: {
      ...prior.presentationReview,
      fileVersion: next.fileVersion,
      renderedSha256: next.asset.sha256,
      closingRefresh: proof,
      closingCard: studioClosingCardPlan((prior.endMs ?? 0) - (prior.startMs ?? 0), {
        destination: "youtube",
        youtubeClosing: target,
        ...(pkg.request.sourceBranding ? { sourceBranding: pkg.request.sourceBranding } : {}),
      }),
    },
  };
  if (!isDeepStrictEqual(next, expected)) throw Error("STUDIO_CLOSING_PRESERVATION_FAILED");
}

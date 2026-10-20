import type { StudioPackage } from "./intelligent-content";
import {
  type StudioYoutubeClosing,
  studioClosingDisplayName,
  studioYoutubeClosing,
} from "./studio-ending";
import { studioCanEdit } from "./studio-workflow";

/** Change only the authorized subscription metadata. The v4/v5 card pixels contain no URL. */
export function retargetStudioYoutubeClosing(
  pkg: StudioPackage,
  input: StudioYoutubeClosing,
): StudioPackage {
  if (!studioCanEdit(pkg.status, ["content.create"]) || pkg.approval)
    throw Error("INVALID_STUDIO_TRANSITION");
  const target = studioYoutubeClosing(input);
  const before = pkg.request.youtubeClosing && studioYoutubeClosing(pkg.request.youtubeClosing);
  if (
    !before ||
    target.label !== studioClosingDisplayName(pkg.request.sourceBranding) ||
    pkg.request.channels.some((channel) => channel !== "youtube")
  )
    throw Error("STUDIO_CLOSING_RETARGET_REQUIRES_RENDER");
  if (before.label === target.label && before.url === target.url) return pkg;
  const oldFooter = `Subscribe to ${before.label}: ${before.url}`;
  const newFooter = `Subscribe to ${target.label}: ${target.url}`;
  const outputs = pkg.outputs.map((output) => {
    if (output.channel !== "youtube") throw Error("STUDIO_CLOSING_RETARGET_REQUIRES_RENDER");
    const review = output.presentationReview;
    const card = review?.closingCard;
    if (
      output.asset &&
      (!card ||
        (card.policy !== "green-watch-subscribe-closing-card-v5" &&
          card.policy !== "green-subscribe-closing-card-v4") ||
        card.destination !== "youtube" ||
        card.sourceBranding !== pkg.request.sourceBranding ||
        card.youtubeClosing?.url !== before.url ||
        card.youtubeClosing?.label !== before.label ||
        card.channelUrl !== before.url)
    )
      throw Error("STUDIO_CLOSING_RETARGET_REQUIRES_RENDER");
    // Replace one whole application footer line, never arbitrary source/teaching text.
    const lines = output.body.split("\n");
    if (lines.filter((line) => line === oldFooter).length !== 1)
      throw Error("STUDIO_CLOSING_FOOTER_REVIEW_REQUIRED");
    return {
      ...output,
      body: lines.map((line) => (line === oldFooter ? newFooter : line)).join("\n"),
      ...(card && review
        ? {
            presentationReview: {
              ...review,
              closingCard: { ...card, channelUrl: target.url, youtubeClosing: target },
            },
          }
        : {}),
    };
  });
  return { ...pkg, request: { ...pkg.request, youtubeClosing: target }, outputs };
}
